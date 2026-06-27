"""
A2A (Agent-to-Agent) x402 endpoint.

Implements the two-leg handshake from
  https://github.com/google-a2a/a2a-x402/v0.1

Leg 1 - caller sends a message/send RPC without payment:
  Server returns a task in state "input-required" with
  x402.payment.required in the status message metadata.

Leg 2 - caller resends the same task ID, this time with
  x402.payment.status: "payment-submitted" and the signed
  EIP-3009 payload in x402.payment.payload:
  Server verifies payment, generates the image, settles,
  and returns a completed task with the image artifact.

Usage (from another agent):
  POST /a2a
  Content-Type: application/json
  X-A2A-Extensions: https://github.com/google-a2a/a2a-x402/v0.1

  {"jsonrpc":"2.0","id":"1","method":"message/send",
   "params":{"message":{"kind":"message","role":"user",
     "parts":[{"kind":"text","text":"a sunset over mountains"}]}}}
"""

import boto3
import json
import logging
import os
import uuid

import requests as http_requests
from fastapi import APIRouter
from pydantic import BaseModel
from typing import Any, Dict

logger = logging.getLogger(__name__)

router = APIRouter()

NETWORK_TO_EIP155: Dict[str, str] = {
    "base-sepolia": "eip155:84532",
    "base": "eip155:8453",
    "mainnet": "eip155:1",
    "ethereum": "eip155:1",
}

# Nova Canvas fixed cost: $0.04 USDC (6-decimal wei)
IMAGE_COST_WEI = int(0.04 * 1_000_000)

bedrock = boto3.client(
    "bedrock-runtime", region_name=os.getenv("AWS_REGION", "us-east-1")
)


def _build_task(task_id: str, state: str, parts: list, metadata: dict = None) -> dict:
    task: Dict[str, Any] = {
        "kind": "task",
        "id": task_id,
        "status": {
            "state": state,
            "message": {
                "kind": "message",
                "role": "agent",
                "parts": parts,
            },
        },
    }
    if metadata:
        task["status"]["message"]["metadata"] = metadata
    return task


def _facilitator_post(path: str, body: dict) -> dict:
    resp = http_requests.post(
        f"https://x402.org/facilitator/{path}",
        json=body,
        timeout=15,
        allow_redirects=True,
    )
    resp.raise_for_status()
    return resp.json()


def _x402_body(payload: dict, requirements: dict) -> dict:
    return {
        "x402Version": 1,
        "paymentPayload": {
            "x402Version": 1,
            "scheme": "exact",
            "network": "base-sepolia",
            "payload": payload,
        },
        "paymentRequirements": requirements,
    }


class A2ARequest(BaseModel):
    jsonrpc: str
    id: Any = None
    method: str
    params: Dict[str, Any]


@router.post("/a2a")
async def a2a_message_send(request: A2ARequest):
    """JSON-RPC endpoint for A2A message/send with x402 payment handshake."""
    if request.method != "message/send":
        return {
            "jsonrpc": "2.0",
            "id": request.id,
            "error": {"code": -32601, "message": f"Method not found: {request.method}"},
        }

    message = request.params.get("message", {})
    task_id = message.get("taskId") or str(uuid.uuid4())
    metadata = message.get("metadata", {})
    parts = message.get("parts", [])
    prompt = next(
        (p.get("text", "") for p in parts if p.get("kind") == "text"), ""
    ) or "A beautiful AI-generated image"

    gateway_url = os.getenv("GATEWAY_URL", "").rstrip("/")
    seller_wallet = os.getenv("SELLER_WALLET", "")
    raw_network = os.getenv("NETWORK_ID", "base-sepolia")
    eip155_network = NETWORK_TO_EIP155.get(raw_network, "eip155:84532")
    usdc_contract = os.getenv("USDC_CONTRACT", "0x036CbD53842c5426634e7929541eC2318f3dCF7e")

    payment_requirements = {
        "scheme": "exact",
        "network": eip155_network,
        "amount": str(IMAGE_COST_WEI),
        "asset": usdc_contract,
        "payTo": seller_wallet,
        "maxTimeoutSeconds": 600,
        "extra": {"name": "USDC", "version": "2", "decimals": 6},
    }

    # Leg 1: no payment yet
    if metadata.get("x402.payment.status") != "payment-submitted":
        task = _build_task(
            task_id,
            "input-required",
            [{"kind": "text", "text": "Payment required to generate image."}],
            metadata={
                "x402.payment.status": "payment-required",
                "x402.payment.required": {
                    "x402Version": 2,
                    "error": "Payment required",
                    "resource": {
                        "url": f"{gateway_url}/a2a",
                        "description": "AI image generation via Amazon Nova Canvas",
                        "mimeType": "application/json",
                    },
                    "accepts": [payment_requirements],
                },
            },
        )
        return {"jsonrpc": "2.0", "id": request.id, "result": task}

    # Leg 2: payment submitted
    payment_payload_raw = metadata.get("x402.payment.payload", {})
    actual_payload = payment_payload_raw.get("payload", payment_payload_raw)

    try:
        verification = _facilitator_post("verify", _x402_body(actual_payload, payment_requirements))
    except Exception as exc:
        logger.error("x402 verify error: %s", exc)
        return {
            "jsonrpc": "2.0",
            "id": request.id,
            "result": _build_task(task_id, "failed",
                [{"kind": "text", "text": f"Payment verification error: {exc}"}],
                metadata={"x402.payment.status": "payment-failed", "x402.payment.error": str(exc)}),
        }

    if not verification.get("isValid"):
        reason = verification.get("invalidReason", "unknown")
        return {
            "jsonrpc": "2.0",
            "id": request.id,
            "result": _build_task(task_id, "failed",
                [{"kind": "text", "text": f"Invalid payment: {reason}"}],
                metadata={"x402.payment.status": "payment-failed", "x402.payment.error": reason}),
        }

    # Generate image — settle only if generation succeeds (fair billing)
    try:
        br_response = bedrock.invoke_model(
            modelId="amazon.nova-canvas-v1:0",
            body=json.dumps({
                "taskType": "TEXT_IMAGE",
                "textToImageParams": {"text": prompt},
                "imageGenerationConfig": {"numberOfImages": 1, "quality": "standard", "height": 1024, "width": 1024},
            }),
        )
        image_b64: str = json.loads(br_response["body"].read())["images"][0]
    except Exception as exc:
        logger.error("Bedrock generation failed: %s", exc)
        return {
            "jsonrpc": "2.0",
            "id": request.id,
            "result": _build_task(task_id, "failed",
                [{"kind": "text", "text": "Image generation failed — payment not charged."}],
                metadata={"x402.payment.status": "payment-accepted", "x402.payment.error": f"generation_failed: {exc}", "x402.payment.receipts": []}),
        }

    receipts = []
    try:
        settlement = _facilitator_post("settle", _x402_body(actual_payload, payment_requirements))
        receipts.append({"success": settlement.get("success", False), "transaction": settlement.get("transaction"), "network": eip155_network})
    except Exception as exc:
        receipts.append({"success": False, "errorReason": str(exc), "network": eip155_network})

    artifact_id = str(uuid.uuid4())
    task = _build_task(
        task_id, "completed",
        [{"kind": "text", "text": f"Image generated: {prompt[:80]}"}],
        metadata={
            "x402.payment.status": "payment-settled",
            "x402.payment.receipts": receipts,
            "x402.payment.lifecycle": ["payment-required", "payment-submitted", "payment-accepted", "payment-settled"],
        },
    )
    task["artifacts"] = [{
        "artifactId": artifact_id,
        "name": "generated-image.png",
        "description": f"Nova Canvas image: {prompt[:80]}",
        "mimeType": "image/png",
        "data": image_b64,
    }]
    return {"jsonrpc": "2.0", "id": request.id, "result": task}
