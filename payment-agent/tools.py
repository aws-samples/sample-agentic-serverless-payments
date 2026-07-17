"""
Payment Agent Tools — x402 via AgentCore Payments
--------------------------------------------------
Tools for the x402 payment agent. Works for both Coinbase CDP and
Stripe/Privy credential providers — the service picks the right signer
based on the connector tied to the instrument.

Compliance: this code handles payment data (USDC transactions, payment
instruments, public wallet addresses). It is a testnet demo and processes no
payment card data, so PCI-DSS does not apply to this sample. Production
deployments handling payment data must implement the applicable PCI-DSS and
data-protection controls; see the README Security section and the AWS shared
responsibility model.

Tool surface:
  - check_balance     — free; GetPaymentInstrumentBalance
  - generate_image    — 0.04 USDC; x402-gated Nova Canvas seller
  - list_products     — free; browse the agent storefront catalog
  - buy_product       — buy a storefront product via the x402 HTTP 402 flow
  - cancel_order      — refund a confirmed order (seller-originated reverse payment)

PAYMENT PATH (canonical): the AgentCorePaymentsPlugin. When it is attached
(text + REST modes), the paid tools (generate_image, buy_product) make their
first call, and on an HTTP 402 they return a ``PAYMENT_REQUIRED`` marker. The
plugin intercepts it, runs the tagged ProcessPayment (which populates the
AgentCore Payments observability dashboard), and re-invokes the tool with a
signed ``PAYMENT-SIGNATURE`` header. The tool forwards that header to the seller
and returns the fulfilled result.

FALLBACK: voice mode (BidiAgent) does not carry the plugin, so the paid tools
fall back to the in-process x402 dance in ``_pay_and_retry`` (402 →
ProcessPayment → retry with X-PAYMENT). That fallback also tags ProcessPayment
with agentName, so observability still attributes the payment to this agent.
"""
import base64 as _b64
import json
import os
import uuid as _uuid
import logging
import time as _time
from typing import Any

import boto3
import requests as _requests
from strands import tool

from config import AWS_REGION, DP_ENDPOINT, SELLER_API_URL, MEDIA_BUCKET, STOREFRONT_API_URL, LIBRARY_BUCKET

_logger = logging.getLogger("payment-agent.tools")


# ─────────────────────────────────────────────
# AgentCore ProcessPayment SDK
# ─────────────────────────────────────────────

def _get_dp_client():
    """Return a boto3 bedrock-agentcore data-plane client.

    The bedrock-agentcore data-plane operations (ProcessPayment,
    GetPaymentSession, etc.) ship in the standard boto3/botocore
    distribution. boto3 derives the endpoint from the region; set
    DP_ENDPOINT only to override it.
    """
    session = boto3.Session(region_name=AWS_REGION)
    client_kwargs = {"region_name": AWS_REGION}
    if DP_ENDPOINT:
        client_kwargs["endpoint_url"] = DP_ENDPOINT
    return session.client("bedrock-agentcore", **client_kwargs)


def _process_payment(
    payment_manager_arn: str,
    instrument_id: str,
    session_id: str,
    x402_payload: dict,
    user_id: str = "",
) -> dict:
    """Call ProcessPayment via boto3. Returns the signed CryptoX402PaymentOutput.

    Raises if the service doesn't return PROOF_GENERATED / SUCCEEDED.
    """
    # Strip descriptive fields that aren't part of the wire payload
    payload = dict(x402_payload)
    for key in ("description", "mimeType", "resource", "outputSchema"):
        payload.pop(key, None)

    client = _get_dp_client()
    kwargs = {
        "paymentManagerArn": payment_manager_arn,
        "paymentSessionId": session_id,
        "paymentInstrumentId": instrument_id,
        "paymentType": "CRYPTO_X402",
        "paymentInput": {
            "cryptoX402": {
                "version": str(payload.get("x402Version", "2")),
                "payload": payload,
            }
        },
        "clientToken": str(_uuid.uuid4()),
    }
    if user_id:
        kwargs["userId"] = user_id
    # Attribute the payment in AgentCore Payments observability. The plugin is
    # the primary path; this manual fallback still tags its ProcessPayment.
    _agent_name = os.environ.get("PAYMENTS_AGENT_NAME", "agentcore-payments-agent")
    if _agent_name:
        kwargs["agentName"] = _agent_name

    response = client.process_payment(**kwargs)
    response.pop("ResponseMetadata", None)

    status = response.get("status", "UNKNOWN")
    _logger.info("ProcessPayment status=%s", status)

    if status not in ("PROOF_GENERATED", "SUCCEEDED"):
        raise RuntimeError(f"ProcessPayment failed: {status}")

    return response


# ─────────────────────────────────────────────
# Payment credential state
# ─────────────────────────────────────────────

_payment_creds: dict[str, str] = {}

# Whether the AgentCorePaymentsPlugin is attached to the active agent. The
# plugin is the canonical, designed payment path: the paid tools emit a
# PAYMENT_REQUIRED marker on a 402, the plugin runs the tagged ProcessPayment
# (populating the Payments observability dashboard) and re-invokes the tool
# with the signed header. agent.py flips this per connection. When it's False
# (e.g. the voice/BidiAgent path, which does not carry plugin hooks), the paid
# tools fall back to the in-process x402 dance in ``_pay_and_retry`` so payments
# still work — that fallback also tags ProcessPayment with agentName.
_PLUGIN_ACTIVE = False


def set_plugin_active(active: bool) -> None:
    """Tell the tools whether the AgentCorePaymentsPlugin will handle 402s.

    Called by agent.py once the agent (and its plugin, if any) is built.
    """
    global _PLUGIN_ACTIVE
    _PLUGIN_ACTIVE = bool(active)


def _has_payment_header(headers: dict | None) -> bool:
    """True if the plugin has already injected a signed payment header."""
    if not headers:
        return False
    return any(str(k).upper() in ("PAYMENT-SIGNATURE", "X-PAYMENT") for k in headers)


def _payment_required_marker(requirements: dict, raw_header: str = "") -> str:
    """Build the PAYMENT_REQUIRED marker the AgentCorePaymentsPlugin intercepts.

    The plugin's GenericPaymentHandler scans a tool's text result for the
    ``PAYMENT_REQUIRED: `` prefix, reads ``statusCode`` / ``headers`` / ``body``,
    runs ProcessPayment (tagged with the agent name), then re-invokes the tool
    with a ``PAYMENT-SIGNATURE`` header injected into ``headers``.

    PaymentManager extracts the x402 requirements two ways:
      - v2: a base64 ``payment-required`` header, or
      - v1: the body as a dict carrying ``x402Version`` + ``accepts``.
    We prefer the raw base64 header when the seller sent one; otherwise we put
    the decoded requirements in the body and guarantee an ``x402Version`` so the
    manager's validation passes regardless of seller framing.
    """
    headers: dict = {}
    body: dict = dict(requirements or {})
    if raw_header:
        headers["payment-required"] = raw_header
    if "x402Version" not in body:
        body["x402Version"] = 2
    return "PAYMENT_REQUIRED: " + json.dumps({
        "statusCode": 402,
        "headers": headers,
        "body": body,
    })


def set_payment_credentials(
    payment_manager_arn: str,
    instrument_id: str,
    session_id: str,
    user_id: str = "",
    wallet_address: str = "",
    network: str = "ETHEREUM",
    connector_id: str = "",
    email: str = "",
) -> None:
    """Set payment credentials. Called by agent.py before each tool invocation."""
    _payment_creds.clear()
    _payment_creds.update({
        "payment_manager_arn": payment_manager_arn,
        "instrument_id": instrument_id,
        "session_id": session_id,
        "user_id": user_id,
        "wallet_address": wallet_address,
        "network": network,
        "connector_id": connector_id,
        "email": email,
    })


# ─────────────────────────────────────────────
# x402 flow — direct ProcessPayment, no scheme adapter
# ─────────────────────────────────────────────

def _pick_accept(accepts: list[dict], preferred_network: str) -> dict | None:
    """Pick the best accept option for the user's network.

    x402 sellers often advertise both EVM + Solana options. Match the user's
    instrument network so AgentCore's signer picks the right chain.
    Accepts any casing on ``preferred_network`` and matches network strings
    like ``solana:...``, ``solana-devnet``, ``eip155:84532``, ``base-sepolia``.
    """
    if not accepts:
        return None
    pref = (preferred_network or "").upper()
    is_solana = pref == "SOLANA"

    for a in accepts:
        net = (a.get("network") or "").lower()
        if is_solana and "solana" in net:
            return a
        if (not is_solana) and ("eip155" in net or "base" in net or "ethereum" in net):
            return a

    _logger.warning(
        "No network match for preferred=%s in accepts=%s — falling back to first option",
        preferred_network, [a.get("network") for a in accepts],
    )
    return accepts[0]


def _build_x_payment_header(selected_accept: dict, proof_payload: dict, version: str | int = 2) -> str:
    """Build the X-PAYMENT header from a ProcessPayment proof.

    Uses the x402 SDK's PaymentPayload model for strict schema/ordering so
    the facilitator accepts it. Falls back to manual encoding if the SDK
    import fails (e.g. in minimal test environments).
    """
    try:
        from x402 import PaymentPayload, PaymentRequirements
        payload_model = PaymentPayload(
            x402_version=int(version) if str(version).isdigit() else 2,
            payload=proof_payload,
            accepted=PaymentRequirements(**selected_accept),
        )
        return _b64.b64encode(
            payload_model.model_dump_json(by_alias=True, exclude_none=True).encode()
        ).decode()
    except Exception as e:
        _logger.warning("x402 PaymentPayload model failed (%s), falling back", e)
        manual = {
            "x402Version": int(version) if str(version).isdigit() else 2,
            "scheme": selected_accept.get("scheme", "exact"),
            "network": selected_accept.get("network", ""),
            "payload": proof_payload,
        }
        return _b64.b64encode(json.dumps(manual).encode("utf-8")).decode("utf-8")


def _parse_payment_required(resp: _requests.Response) -> dict | None:
    """Parse x402 payment requirements from a 402 response.

    v2 spec puts the base64-encoded requirements in the ``payment-required``
    header with an empty body; older versions carry them as the JSON body.
    """
    pr_header = resp.headers.get("payment-required") or resp.headers.get("Payment-Required")
    if pr_header:
        try:
            padded = pr_header + "=" * ((4 - len(pr_header) % 4) % 4)
            decoded = _b64.b64decode(padded).decode("utf-8")
            return json.loads(decoded)
        except Exception as e:
            _logger.warning("Failed to decode payment-required header: %s", e)
    try:
        return resp.json()
    except Exception:
        return None


def _pay_and_retry(
    url: str,
    method: str = "POST",
    body: Any = None,
    extra_headers: dict | None = None,
    timeout: int = 30,
) -> _requests.Response:
    """Call an HTTP endpoint. If 402, ProcessPayment → retry with X-PAYMENT.

    Returns the final response object (either the first 200 if no payment was
    required, or the post-payment response). Raises on unrecoverable errors so
    callers can translate them into structured tool results.
    """
    creds = _payment_creds
    if not creds.get("payment_manager_arn") or not creds.get("instrument_id") or not creds.get("session_id"):
        raise RuntimeError("No active payment session. Create one in the chat header.")

    session = _requests.Session()
    headers = dict(extra_headers or {})

    def _send(hdrs: dict) -> _requests.Response:
        if method.upper() == "GET":
            return session.get(url, headers=hdrs, timeout=timeout)
        return session.post(
            url,
            json=body if not isinstance(body, (str, bytes)) else None,
            data=body if isinstance(body, (str, bytes)) else None,
            headers=hdrs,
            timeout=timeout,
        )

    resp = _send(headers)
    if resp.status_code != 402:
        return resp

    requirements = _parse_payment_required(resp)
    if not requirements:
        raise RuntimeError(f"Invalid 402 from {url}: {resp.text[:200]}")

    accepts = requirements.get("accepts", [])
    network_pref = creds.get("network", "ETHEREUM")
    _logger.info(
        "x402 402 on %s — network_pref=%s accept_count=%d",
        url, network_pref, len(accepts),
    )

    selected = _pick_accept(accepts, network_pref)
    if not selected:
        raise RuntimeError(f"No compatible payment option in 402 from {url}")

    _logger.info(
        "x402 selected accept — network=%s amount=%s asset=%s",
        selected.get("network"),
        selected.get("amount") or selected.get("maxAmountRequired"),
        selected.get("asset"),
    )

    payment_resp = _process_payment(
        payment_manager_arn=creds["payment_manager_arn"],
        instrument_id=creds["instrument_id"],
        session_id=creds["session_id"],
        x402_payload=selected,
        user_id=creds.get("user_id", ""),
    )

    crypto_output = payment_resp.get("paymentOutput", {}).get("cryptoX402", {})
    proof_payload = crypto_output.get("payload", {})
    version = crypto_output.get("version", "2")
    encoded_sig = _build_x_payment_header(selected, proof_payload, version)

    retry_headers = dict(headers)
    retry_headers["X-PAYMENT"] = encoded_sig
    retry_headers["Payment-Signature"] = encoded_sig

    # Retry with backoff — the previous on-chain tx may still be settling
    # and the facilitator rejects until the nonce clears.
    backoffs = [2, 3, 5, 8, 10]
    max_attempts = len(backoffs)
    for attempt in range(max_attempts):
        resp = _send(retry_headers)
        if resp.status_code != 402:
            break
        if attempt < max_attempts - 1:
            wait = backoffs[attempt]
            _logger.info(
                "Signed request returned 402 (attempt %d) — previous tx likely settling, waiting %ds",
                attempt + 1, wait,
            )
            _time.sleep(wait)

    return resp


# ─────────────────────────────────────────────
# Friendly error translation
# ─────────────────────────────────────────────

_FRIENDLY_ERRORS: list[tuple[str, str]] = [
    (
        "authorization cannot be null for svm payments",
        "Solana payments aren't yet enabled on this credential provider. "
        "Switch to a Coinbase/CDP instrument for Solana, or ask an admin to "
        "finish provisioning the Stripe/Privy credential provider for SVM "
        "signing.",
    ),
    (
        "no active payment session",
        "No active payment session. Create one in the chat header.",
    ),
    (
        "no compatible payment option",
        "This seller doesn't accept payments on your wallet's network. "
        "Switch to a wallet on a supported chain.",
    ),
    # Session spend-cap rejections. AgentCore returns a ValidationException when
    # a ProcessPayment would push the session over its maxSpendAmount. Surface a
    # clean message so the agent can tell the user a specific item didn't fit
    # the remaining session budget (vs a raw stack trace) — important for
    # multi-item buys where earlier items succeeded.
    (
        "exceed",
        "This purchase would exceed your payment session budget. The remaining "
        "session cap isn't enough for this item. Create a new session with a "
        "higher budget in the chat header, then try again.",
    ),
    (
        "spend limit",
        "This purchase would exceed your payment session spend limit. Create a "
        "new session with a higher budget in the chat header, then try again.",
    ),
    (
        "insufficient",
        "Your wallet doesn't have enough testnet USDC for this purchase. Fund "
        "the wallet from the faucet and try again.",
    ),
    (
        "session has expired",
        "Your payment session has expired. Create a new session in the chat "
        "header, then try again.",
    ),
    (
        "session expired",
        "Your payment session has expired. Create a new session in the chat "
        "header, then try again.",
    ),
]


def _translate_payment_error(err: Exception) -> str:
    """Map known payment errors to human-readable messages, keeping raw text
    as a fallback so the LLM can still reason about unknown failures."""
    raw = str(err)
    lower = raw.lower()
    for needle, friendly in _FRIENDLY_ERRORS:
        if needle in lower:
            return friendly
    return f"Payment error: {raw}"


# ─────────────────────────────────────────────
# Balance — GetPaymentInstrumentBalance (free)
# ─────────────────────────────────────────────

_NETWORK_TO_CHAIN = {
    "ETHEREUM": "BASE_SEPOLIA",
    "SOLANA": "SOLANA_DEVNET",
}


def _get_instrument_balance() -> dict:
    """Fetch USDC balance via GetPaymentInstrumentBalance using the active creds."""
    creds = _payment_creds
    manager_arn = creds.get("payment_manager_arn", "")
    connector_id = creds.get("connector_id", "")
    instrument_id = creds.get("instrument_id", "")
    user_id = creds.get("user_id", "")
    network = creds.get("network", "ETHEREUM")
    chain = _NETWORK_TO_CHAIN.get(network, "BASE_SEPOLIA")

    if not manager_arn or not connector_id or not instrument_id:
        return {"error": "No payment credentials set. User needs an active session and instrument."}

    client = _get_dp_client()
    kwargs = {
        "paymentManagerArn": manager_arn,
        "paymentConnectorId": connector_id,
        "paymentInstrumentId": instrument_id,
        "chain": chain,
        "token": "USDC",
    }
    if user_id:
        kwargs["userId"] = user_id

    try:
        resp = client.get_payment_instrument_balance(**kwargs)
        tb = resp.get("tokenBalance", {}) or {}
        raw = tb.get("amount", "0")
        decimals = int(tb.get("decimals", 6))
        try:
            whole = int(raw) / (10 ** decimals) if raw else 0.0
        except ValueError:
            whole = 0.0
        return {
            "instrument_id": instrument_id,
            "network": "Solana Devnet (testnet)" if network == "SOLANA" else "Base Sepolia (testnet)",
            "chain": chain,
            "token": tb.get("token", "USDC"),
            "usdc_balance": f"{whole:.6f}",
            "usdc_balance_raw": raw,
        }
    except Exception as e:
        _logger.error("GetPaymentInstrumentBalance failed: %s", e)
        return {"error": f"Failed to fetch instrument balance: {str(e)}"}


@tool
def strands_check_balance(wallet_address: str = "") -> str:
    """Check the USDC balance of the current payment instrument.

    Uses AgentCore's GetPaymentInstrumentBalance API, which works for both
    Coinbase CDP and Stripe/Privy wallets on Base Sepolia (EVM) and Solana
    Devnet. Use this when the user asks about their balance or before a
    payment to verify sufficient funds.

    Args:
        wallet_address: Unused — kept for backward compatibility with the
                       original tool signature. The balance is always fetched
                       against the active payment instrument from the session
                       context.
    """
    try:
        _logger.info("check_balance: network=%s",
                     _payment_creds.get("network", "(empty)"))
        result = _get_instrument_balance()
        return json.dumps(result)
    except Exception as e:
        return json.dumps({"error": f"Balance check error: {str(e)}"})


# ─────────────────────────────────────────────
# Direct Seller Tools (hit our API Gateway with x402 auto-payment)
# ─────────────────────────────────────────────

# Module-level storage for the last media URL produced by a seller tool.
# Checked after each agent streaming turn to send a dedicated WS media event.
_last_media_result: dict | None = None


def _send_request(url, method, body, headers, timeout):
    """Single HTTP send (no payment logic)."""
    session = _requests.Session()
    if method.upper() == "GET":
        return session.get(url, headers=headers, timeout=timeout)
    return session.post(
        url,
        json=body if not isinstance(body, (str, bytes)) else None,
        data=body if isinstance(body, (str, bytes)) else None,
        headers=headers,
        timeout=timeout,
    )


def _paid_request(url, method="POST", body=None, headers=None, timeout=60):
    """Perform an x402-paid request, routed through the plugin when it's active.

    Returns a (kind, value) tuple:
      - ("marker", marker_str): the endpoint returned 402 and the
        AgentCorePaymentsPlugin is active — return ``marker_str`` from the tool
        so the plugin runs the tagged ProcessPayment and re-invokes the tool
        with a signed ``PAYMENT-SIGNATURE`` header. This is the canonical path
        and what populates the Payments observability dashboard.
      - ("response", resp): a final response to process (200, or a non-402
        error). Reached either because the call was free, the plugin already
        injected a payment header (re-invocation), or the plugin is inactive and
        the in-process ``_pay_and_retry`` fallback handled the 402.
    """
    headers = dict(headers or {})

    if _PLUGIN_ACTIVE:
        resp = _send_request(url, method, body, headers, timeout)
        # First pass with no signed header and a 402 → hand off to the plugin.
        if resp.status_code == 402 and not _has_payment_header(headers):
            raw_header = resp.headers.get("payment-required") or resp.headers.get("Payment-Required") or ""
            requirements = _parse_payment_required(resp)
            if requirements or raw_header:
                return ("marker", _payment_required_marker(requirements or {}, raw_header))
        return ("response", resp)

    # Plugin inactive (voice / disabled): in-process x402 dance.
    resp = _pay_and_retry(url, method=method, body=body, extra_headers=headers, timeout=timeout)
    return ("response", resp)


def _process_seller_media(data: dict) -> dict:
    """Turn a seller's x402 response into a compact tool result.

    For image/audio content, the binary is uploaded to S3 (presigned URL set on
    the module-level media result for the WS layer to surface) and a durable
    copy is saved to the buyer's library. The base64 payload is NEVER returned
    to the model — only a small confirmation — so it can't blow up the context
    or leak into chat. Text content is returned inline.
    """
    global _last_media_result
    x402_content = data.get("x402_content", {})
    content_type = x402_content.get("type", "text")

    if content_type in ("image", "audio") and MEDIA_BUCKET:
        raw_data = x402_content.get("data", "")
        mime = x402_content.get("mime_type", "application/octet-stream")
        title = x402_content.get("title", "media")
        ext = "png" if "png" in mime else "jpg" if "jpeg" in mime or "jpg" in mime else "wav" if "wav" in mime else "mp3" if "mp3" in mime else "bin"
        s3_key = f"media/{_uuid.uuid4().hex}.{ext}"

        presigned_url = None
        try:
            decoded = _b64.b64decode(raw_data)
            s3 = boto3.client("s3", region_name=AWS_REGION)
            s3.put_object(Bucket=MEDIA_BUCKET, Key=s3_key, Body=decoded, ContentType=mime, ServerSideEncryption="AES256")
            presigned_url = s3.generate_presigned_url(
                "get_object",
                Params={"Bucket": MEDIA_BUCKET, "Key": s3_key},
                ExpiresIn=1800,  # 30 min
            )
            _logger.info("Uploaded %s to s3://%s/%s (%d bytes)", content_type, MEDIA_BUCKET, s3_key, len(decoded))

            # Durable per-buyer library copy (keyed by Cognito sub) so generated
            # media survives the 30-min media link and shows on the Library page.
            user_id = _payment_creds.get("user_id", "")
            if LIBRARY_BUCKET and user_id:
                try:
                    safe_title = "".join(c for c in title if c.isalnum() or c in " -_").strip()[:40] or content_type
                    lib_key = f"library/{user_id}/generated/{_uuid.uuid4().hex}-{safe_title}.{ext}"
                    s3.put_object(
                        Bucket=LIBRARY_BUCKET, Key=lib_key, Body=decoded,
                        ContentType=mime, Metadata={"userId": user_id, "source": "generated"},
                        ServerSideEncryption="AES256",
                    )
                    _logger.info("Saved generated %s to library bucket", content_type)
                except Exception as lib_err:
                    _logger.error("Library copy failed: %s", lib_err)
        except Exception as upload_err:
            _logger.error("S3 upload failed: %s", upload_err)

        if presigned_url:
            _last_media_result = {
                "url": presigned_url,
                "mediaType": content_type,
                "title": title,
                "mimeType": mime,
            }

        return {
            "status": "paid_and_completed",
            "payment_made": True,
            "content": {
                "type": content_type,
                "title": title,
                "mime_type": mime,
                "delivered": True,
                "data_size": len(raw_data),
                "note": "The image has been delivered to the user's screen. Just confirm it was generated successfully.",
            },
            "x402_meta": data.get("x402_meta", {}),
        }

    if content_type in ("image", "audio"):
        return {
            "status": "paid_and_completed",
            "payment_made": True,
            "content": {
                "type": content_type,
                "title": x402_content.get("title", ""),
                "mime_type": x402_content.get("mime_type", ""),
                "delivered": True,
                "data_size": len(x402_content.get("data", "")),
            },
            "x402_meta": data.get("x402_meta", {}),
        }

    return {
        "status": "paid_and_completed",
        "payment_made": True,
        "content": x402_content,
        "x402_meta": data.get("x402_meta", {}),
    }


@tool
def strands_generate_image(prompt: str, headers: dict | None = None) -> str:
    """Generate an AI image using Nova Canvas.

    Costs 0.04 USDC per image. Provide a text description of what to generate.
    Payment is automatic: the image seller returns HTTP 402, the AgentCore
    Payments system settles USDC on-chain from the active session, and the
    image is generated and delivered to the user's screen. You receive a short
    confirmation with the title.

    Args:
        prompt: Text description of the image to generate (max 512 chars).
                Be descriptive, e.g. "a golden retriever surfing at sunset,
                digital art style".
        headers: Internal payment header slot. Do NOT set this; the payment
                 system fills it automatically. Leave it empty.
    """
    if not SELLER_API_URL:
        return json.dumps({"error": "SELLER_API_URL not configured"})
    url = f"{SELLER_API_URL.rstrip('/')}/image-gen"
    try:
        kind, value = _paid_request(url, method="POST", body={"prompt": prompt}, headers=headers, timeout=60)
    except Exception as e:
        _logger.error("Image generation payment error: %s", type(e).__name__)
        return json.dumps({"error": _translate_payment_error(e)})

    if kind == "marker":
        # Hand off to the AgentCorePaymentsPlugin: it pays, then re-invokes this
        # tool with the signed header set, which lands in the response branch.
        return value

    resp = value
    _logger.info("Image seller response: status=%s content_length=%s",
                 resp.status_code, resp.headers.get("content-length", "?"))
    if resp.status_code == 402:
        return json.dumps({"error": f"Payment failed — seller returned 402 after payment: {resp.text[:200]}"})
    if resp.status_code != 200:
        return json.dumps({"error": f"Seller returned {resp.status_code}: {resp.text[:200]}"})
    try:
        data = resp.json()
    except Exception:
        data = {"x402_content": {"type": "text", "data": resp.text, "title": "Response", "mime_type": "text/plain"}}
    return json.dumps(_process_seller_media(data))


# ─────────────────────────────────────────────
# Agent-economy storefront — list / buy / cancel (x402 HTTP 402 flow)
# ─────────────────────────────────────────────
#
# The storefront order endpoint returns a real HTTP 402 with x402 requirements
# when called without a proof. ``_pay_and_retry`` handles the full dance:
# 402 → ProcessPayment → retry with X-PAYMENT → 200. Browsing is free.


@tool
def strands_list_products() -> str:
    """List the products available in the agent storefront. Free, no payment.

    Returns each product's id, name, description, price (USDC), and stock. Use
    this when the user asks what's for sale or wants to browse, and to get a
    product's id before buying it with buy_product.
    """
    if not STOREFRONT_API_URL:
        return json.dumps({"error": "STOREFRONT_API_URL not configured"})
    try:
        url = f"{STOREFRONT_API_URL.rstrip('/')}/products"
        resp = _requests.get(url, timeout=15)
        if resp.status_code != 200:
            return json.dumps({"error": f"Catalog returned {resp.status_code}"})
        return json.dumps(resp.json())
    except Exception as e:
        return json.dumps({"error": f"List products error: {str(e)}"})


@tool
def strands_buy_product(product_id: str, quantity: int = 1, shipping_address: str = "", headers: dict | None = None) -> str:
    """Buy a product from the agent storefront, paying with x402 + AgentCore Payments.

    The storefront returns HTTP 402 with payment requirements; the AgentCore
    Payments system pays automatically from the user's active session and
    instrument, then the order is confirmed and fulfilled.

    Fulfillment depends on the product:
      - digital file goods → saved to the user's library
      - digital license goods → a redeem token
      - physical goods → a confirmation email and a shipping estimate

    Args:
        product_id: The product to buy (from list_products, e.g. "stock-photo-pack").
        quantity: How many units to buy (default 1).
        shipping_address: Optional shipping address for PHYSICAL goods. If the
            user is buying a physical item and hasn't given one, ask for it
            first (a mock address is fine for the demo).
        headers: Internal payment header slot. Do NOT set this; the payment
            system fills it automatically. Leave it empty.
    """
    if not STOREFRONT_API_URL:
        return json.dumps({"error": "STOREFRONT_API_URL not configured"})
    url = f"{STOREFRONT_API_URL.rstrip('/')}/orders"
    body = {
        "productId": product_id,
        "quantity": int(quantity),
        "userId": _payment_creds.get("user_id", ""),
        "email": _payment_creds.get("email", ""),
    }
    if shipping_address:
        body["shippingAddress"] = shipping_address
    try:
        kind, value = _paid_request(url, method="POST", body=body, headers=headers, timeout=60)
    except Exception as e:
        _logger.error("Buy product error: %s", type(e).__name__)
        return json.dumps({"error": _translate_payment_error(e)})

    if kind == "marker":
        # Hand off to the AgentCorePaymentsPlugin: it runs the tagged
        # ProcessPayment, then re-invokes this tool with the signed header.
        return value

    resp = value
    if resp.status_code in (200, 201):
        # The agent does not surface a download link or refund warning for file
        # goods — the buyer's Library owns the download action and the
        # non-refundable warning. Just return the order/delivery summary.
        return json.dumps(resp.json())
    if resp.status_code == 402:
        return json.dumps({"error": f"Payment failed — storefront returned 402: {resp.text[:200]}"})
    if resp.status_code == 409:
        return json.dumps({"error": f"Out of stock or conflict: {resp.text[:200]}"})
    return json.dumps({"error": f"Storefront returned {resp.status_code}: {resp.text[:200]}"})


@tool
def strands_cancel_order(order_id: str) -> str:
    """Cancel a confirmed order and refund the buyer.

    Triggers a seller-originated refund (reverse x402 payment) governed by a
    spend-capped refund session. Only works on a CONFIRMED order that hasn't
    already been refunded. Returns the refund result.

    Args:
        order_id: The order to cancel/refund (from a prior buy_product result).
    """
    if not STOREFRONT_API_URL:
        return json.dumps({"error": "STOREFRONT_API_URL not configured"})
    try:
        url = f"{STOREFRONT_API_URL.rstrip('/')}/orders/{order_id}/refund"
        resp = _requests.post(url, timeout=60)
        try:
            data = resp.json()
        except Exception:
            data = {"raw": resp.text[:200]}
        if resp.status_code == 200:
            return json.dumps(data)
        return json.dumps({"error": data.get("error", f"Refund returned {resp.status_code}")})
    except Exception as e:
        return json.dumps({"error": f"Cancel order error: {str(e)}"})


@tool
def strands_list_orders() -> str:
    """List the current buyer's past storefront orders.

    Use this when the user wants to refund/cancel a purchase but does not have
    the order id handy (for example in a new session where the earlier
    buy_product result is no longer in context). Returns the buyer's own orders
    — order id, item name, amount, network, status, and a `refundable` hint.
    Find the matching order here, confirm it with the user, then call
    cancel_order with its order_id.

    Scoped to the signed-in buyer automatically; takes no arguments.
    """
    if not STOREFRONT_API_URL:
        return json.dumps({"error": "STOREFRONT_API_URL not configured"})
    user_id = _payment_creds.get("user_id", "")
    if not user_id:
        return json.dumps({"error": "No buyer identity in this session; cannot list orders."})
    try:
        url = f"{STOREFRONT_API_URL.rstrip('/')}/orders"
        resp = _requests.get(url, params={"userId": user_id}, timeout=30)
        if resp.status_code == 200:
            return json.dumps(resp.json())
        return json.dumps({"error": f"Order lookup returned {resp.status_code}"})
    except Exception as e:
        return json.dumps({"error": f"List orders error: {str(e)}"})


STRANDS_TOOLS = [
    strands_check_balance,
    strands_generate_image,
    strands_list_products,
    strands_buy_product,
    strands_list_orders,
    strands_cancel_order,
]


def pop_last_media_result() -> dict | None:
    """Return and clear the last media result (presigned URL) if any."""
    global _last_media_result
    result = _last_media_result
    _last_media_result = None
    return result
