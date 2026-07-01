"""
Agent Lambda — WebSocket presigned URL + REST text invocation.
GET  /user/agent/ws-url  → returns a SigV4 presigned WSS URL
POST /user/agent/invoke  → calls Runtime /invocations for text chat
"""
import sys, os
sys.path.insert(0, "/opt")  # Lambda layer

import json
import uuid
import datetime
from urllib.parse import quote, urlencode, urlparse
import urllib.request

from botocore.auth import SigV4QueryAuth, SigV4Auth
from botocore.awsrequest import AWSRequest
from botocore.session import Session

from response import ok, error, get_user_id

REGION = os.environ.get("AWS_REGION", "us-east-1")
RUNTIME_ARN = os.environ["AGENT_RUNTIME_ARN"]
# AgentCore Runtime endpoint for websocket/invoke. Defaults to the region's
# standard AgentCore endpoint; override with RUNTIME_ENDPOINT only if needed.
RUNTIME_ENDPOINT = os.environ.get("RUNTIME_ENDPOINT") or f"https://bedrock-agentcore.{REGION}.amazonaws.com"
PRESIGN_EXPIRES = 300  # max 300s


def _generate_presigned_ws_url(session_id: str) -> str:
    """Generate a SigV4 presigned WSS URL for AgentCore Runtime WebSocket."""
    host = RUNTIME_ENDPOINT.replace("https://", "")
    encoded_arn = quote(RUNTIME_ARN, safe="")
    path = f"/runtimes/{encoded_arn}/ws"

    # Session ID goes as a query param (gets signed into the URL)
    query_params = {
        "X-Amzn-Bedrock-AgentCore-Runtime-Session-Id": session_id,
    }
    query_string = urlencode(query_params)
    https_url = f"https://{host}{path}?{query_string}"

    # Get credentials from the Lambda execution role
    botocore_session = Session()
    credentials = botocore_session.get_credentials().get_frozen_credentials()

    request = AWSRequest(method="GET", url=https_url, headers={"host": host})
    signer = SigV4QueryAuth(
        credentials=credentials,
        service_name="bedrock-agentcore",
        region_name=REGION,
        expires=PRESIGN_EXPIRES,
    )
    signer.add_auth(request)

    # Convert https:// → wss:// for WebSocket
    return request.url.replace("https://", "wss://")


def _invoke_runtime(prompt: str, user_id: str) -> dict:
    """SigV4-sign a POST to AgentCore Runtime /invocations for text chat."""
    encoded_arn = quote(RUNTIME_ARN, safe="")
    url = f"{RUNTIME_ENDPOINT}/runtimes/{encoded_arn}/invocations"
    payload = json.dumps({"prompt": prompt, "userId": user_id}).encode("utf-8")

    botocore_session = Session()
    credentials = botocore_session.get_credentials().get_frozen_credentials()

    request = AWSRequest(
        method="POST",
        url=url,
        data=payload,
        headers={
            "Content-Type": "application/json",
            "host": urlparse(RUNTIME_ENDPOINT).hostname,
        },
    )
    SigV4Auth(credentials, "bedrock-agentcore", REGION).add_auth(request)

    req = urllib.request.Request(
        url,
        data=payload,
        method="POST",
        headers=dict(request.headers),
    )
    # Only ever call the HTTPS AgentCore Runtime endpoint (RUNTIME_ENDPOINT is a
    # controlled env var). Reject any non-HTTPS scheme so urlopen cannot be
    # coerced into file:// or other schemes.
    if not url.lower().startswith("https://"):
        raise ValueError("Refusing to invoke a non-HTTPS runtime endpoint")
    with urllib.request.urlopen(req, timeout=60) as resp:  # nosec B310 - https-only, SigV4-signed AgentCore Runtime URL
        body = json.loads(resp.read().decode("utf-8"))
    return body


def handler(event, context):
    method = event.get("requestContext", {}).get("http", {}).get("method", "")
    path = event.get("rawPath", "")

    if method == "OPTIONS":
        return ok({})

    user_id = get_user_id(event)
    if not user_id:
        return error("Unauthorized", 401)

    # POST /user/agent/invoke — REST text chat
    if method == "POST" and path.endswith("/invoke"):
        try:
            body = json.loads(event.get("body", "{}") or "{}")
            prompt = body.get("prompt", "").strip()
            if not prompt:
                return error("prompt is required", 400)
            result = _invoke_runtime(prompt, user_id)
            return ok({"response": result.get("response", "")})
        except Exception as e:
            print(f"[ERROR] invoke failed: {type(e).__name__}")
            return error("Agent invocation failed", 500)

    # GET /user/agent/ws-url — presigned WebSocket URL
    if method == "GET":
        try:
            session_id = str(uuid.uuid4())
            presigned_url = _generate_presigned_ws_url(session_id)
            return ok({
                "wsUrl": presigned_url,
                "sessionId": session_id,
                "userId": user_id,
                "expiresIn": PRESIGN_EXPIRES,
                "runtimeArn": RUNTIME_ARN,
            })
        except Exception as e:
            print(f"[ERROR] Failed to generate presigned URL: {type(e).__name__}")
            return error("Failed to generate WebSocket URL", 500)

    return error("Method not allowed", 405)
