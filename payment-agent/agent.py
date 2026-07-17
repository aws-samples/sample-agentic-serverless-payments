"""
x402 Payment Agent — FastAPI server for AgentCore Runtime

Compliance: settlement is stablecoin (USDC) over the x402 protocol using wallet
signatures; no payment card data is handled, so PCI-DSS does not apply to this
sample. Operators remain responsible for securing payment credentials and
transaction records (see the Security section of the README).
=========================================================
FastAPI + uvicorn server with:
  - /ping and /health for Runtime health checks
  - /invocations POST for REST text interactions (Strands Agent)
  - /ws WebSocket for bidirectional voice streaming via Strands BidiAgent + Nova Sonic

Architecture:
  - REST /invocations uses Strands Agent with AgentCoreMemorySessionManager
  - WebSocket text mode uses Strands Agent with stream_async (native async)
  - WebSocket voice mode uses Strands BidiAgent + BidiNovaSonicModel
  - Both text and voice share the same memory via AgentCoreMemorySessionManager
  - Tools: check_balance, generate_image, list_products, buy_product, cancel_order
  - Payment context threaded per-session via the WS init frame / REST body

Local dev:
  python agent.py

AgentCore Runtime:
  Container runs this as entrypoint on port 8080
"""
# ── ADOT auto-instrumentation (must run before any other imports) ──
import os
os.environ.setdefault("AGENT_OBSERVABILITY_ENABLED", "true")
os.environ.setdefault("OTEL_PYTHON_DISTRO", "aws_distro")
os.environ.setdefault("OTEL_PYTHON_CONFIGURATOR", "aws_configurator")
os.environ.setdefault("OTEL_EXPORTER_OTLP_PROTOCOL", "http/protobuf")
os.environ.setdefault("OTEL_TRACES_EXPORTER", "otlp")
os.environ.setdefault("OTEL_LOGS_EXPORTER", "otlp")
os.environ.setdefault("OTEL_METRICS_EXPORTER", "none")

try:
    from opentelemetry.instrumentation.auto_instrumentation._load import (
        _load_distro, _load_configurators, _load_instrumentors,
    )
    _distro = _load_distro()
    _distro.configure()
    _load_configurators()
    _load_instrumentors(_distro)
except Exception as _otel_err:
    # Don't crash the agent if OTEL setup fails (e.g. local dev without ADOT)
    import sys
    print(f"[WARN] ADOT auto-instrumentation skipped: {_otel_err}", file=sys.stderr)

# ── Standard imports ──
import json
import re
import base64
import logging
import asyncio
import uuid as _uuid

import boto3
import botocore.exceptions
import uvicorn
import fastapi
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from config import AWS_REGION, MEMORY_ID, VOICE_MODEL_ID
from tools import STRANDS_TOOLS, pop_last_media_result

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
logger = logging.getLogger("payment-agent")

# Text model for REST /invocations and WS text mode.
# Claude Sonnet 4.6 — strong tool-use for the storefront buying agent.
TEXT_MODEL_ID = os.environ.get("TEXT_MODEL_ID", "us.anthropic.claude-sonnet-4-6")

# Name reported on every payment span (populates the AgentCore Payments
# observability dashboard's "Agents using Payments" counter and attributes
# managers/connectors/sessions to this agent).
PAYMENTS_AGENT_NAME = os.environ.get("PAYMENTS_AGENT_NAME", "agentcore-payments-agent")

# ── AgentCore Payments observability (vended log delivery) ──
# In addition to ADOT tracing (wired at the top of this file), we route the
# PaymentManager's transaction logs into CloudWatch Logs via the vended log
# delivery pipeline. This is best-effort and idempotent per manager per process.
ENABLE_VENDED_LOG_DELIVERY = os.environ.get("ENABLE_VENDED_LOG_DELIVERY", "1").lower() in ("1", "true", "yes")
_VENDED_LOG_DELIVERY_CONFIGURED: set[str] = set()


def _ensure_vended_log_delivery(manager_arn: str, region: str) -> None:
    """Idempotently wire CloudWatch Logs vended delivery for a PaymentManager.

    Four control-plane ops, each a no-op on re-run:
      1. CreateLogGroup        — destination log group, if missing.
      2. PutDeliverySource     — Payments resource → APPLICATION_LOGS pipe.
      3. PutDeliveryDestination — target the log group.
      4. CreateDelivery        — bind source to destination.

    Authorization for the manager to vend logs is granted by the IAM actions
    bedrock-agentcore:PaymentsAllowVendedLogDeliveryForResource and
    AllowVendedLogDeliveryForResource on the agent execution role (attached in
    the CDK stack). CloudWatch checks both implicitly when put_delivery_source
    runs against a Payment Manager ARN; there is no separate "arm" API.

    Any already-exists / conflict shape is swallowed so this can run on every
    manager the agent sees without side effects.
    """
    if not ENABLE_VENDED_LOG_DELIVERY or not manager_arn:
        return
    if manager_arn in _VENDED_LOG_DELIVERY_CONFIGURED:
        return

    manager_id = manager_arn.rsplit("/", 1)[-1]
    log_group_name = f"/bedrock-agentcore/payments/{manager_id}"
    source_name = f"agentcore-payments-src-{manager_id}"
    destination_name = f"agentcore-payments-dest-{manager_id}"

    logs_client = boto3.client("logs", region_name=region)
    account_id = boto3.client("sts", region_name=region).get_caller_identity()["Account"]
    destination_arn = f"arn:aws:logs:{region}:{account_id}:delivery-destination:{destination_name}"
    log_group_arn = f"arn:aws:logs:{region}:{account_id}:log-group:{log_group_name}"

    def _swallow(code_set, fn, **kwargs):
        try:
            return fn(**kwargs)
        except botocore.exceptions.ClientError as exc:
            if exc.response["Error"].get("Code", "") in code_set:
                return None
            raise

    _swallow(
        {"ResourceAlreadyExistsException"},
        logs_client.create_log_group,
        logGroupName=log_group_name,
    )
    _swallow(
        {"ConflictException", "ResourceAlreadyExistsException"},
        logs_client.put_delivery_source,
        name=source_name,
        resourceArn=manager_arn,
        logType="APPLICATION_LOGS",
    )
    _swallow(
        {"ConflictException", "ResourceAlreadyExistsException"},
        logs_client.put_delivery_destination,
        name=destination_name,
        deliveryDestinationConfiguration={"destinationResourceArn": log_group_arn},
    )
    _swallow(
        {"ConflictException", "ResourceAlreadyExistsException"},
        logs_client.create_delivery,
        deliverySourceName=source_name,
        deliveryDestinationArn=destination_arn,
    )

    _VENDED_LOG_DELIVERY_CONFIGURED.add(manager_arn)
    logger.info("Vended log delivery ensured for Manager %s → %s", manager_id, log_group_name)


def _maybe_wire_vended_logs(manager_arn: str) -> None:
    """Best-effort trigger for vended log delivery. Observability is an add-on,
    so any failure here is logged and never blocks the request."""
    if not manager_arn:
        return
    try:
        _ensure_vended_log_delivery(manager_arn, AWS_REGION)
    except Exception as exc:  # noqa: BLE001
        logger.warning("Vended log delivery setup failed, continuing: %s", exc)

# ── Strands Agent + Memory helpers ──

def _create_text_agent(
    system_prompt: str,
    user_id: str,
    callback_handler=None,
    payment_config: dict | None = None,
):
    """Create a Strands Agent for text mode with AgentCoreMemorySessionManager
    and (optionally) the AgentCorePaymentsPlugin for automatic x402 handling.

    Returns (agent, session_manager) tuple. session_manager may be None if
    memory is not configured.

    ``payment_config`` carries the plugin inputs sourced from the WS init
    frame / REST body:
      - manager_arn, instrument_id, session_id
      - user_id (the caller's Cognito sub, used as the AgentCore userId)

    When any required field is missing, the plugin is skipped and the paid
    tools fall back to their in-process x402 path (still agentName-tagged).
    """
    from strands import Agent
    from strands.models.bedrock import BedrockModel

    model = BedrockModel(
        model_id=TEXT_MODEL_ID,
        region_name=AWS_REGION,
        temperature=0.7,
    )

    session_manager = None
    if MEMORY_ID and user_id:
        try:
            from bedrock_agentcore.memory.integrations.strands.config import AgentCoreMemoryConfig
            from bedrock_agentcore.memory.integrations.strands.session_manager import AgentCoreMemorySessionManager

            # Fresh session per connection so stale history doesn't confuse the agent
            text_session_id = f"{user_id}-text-{_uuid.uuid4().hex[:8]}"
            memory_config = AgentCoreMemoryConfig(
                memory_id=MEMORY_ID,
                session_id=text_session_id,
                actor_id=user_id,
            )
            session_manager = AgentCoreMemorySessionManager(
                agentcore_memory_config=memory_config,
                region_name=AWS_REGION,
            )
            logger.info("Text mode: AgentCoreMemorySessionManager attached (session=%s)", text_session_id)
        except Exception as e:
            logger.warning("Text memory session manager failed, continuing without: %s", e)

    # Tool list: our payment + storefront tools (check_balance, generate_image,
    # list_products, buy_product, cancel_order). The buying agent transacts via
    # the storefront's HTTP 402 flow — no browser automation needed.
    tools = list(STRANDS_TOOLS)

    # AgentCore Payments plugin — the canonical, designed payment path. It
    # transparently intercepts HTTP 402 responses, calls ProcessPayment (tagged
    # with agent_name + manager/instrument/session), settles, and retries. This
    # is what populates the Payments observability dashboard (agents / managers
    # / connectors counters). Enabled by default; set ENABLE_PAYMENTS_PLUGIN=0
    # to fall back to the in-process x402 path in the paid tools.
    plugins: list = []
    plugin_ready = False
    plugin_enabled = os.environ.get("ENABLE_PAYMENTS_PLUGIN", "1").lower() in ("1", "true", "yes")
    if payment_config and plugin_enabled:
        missing = [
            k for k in ("manager_arn", "instrument_id", "session_id", "user_id")
            if not payment_config.get(k)
        ]
        if missing:
            logger.info(
                "AgentCorePaymentsPlugin skipped — missing %s on this connection",
                missing,
            )
        else:
            try:
                from bedrock_agentcore.payments.integrations.config import AgentCorePaymentsPluginConfig
                from bedrock_agentcore.payments.integrations.strands.plugin import AgentCorePaymentsPlugin

                plugin_cfg = AgentCorePaymentsPluginConfig(
                    payment_manager_arn=payment_config["manager_arn"],
                    user_id=payment_config["user_id"],
                    payment_instrument_id=payment_config["instrument_id"],
                    payment_session_id=payment_config["session_id"],
                    region=AWS_REGION,
                    agent_name=PAYMENTS_AGENT_NAME,
                )
                plugins.append(AgentCorePaymentsPlugin(config=plugin_cfg))
                plugin_ready = True
                logger.info(
                    "AgentCorePaymentsPlugin attached — agent=%s manager=%s instrument=%s session=%s user=%s",
                    PAYMENTS_AGENT_NAME,
                    payment_config["manager_arn"],
                    payment_config["instrument_id"],
                    payment_config["session_id"],
                    payment_config["user_id"],
                )
            except Exception as e:
                logger.warning("AgentCorePaymentsPlugin init failed, continuing without: %s", e)
    elif payment_config and not plugin_enabled:
        logger.info("AgentCorePaymentsPlugin disabled (ENABLE_PAYMENTS_PLUGIN=0)")

    # When the plugin is active, the paid storefront/image tools emit a
    # PAYMENT_REQUIRED marker on a 402; the plugin intercepts it, runs the
    # tagged ProcessPayment (which populates the Payments observability
    # dashboard), and re-invokes the tool with a signed header. Tell the tools
    # the plugin is the active payer so they hand off instead of paying inline.
    from tools import set_plugin_active
    set_plugin_active(plugin_ready)

    kwargs = {
        "model": model,
        "tools": tools,
        "system_prompt": system_prompt,
    }
    if callback_handler is not None:
        kwargs["callback_handler"] = callback_handler
    if plugins:
        kwargs["plugins"] = plugins

    # Try with session manager first; if conversation state is corrupt,
    # create a fresh session (new ID) so memory still works going forward.
    if session_manager:
        try:
            agent = Agent(**kwargs, session_manager=session_manager)
            return agent, session_manager
        except Exception as e:
            logger.warning("Agent init with memory failed (%s), retrying with fresh session", e)
            try:
                session_manager.close()
            except Exception:
                pass
            # Fresh session — new random session_id so no stale state
            try:
                import uuid as _u
                fresh_sid = f"{user_id}-{_u.uuid4().hex[:8]}"
                fresh_config = AgentCoreMemoryConfig(
                    memory_id=MEMORY_ID,
                    session_id=fresh_sid,
                    actor_id=user_id,
                )
                session_manager = AgentCoreMemorySessionManager(
                    agentcore_memory_config=fresh_config,
                    region_name=AWS_REGION,
                )
                agent = Agent(**kwargs, session_manager=session_manager)
                logger.info("Agent created with fresh memory session: %s", fresh_sid)
                return agent, session_manager
            except Exception as e2:
                logger.warning("Fresh memory session also failed (%s), continuing without memory", e2)
                session_manager = None

    agent = Agent(**kwargs)
    return agent, session_manager


SYSTEM_PROMPT = """\
You are a payment assistant powered by Amazon Bedrock AgentCore Payments and \
the x402 payment protocol. You support Base Sepolia (EVM) and Solana Devnet. \
All payments use testnet USDC.

AVAILABLE TOOLS:
1. check_balance — Check your USDC balance. Free, no cost.
2. generate_image — AI image generation via Nova Canvas. Costs 0.04 USDC. The
   image is delivered to the user's screen and saved to their library. Payment
   is automatic.
3. list_products — Browse the agent storefront catalog. Free. Returns each
   product's id, name, price, stock, and description.
4. buy_product — Buy a storefront product. Payment is automatic: the storefront
   returns HTTP 402, the system settles USDC on-chain from your active session,
   and the order is confirmed and fulfilled. You do NOT assemble payments.
5. list_orders — List the buyer's own past orders (order id, item, amount,
   status, refundable). Free. Use it to find an order id to refund.
6. cancel_order — Cancel a confirmed order and refund the buyer.

PAYMENT IS AUTOMATIC:
- generate_image and buy_product are paid tools. When the seller responds with
  HTTP 402, the AgentCore Payments system pays from your active session and
  retries for you. Never set or mention payment headers. Just call the tool with
  its real arguments (prompt, productId, quantity, shippingAddress) and report
  the result.

WHEN THE USER ASKS WHAT YOU CAN DO:
Describe the capabilities above with their costs in one short sentence each. Do
NOT call any tools. Do not use headers, bold, or bullet symbols.

RULES:
- When the user asks about balance → call check_balance.
- When the user asks to generate/create/draw an image → call generate_image.
- When the user asks what's for sale or to browse → call list_products.
- When the user asks to buy/purchase a product → look it up with list_products
  if you need the product id, then call buy_product (payment is automatic).
- For a PHYSICAL product, ask the user for a shipping address before buying if
  they have not provided one (a mock address is fine for this demo), then pass
  it to buy_product.
- After a purchase, relay the delivery details to the user: for a digital file,
  confirm the purchase and tell them it is available in their Library (do NOT
  provide a download link or discuss refundability — the Library page handles
  downloading and shows the non-refundable warning there); for a license, give
  the redeem token; for a physical item, confirm the email and the shipping
  estimate.
- Do NOT surface raw blockchain data like the payment transaction hash or the
  buyer wallet address in your replies. Confirm the amount, asset, network, and
  order id; keep on-chain identifiers out of the conversation.
- When the user asks to cancel/refund an order → you need the order id. If the
  user gives it, call cancel_order with it. If they do NOT have it (for example
  in a new session), call list_orders first, find the matching order (by item
  name / amount / date), confirm it with the user, then call cancel_order with
  that order id. Do not ask the user to dig up an order id you can look up.
- NEVER guess data. Always call the tool for fresh results.
- Payment is automatic — the user already set their session budget.

MULTIPLE PURCHASES IN ONE REQUEST:
- When the user asks to buy several items at once, handle them one at a time
  with a separate buy_product call per item (the storefront charges per order).
- Gather every required input up front before buying: if any requested item is
  physical, ask once for the shipping address and reuse it for all physical
  items, so you do not stop midway to ask.
- Before starting a multi-item purchase, add up the item prices. If you know the
  session budget or balance is lower than the total, tell the user up front
  which items fit and ask whether to proceed with those, rather than failing
  partway. Use check_balance if you are unsure of the available funds.
- Buy items sequentially and report each one as it completes, so the user sees
  steady progress instead of a long silence.
- If one item fails (for example it would exceed the remaining session budget),
  do NOT abandon the rest. Continue with the others and, at the end, give a
  per-item summary: which succeeded, which failed, and the specific reason for
  each failure.

- If a tool returns an error, tell the user the SPECIFIC error (e.g. \
"Payment session expired — create a new session" or "Out of stock").
- You CANNOT create sessions, instruments, or wallets. Direct users to the \
Sessions or Instruments pages if these are missing.

OUTPUT STYLE (applies to BOTH text and voice — keep it readable when spoken aloud):
- Write in plain words and complete sentences. Be detailed but get straight to
  the point. Lead with the outcome, then the supporting details.
- Do NOT use asterisks, bold, headers, tables, or bullet symbols. No Markdown
  decoration of any kind. Use commas and short sentences instead.
- Do NOT use emojis.
- Always include money as amount plus asset plus network, e.g. "0.05 USDC on
  Base Sepolia".
- When listing the storefront catalog, open with one framing sentence naming the
  fields, for example: "Here is each product with its price, stock, and
  description." Then give each product as its own short sentence in this order:
  name, price, stock, description. Example: "API Credit Pack, 0.25 USDC on Base
  Sepolia, 1000 in stock, 10,000 metered API calls with no subscription."
  Separate products with line breaks so they stay scannable, and close by
  inviting the next action.
- When confirming a completed action, give a one-line confirmation followed by
  the key details in plain comma-separated form (amount, asset, network, ids).
- Do not narrate that you are about to call a tool; the interface already shows
  tool status. Just return the result.\
"""


# ── Payment context from request ──
#
# The DynamoDB-backed context loader was removed: the frontend threads
# everything (managerArn, instrumentId, sessionId, wallet address, network,
# connectorId) through the WS init frame and the REST body, and the plugin
# takes care of ProcessPayment routing on 402s. Anything not in the init
# payload is left empty and downstream code degrades gracefully (for example,
# tools skip manual x402 if they have no credentials, and the plugin skips
# init if required fields are missing).
#
# Identity: every payment op is scoped to the caller's Cognito sub (``userId``)
# — the same identity instruments and sessions are created under — for both
# CoinbaseCDP and StripePrivy.


def build_payment_context(
    user_id: str,
    instrument_id: str = "",
    wallet_address: str = "",
    manager_arn: str = "",
    session_id: str = "",
    network: str = "",
    connector_id: str = "",
    email: str = "",
) -> dict:
    """Assemble a payment context dict from request-supplied fields.

    ``user_id`` is the caller's Cognito sub, used as the AgentCore ``userId``
    on every payment operation (ProcessPayment, GetPaymentSession, ...).
    ``email`` is the buyer's email, used for physical-order confirmations.
    """
    return {
        "userId": user_id,
        "instrumentId": instrument_id,
        "sessionId": session_id,
        "managerArn": manager_arn,
        "connectorId": connector_id,
        "network": network or "ETHEREUM",
        "walletAddress": wallet_address,
        "email": email,
    }


def build_system_prompt(payment_context: dict | None = None) -> str:
    prompt = SYSTEM_PROMPT
    if payment_context and payment_context.get("instrumentId"):
        wallet = payment_context.get("walletAddress", "")
        session_id = payment_context.get("sessionId", "")
        network = payment_context.get("network", "ETHEREUM")
        network_label = "Solana Devnet" if network == "SOLANA" else "Base Sepolia"
        prompt += (
            f"\n\nUser's active wallet: {wallet} (network: {network_label})"
            f"\nActive session: {session_id}"
            f"\nPayment credentials are pre-loaded — check_balance, generate_image, "
            f"buy_product, and cancel_order use them automatically. Leave "
            f"wallet_address empty for check_balance."
        )
    elif payment_context:
        prompt += "\n\nNo active payment instruments or sessions found. Ask the user to create a session in the Sessions page and connect a wallet in the Instruments page."
    return prompt


# ── REST text interaction via Strands Agent ──

_THINKING_RE = re.compile(r"<thinking>.*?</thinking>\s*", re.DOTALL)

def _strip_thinking(text: str) -> str:
    """Remove <thinking>...</thinking> blocks from model output."""
    return _THINKING_RE.sub("", text).strip()


def converse_text(prompt: str, system: str, user_id: str = "", session_id: str = "",
                  payment_config: dict | None = None) -> str:
    """Text conversation using Strands Agent with AgentCoreMemorySessionManager.

    The Agent handles the full converse loop (tool calls, retries) internally.
    Memory is managed by the session manager — no manual load/save needed.
    When ``payment_config`` carries the manager/instrument/session/user, the
    AgentCorePaymentsPlugin attaches and becomes the canonical payer (tagged
    ProcessPayment on every 402), same as the WS text path.
    """
    agent, sm = _create_text_agent(
        system_prompt=system, user_id=user_id, callback_handler=None,
        payment_config=payment_config,
    )
    try:
        result = agent(prompt)
        raw = str(result)
        return _strip_thinking(raw) if raw else "I'm ready to help with payments."
    except Exception as e:
        err_str = str(e)
        # Memory loaded stale history — retry without memory
        if "must start with a user message" in err_str:
            logger.warning("Stale memory history in REST path, retrying without memory")
            try:
                from strands import Agent as _Agent
                from strands.models.bedrock import BedrockModel as _BM
                from tools import set_plugin_active as _spa
                # Fresh agent has no plugin attached — switch tools back to the
                # in-process payer so they don't emit unhandled payment markers.
                _spa(False)
                fresh_model = _BM(model_id=TEXT_MODEL_ID, region_name=AWS_REGION, temperature=0.7)
                fresh_agent = _Agent(model=fresh_model, tools=STRANDS_TOOLS, system_prompt=system)
                result = fresh_agent(prompt)
                raw = str(result)
                return _strip_thinking(raw) if raw else "I'm ready to help with payments."
            except Exception as e2:
                logger.error(f"Retry without memory also failed: {e2}", exc_info=True)
                return f"Sorry, I encountered an error: {e2}"
        logger.error(f"Strands Agent error: {e}", exc_info=True)
        return f"Sorry, I encountered an error: {e}"
    finally:
        if sm:
            try:
                sm.close()
            except Exception:
                pass


async def converse_text_streaming(prompt: str, agent, ws: WebSocket):
    """Stream a single user message via agent.stream_async() — native async, no threads.

    Uses the Strands Agent stream_async API which yields events:
      - {"data": "text chunk"}           → text being generated
      - {"current_tool_use": {...}}       → tool starting
      - {"start_event_loop": True}        → new turn after tool result
      - {"result": AgentResult}           → agent completed

    Maps these to the WS protocol the frontend expects:
      - {"type": "text_stream", "id": msg_id, "content": cumulative_text}
      - {"type": "tool_use", "name": tool_name}
      - {"type": "text_done", "id": msg_id, "content": final_text}
    """
    msg_id = f"msg-{_uuid.uuid4().hex[:8]}"
    accumulated_text = ""
    # Strands emits a `current_tool_use` event on every streamed chunk of the
    # tool-input JSON, so a single tool call surfaces dozens of identical
    # events. Track the toolUseId we've already announced and emit one
    # `tool_use` per actual invocation.
    announced_tool_ids: set[str] = set()

    async def _do_stream(a, p):
        nonlocal accumulated_text, msg_id
        async for event in a.stream_async(p):
            if "data" in event:
                accumulated_text += event["data"]
                clean = _strip_thinking(accumulated_text)
                await ws.send_text(json.dumps({
                    "type": "text_stream",
                    "id": msg_id,
                    "content": clean,
                }))
            if "current_tool_use" in event:
                tool_info = event["current_tool_use"]
                if isinstance(tool_info, dict):
                    tool_name = tool_info.get("name", "")
                    tool_id = tool_info.get("toolUseId") or tool_info.get("name", "")
                else:
                    tool_name = ""
                    tool_id = ""
                if tool_name and tool_id not in announced_tool_ids:
                    announced_tool_ids.add(tool_id)
                    logger.info(f"Text streaming tool use: {tool_name} ({tool_id})")
                    await ws.send_text(json.dumps({
                        "type": "tool_use",
                        "name": tool_name,
                    }))
            if event.get("start_event_loop"):
                msg_id = f"msg-{_uuid.uuid4().hex[:8]}"

    try:
        await _do_stream(agent, prompt)

        final_text = _strip_thinking(accumulated_text) if accumulated_text else "I'm ready to help with payments."
        await ws.send_text(json.dumps({
            "type": "text_done",
            "id": msg_id,
            "content": final_text,
        }))

        # Send media event if a seller tool produced a presigned URL
        media = pop_last_media_result()
        if media:
            logger.info("Sending media event: type=%s url=%s", media["mediaType"], media["url"][:80])
            await ws.send_text(json.dumps({"type": "media", **media}))
    except Exception as e:
        err_str = str(e)
        # Memory loaded stale history — retry without memory
        if "must start with a user message" in err_str:
            logger.warning("Stale memory history detected, retrying without memory")
            try:
                from strands import Agent as _Agent
                from strands.models.bedrock import BedrockModel as _BM
                from tools import set_plugin_active as _spa
                # Fresh agent has no plugin — switch tools to the in-process payer.
                _spa(False)
                fresh_model = _BM(model_id=TEXT_MODEL_ID, region_name=AWS_REGION, temperature=0.7)
                fresh_agent = _Agent(model=fresh_model, tools=STRANDS_TOOLS, system_prompt=agent.system_prompt)
                accumulated_text = ""
                msg_id = f"msg-{_uuid.uuid4().hex[:8]}"
                await _do_stream(fresh_agent, prompt)
                final_text = _strip_thinking(accumulated_text) if accumulated_text else "I'm ready to help with payments."
                await ws.send_text(json.dumps({
                    "type": "text_done",
                    "id": msg_id,
                    "content": final_text,
                }))
                return
            except Exception as e2:
                logger.error(f"Retry without memory also failed: {e2}", exc_info=True)
                err_str = str(e2)

        logger.error(f"Strands Agent streaming error: {err_str}", exc_info=True)
        fallback = f"Sorry, I encountered an error: {err_str}"
        try:
            await ws.send_text(json.dumps({
                "type": "text_done",
                "id": msg_id or "msg-err",
                "content": fallback,
            }))
        except Exception:
            pass


# ── FastAPI App ──

app = FastAPI(title="x402 Payment Agent", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/ping")
async def ping():
    return JSONResponse(content={"status": "ok"}, status_code=200)


@app.get("/health")
async def health():
    return JSONResponse(content={"status": "healthy"}, status_code=200)


@app.post("/invocations")
async def invocations(request: fastapi.Request):
    """REST text interaction endpoint using Strands Agent.

    Accepts flexible body formats since AgentCore Runtime may forward
    the payload in different ways.
    """
    try:
        raw = await request.body()
        body_str = raw.decode("utf-8", errors="replace")
        # Log only the size, not the body: it carries the user prompt, email,
        # and wallet identifiers. Use a debug log with explicit fields if a
        # preview is needed during local development.
        logger.info(f"Invocation body received ({len(raw)} bytes)")

        try:
            data = json.loads(body_str)
        except json.JSONDecodeError:
            data = {"prompt": body_str}

        prompt = (
            data.get("prompt")
            or data.get("text")
            or data.get("message")
            or data.get("input")
            or body_str
            or "Hello! How can I help you with payments today?"
        )
        user_id = data.get("userId", data.get("user_id", ""))
        instrument_id = data.get("instrumentId", data.get("instrument_id", ""))
        # The REST path mirrors the WS init frame — frontend passes the full
        # payment context so the agent doesn't have to hit any database.
        manager_arn = data.get("managerArn", data.get("manager_arn", ""))
        session_id = data.get("sessionId", data.get("session_id", ""))
        wallet_address = data.get("walletAddress", data.get("wallet_address", ""))
        network = data.get("network", "")
        connector_id = data.get("connectorId", data.get("connector_id", ""))
        email = data.get("email", data.get("userEmail", ""))
    except Exception as e:
        logger.error(f"Failed to parse request body: {e}")
        prompt = "Hello! How can I help you with payments today?"
        user_id = ""
        instrument_id = ""
        manager_arn = ""
        session_id = ""
        wallet_address = ""
        network = ""
        connector_id = ""
        email = ""

    payment_context = build_payment_context(
        user_id=user_id,
        instrument_id=instrument_id,
        wallet_address=wallet_address,
        manager_arn=manager_arn,
        session_id=session_id,
        network=network,
        connector_id=connector_id,
        email=email,
    )
    system = build_system_prompt(payment_context)

    # Pre-set payment credentials for tools. Every payment op is scoped to the
    # caller's Cognito sub (``userId``) for both CoinbaseCDP and StripePrivy.
    if payment_context.get("instrumentId"):
        from tools import set_payment_credentials
        set_payment_credentials(
            payment_manager_arn=payment_context.get("managerArn", ""),
            instrument_id=payment_context.get("instrumentId", ""),
            session_id=payment_context.get("sessionId", ""),
            user_id=payment_context.get("userId", ""),
            wallet_address=payment_context.get("walletAddress", ""),
            network=payment_context.get("network", "ETHEREUM"),
            connector_id=payment_context.get("connectorId", ""),
            email=payment_context.get("email", ""),
        )
        # Observability: wire the manager's vended log delivery (best-effort).
        _maybe_wire_vended_logs(payment_context.get("managerArn", ""))

    # Plugin inputs for the REST path — same shape as the WS init frame.
    rest_plugin_config = {
        "manager_arn": payment_context.get("managerArn", ""),
        "instrument_id": payment_context.get("instrumentId", ""),
        "session_id": payment_context.get("sessionId", ""),
        "user_id": payment_context.get("userId", ""),
    }

    try:
        response_text = await asyncio.get_event_loop().run_in_executor(
            None, lambda: converse_text(
                prompt, system, user_id=user_id, session_id=user_id,
                payment_config=rest_plugin_config,
            ),
        )
        return JSONResponse(content={"response": response_text})
    except Exception as e:
        logger.error(f"Invocation error: {e}")
        return JSONResponse(content={"error": str(e)}, status_code=500)


# ── WebSocket endpoint for voice + text streaming ──

@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    """WebSocket endpoint supporting two modes:

      - Text mode: client sends JSON {"type":"text","content":"..."}, server
        streams back via Strands Agent stream_async.
      - Voice mode: client sends binary PCM audio after init, server streams
        back audio via Nova Sonic S2S.

    Client protocol:
      1. Connect → server accepts
      2. Send init JSON: {"type":"init","userId":"...","mode":"voice"|"text"}
      3a. Voice mode: send binary PCM audio chunks (16kHz mono 16-bit)
      3b. Text mode: send {"type":"text","content":"..."}
    """
    await ws.accept()
    logger.info("WebSocket connected")

    # Wait for init message
    user_id = ""
    mode = "text"
    instrument_override = ""
    wallet_override = ""
    manager_arn_override = ""
    session_id_override = ""
    connector_id_override = ""
    network_override = ""
    email_override = ""
    try:
        init_msg = await asyncio.wait_for(ws.receive_text(), timeout=10.0)
        init_data = json.loads(init_msg)
        user_id = init_data.get("userId", "")
        mode = init_data.get("mode", "text")
        instrument_override = init_data.get("instrumentId", "")
        wallet_override = init_data.get("walletAddress", "")
        # Fields the frontend sends on connect so the agent has the full
        # payment context without hitting any database.
        #
        #   managerArn       — arn:aws:bedrock-agentcore:…:payment-manager/…
        #   sessionId        — latest active session for that manager
        #   connectorId      — connector used by the selected instrument
        #   network          — ETHEREUM | SOLANA, used by check_balance
        #
        # Payments are scoped to ``userId`` (the caller's Cognito sub) for
        # both CoinbaseCDP and StripePrivy.
        manager_arn_override = init_data.get("managerArn", "")
        session_id_override = init_data.get("sessionId", "")
        connector_id_override = init_data.get("connectorId", "")
        network_override = init_data.get("network", "")
        email_override = init_data.get("email", init_data.get("userEmail", ""))
        # Mask the wallet address in logs: keep only a recognizable prefix and
        # suffix (e.g. 0x1234...5678). The address is public, but this avoids
        # correlating the user identity with a full on-chain address in logs.
        wallet_masked = (
            f"{wallet_override[:6]}...{wallet_override[-4:]}"
            if wallet_override and len(wallet_override) > 12
            else (wallet_override or "(none)")
        )
        logger.info(
            "Session init — user: %s, mode: %s, instrument: %s, wallet: %s, "
            "manager: %s, connector: %s, session: %s, network: %s",
            user_id, mode, instrument_override or "default", wallet_masked,
            manager_arn_override or "(none)", connector_id_override or "(none)",
            session_id_override or "(none)", network_override or "(none)",
        )
    except Exception as e:
        logger.warning(f"Init message error: {e}")

    payment_context = build_payment_context(
        user_id=user_id,
        instrument_id=instrument_override,
        wallet_address=wallet_override,
        manager_arn=manager_arn_override,
        session_id=session_id_override,
        network=network_override,
        connector_id=connector_id_override,
        email=email_override,
    )
    system = build_system_prompt(payment_context)

    # Pre-set payment credentials so tools (check_balance, etc.) can access
    # wallet info. Every payment op is scoped to the caller's Cognito sub.
    if payment_context.get("instrumentId"):
        from tools import set_payment_credentials
        set_payment_credentials(
            payment_manager_arn=payment_context.get("managerArn", ""),
            instrument_id=payment_context.get("instrumentId", ""),
            session_id=payment_context.get("sessionId", ""),
            user_id=payment_context.get("userId", ""),
            wallet_address=payment_context.get("walletAddress", ""),
            network=payment_context.get("network", "ETHEREUM"),
            connector_id=payment_context.get("connectorId", ""),
            email=payment_context.get("email", ""),
        )
        # Observability: wire the manager's vended log delivery (best-effort).
        _maybe_wire_vended_logs(payment_context.get("managerArn", ""))

    # ── TEXT MODE ──
    if mode == "text":
        logger.info("WS entering text mode (Strands Agent stream_async)")
        await ws.send_text(json.dumps({"type": "status", "status": "ready"}))

        # All plugin inputs come straight from the WS init frame — the
        # frontend has the full context (manager, instrument, session) in
        # state at connect time. user_id is the Cognito sub.
        plugin_payment_config = {
            "manager_arn": manager_arn_override,
            "instrument_id": instrument_override,
            "session_id": session_id_override,
            "user_id": user_id,
        }

        agent = None
        sm = None
        loop = asyncio.get_event_loop()

        async def _init_agent():
            """Create Agent in background while sending keepalives."""
            init_task = loop.run_in_executor(
                None,
                lambda: _create_text_agent(
                    system_prompt=system,
                    user_id=user_id,
                    callback_handler=None,
                    payment_config=plugin_payment_config,
                ),
            )
            # Send keepalive pings every 2s while Agent initializes
            while not init_task.done():
                try:
                    await ws.send_text(json.dumps({"type": "status", "status": "thinking"}))
                except Exception:
                    break
                await asyncio.sleep(2)
            return await init_task

        try:
            while True:
                message = await ws.receive()
                if message.get("type") == "websocket.disconnect":
                    break
                if "text" in message and message["text"]:
                    parsed = None
                    try:
                        parsed = json.loads(message["text"])
                    except (json.JSONDecodeError, AttributeError):
                        parsed = None

                    # Mid-connection context update — frontend sends this
                    # when the user creates / revokes / switches session or
                    # instrument after the WS is already open. We re-bind
                    # the tools' payment credentials so paid tools pick up
                    # the new session without needing a reconnect.
                    if parsed and parsed.get("type") == "context_update":
                        from tools import set_payment_credentials
                        new_manager = parsed.get("managerArn", manager_arn_override)
                        new_instrument = parsed.get("instrumentId", instrument_override)
                        new_session = parsed.get("sessionId", "")
                        new_connector = parsed.get("connectorId", connector_id_override)
                        new_network = parsed.get("network", network_override or "ETHEREUM")
                        new_wallet = parsed.get("walletAddress", wallet_override)
                        set_payment_credentials(
                            payment_manager_arn=new_manager,
                            instrument_id=new_instrument,
                            session_id=new_session,
                            user_id=user_id,
                            wallet_address=new_wallet,
                            network=new_network,
                            connector_id=new_connector,
                        )
                        # Track the latest values in case we re-bind again later.
                        manager_arn_override = new_manager
                        instrument_override = new_instrument
                        session_id_override = new_session
                        connector_id_override = new_connector
                        network_override = new_network
                        wallet_override = new_wallet
                        logger.info(
                            "Context update — instrument=%s session=%s manager=%s",
                            new_instrument, new_session or "(none)", new_manager,
                        )
                        await ws.send_text(json.dumps({
                            "type": "context_ack",
                            "sessionId": new_session,
                            "instrumentId": new_instrument,
                        }))
                        continue

                    content = parsed.get("content", "") if parsed and parsed.get("type") == "text" else message["text"]
                    if content:
                        if agent is None:
                            logger.info("Lazy-init: creating text Agent...")
                            await ws.send_text(json.dumps({"type": "status", "status": "thinking"}))
                            try:
                                agent, sm = await _init_agent()
                                logger.info("Lazy-init: Agent created")
                            except Exception as e:
                                logger.error(f"Agent init failed: {e}", exc_info=True)
                                await ws.send_text(json.dumps({
                                    "type": "text_done",
                                    "id": "error",
                                    "content": f"Agent initialization failed: {e}",
                                }))
                                continue
                        try:
                            await converse_text_streaming(content, agent, ws)
                        except Exception as e:
                            logger.error(f"WS text stream error: {e}", exc_info=True)
                            await ws.send_text(json.dumps({
                                "type": "text_done",
                                "id": "error",
                                "content": f"Error: {e}",
                            }))
        except WebSocketDisconnect:
            logger.info("WS text client disconnected")
        except Exception as e:
            logger.warning(f"WS text loop error: {e}")
        finally:
            if sm:
                try:
                    sm.close()
                except Exception:
                    pass
            try:
                await ws.close()
            except Exception:
                pass
            logger.info("WS text session ended")
        return

    # ── VOICE MODE (BidiAgent + Nova Sonic) ──
    logger.info("WS entering voice mode (BidiAgent)")

    # The AgentCorePaymentsPlugin attaches only to the text-mode Strands Agent;
    # BidiAgent does not carry it. Tell the tools to use their in-process x402
    # fallback (still tagged with agentName) so paid tools work in voice. This
    # also resets the shared flag if a text connection set it earlier.
    from tools import set_plugin_active as _set_plugin_active_voice
    _set_plugin_active_voice(False)

    try:
        from strands.experimental.bidi import BidiAgent
        from strands.experimental.bidi.models import BidiNovaSonicModel
        from strands.experimental.bidi.types.events import (
            BidiAudioStreamEvent,
            BidiTranscriptStreamEvent,
            BidiConnectionStartEvent,
            BidiConnectionCloseEvent,
            BidiConnectionRestartEvent,
            BidiResponseStartEvent,
            BidiResponseCompleteEvent,
            BidiInterruptionEvent,
            BidiUsageEvent,
            BidiErrorEvent,
            BidiAudioInputEvent,
        )
    except ImportError as e:
        logger.error(f"BidiAgent not available: {e}")
        await ws.send_text(json.dumps({"type": "error", "content": "Voice mode not available — strands-agents[bidi] not installed."}))
        await ws.close()
        return

    voice_id = os.environ.get("VOICE_ID", "tiffany")

    model = BidiNovaSonicModel(
        model_id=VOICE_MODEL_ID,
        client_config={"region": AWS_REGION},
        provider_config={"audio": {"voice": voice_id}},
    )

    voice_system = system + (
        "\n\nIMPORTANT: You are speaking out loud in a voice conversation. "
        "Keep your responses short, warm, and conversational — like talking to a friend. "
        "Avoid numbered lists, bullet points, or long explanations. "
        "Use natural speech patterns with contractions (I'm, you'll, let's). "
        "One or two sentences per response is ideal unless the user asks for detail."
    )
    agent = BidiAgent(model=model, tools=STRANDS_TOOLS, system_prompt=voice_system)

    # Wire AgentCore Memory for voice mode
    voice_session_manager = None
    if MEMORY_ID and user_id:
        try:
            from bedrock_agentcore.memory.integrations.strands.config import AgentCoreMemoryConfig
            from bedrock_agentcore.memory.integrations.strands.session_manager import AgentCoreMemorySessionManager

            # Fresh session per connection so stale history doesn't confuse the agent
            voice_session_id = f"{user_id}-voice-{_uuid.uuid4().hex[:8]}"
            voice_memory_config = AgentCoreMemoryConfig(
                memory_id=MEMORY_ID,
                session_id=voice_session_id,
                actor_id=user_id,
            )
            voice_session_manager = AgentCoreMemorySessionManager(
                agentcore_memory_config=voice_memory_config,
                region_name=AWS_REGION,
            )
            agent = BidiAgent(
                model=model, tools=STRANDS_TOOLS, system_prompt=voice_system,
                session_manager=voice_session_manager,
            )
            logger.info("Voice mode: AgentCoreMemorySessionManager attached")
        except Exception as e:
            logger.warning("Voice memory session manager failed, continuing without: %s", e)

    async def _ws_send_json(data: dict):
        try:
            await ws.send_text(json.dumps(data))
        except Exception:
            pass

    async def receive_loop():
        try:
            while True:
                message = await ws.receive()
                msg_type = message.get("type", "")

                if msg_type == "websocket.disconnect":
                    break

                if "bytes" in message and message["bytes"]:
                    pcm_bytes = message["bytes"]
                    audio_b64 = base64.b64encode(pcm_bytes).decode("ascii")
                    await agent.send(BidiAudioInputEvent(
                        audio=audio_b64, format="pcm",
                        sample_rate=16000, channels=1,
                    ))

                elif "text" in message and message["text"]:
                    try:
                        data = json.loads(message["text"])
                        # Mid-connection context update — same frame the text
                        # mode handles. The frontend sends it when the user
                        # creates / switches a session or instrument after the
                        # WS is open. Voice needs this too, otherwise paid tools
                        # (buy_product, generate_image) see no active session.
                        if data.get("type") == "context_update":
                            from tools import set_payment_credentials
                            set_payment_credentials(
                                payment_manager_arn=data.get("managerArn", manager_arn_override),
                                instrument_id=data.get("instrumentId", instrument_override),
                                session_id=data.get("sessionId", ""),
                                user_id=user_id,
                                wallet_address=data.get("walletAddress", wallet_override),
                                network=data.get("network", network_override or "ETHEREUM"),
                                connector_id=data.get("connectorId", connector_id_override),
                                email=email_override,
                            )
                            logger.info(
                                "Voice context update — instrument=%s session=%s",
                                data.get("instrumentId", "(none)"),
                                data.get("sessionId", "(none)"),
                            )
                            await _ws_send_json({"type": "context_ack"})
                        elif data.get("type") == "text":
                            await agent.send(data.get("content", ""))
                    except json.JSONDecodeError:
                        await agent.send(message["text"])
        except WebSocketDisconnect:
            logger.info("Voice client disconnected")
        except Exception as e:
            logger.warning(f"Voice receive loop error: {e}")

    async def output_loop():
        try:
            async for event in agent.receive():
                etype = type(event).__name__

                if isinstance(event, BidiAudioStreamEvent):
                    try:
                        audio_bytes = base64.b64decode(event.audio)
                        await ws.send_bytes(audio_bytes)
                    except Exception:
                        pass

                elif isinstance(event, BidiTranscriptStreamEvent):
                    await _ws_send_json({
                        "type": "text",
                        "content": event.text,
                        "role": event.role,
                        "is_final": event.is_final,
                    })
                    # After the agent's final confirmed transcript, check for media
                    # (BidiResponseCompleteEvent doesn't fire reliably in voice mode)
                    if event.is_final and event.role and event.role.upper() != "USER":
                        media = pop_last_media_result()
                        if media:
                            logger.info("Voice transcript final: sending media event: type=%s", media["mediaType"])
                            await _ws_send_json({"type": "media", **media})

                elif isinstance(event, dict) and event.get("type") == "tool_use_stream":
                    tool_info = event.get("current_tool_use", {})
                    tool_name = tool_info.get("name", "unknown") if tool_info else "unknown"
                    logger.info(f"Voice tool use: {tool_name}")
                    await _ws_send_json({"type": "tool_use", "name": tool_name})
                    # Check for media right after tool execution
                    media = pop_last_media_result()
                    if media:
                        logger.info("Voice tool_use: sending media event: type=%s url=%s", media["mediaType"], media["url"][:80])
                        await _ws_send_json({"type": "media", **media})

                elif isinstance(event, BidiConnectionStartEvent):
                    logger.info(f"BidiAgent connected: {event.connection_id}")
                    await _ws_send_json({"type": "status", "status": "ready"})

                elif isinstance(event, BidiConnectionRestartEvent):
                    logger.info(f"BidiAgent connection restarting (timeout)")
                    # Flush any pending media before restart
                    media = pop_last_media_result()
                    if media:
                        logger.info("Voice restart: flushing media event: type=%s", media["mediaType"])
                        await _ws_send_json({"type": "media", **media})
                    await _ws_send_json({"type": "status", "status": "reconnecting"})

                elif isinstance(event, BidiResponseStartEvent):
                    logger.debug(f"Response start: {event.response_id}")

                elif isinstance(event, BidiResponseCompleteEvent):
                    logger.info(f"Response complete: {event.response_id} reason={event.stop_reason}")
                    await _ws_send_json({"type": "response_done"})

                    if event.stop_reason == "tool_use":
                        await _ws_send_json({"type": "status", "status": "tool_executing"})
                    else:
                        # Check for media after the agent's final response (not during tool_use,
                        # since the tool hasn't executed yet at that point).
                        media = pop_last_media_result()
                        if media:
                            logger.info("Voice: sending media event: type=%s url=%s", media["mediaType"], media["url"][:80])
                            await _ws_send_json({"type": "media", **media})

                elif isinstance(event, BidiInterruptionEvent):
                    logger.info(f"Interruption: {event.reason}")

                elif isinstance(event, BidiUsageEvent):
                    logger.info(f"Usage: in={event.input_tokens} out={event.output_tokens} total={event.total_tokens}")

                elif isinstance(event, BidiConnectionCloseEvent):
                    logger.info(f"BidiAgent connection closed: {event.reason}")
                    break

                elif isinstance(event, BidiErrorEvent):
                    logger.error(f"BidiAgent error: {event.message}")
                    await _ws_send_json({"type": "error", "content": event.message})

                else:
                    logger.info(f"Unhandled bidi event: {etype}")

        except Exception as e:
            logger.error(f"Voice output loop error: {e}", exc_info=True)
            await _ws_send_json({"type": "error", "content": f"Voice stream error: {e}"})

    try:
        await agent.start()

        receive_task = asyncio.create_task(receive_loop())
        output_task = asyncio.create_task(output_loop())

        done, pending = await asyncio.wait(
            [receive_task, output_task],
            return_when=asyncio.FIRST_COMPLETED,
        )
        for task in pending:
            task.cancel()

    except Exception as e:
        logger.error(f"Voice session error: {e}", exc_info=True)
        try:
            await ws.send_text(json.dumps({"type": "error", "content": f"Voice session error: {e}"}))
        except Exception:
            pass
    finally:
        await agent.stop()
        if voice_session_manager:
            try:
                voice_session_manager.close()
            except Exception:
                pass
        try:
            await ws.close()
        except Exception:
            pass
        logger.info("Voice session ended")


if __name__ == "__main__":
    # Load .env for local development
    try:
        from dotenv import load_dotenv
        load_dotenv()
    except ImportError:
        pass
    port = int(os.environ.get("PORT", "8080"))
    logger.info(f"Starting payment agent on port {port}")
    # Bind all interfaces: this process runs inside the AgentCore Runtime
    # container, which reaches the agent over the container network. Binding to
    # 127.0.0.1 would make the runtime unable to reach it. nosec B104.
    uvicorn.run(app, host="0.0.0.0", port=port, log_level="info")  # nosec B104
