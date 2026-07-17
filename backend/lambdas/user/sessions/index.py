"""
User Lambda: Payment Sessions (Data Plane)
Routes:
  POST   /user/sessions                 → create payment session
  GET    /user/sessions?managerArn=…    → list sessions under a manager
  GET    /user/sessions/{id}            → get specific session
  DELETE /user/sessions/{id}            → hard-delete a session

Identity model: every session operation is scoped to the caller's Cognito
``sub`` (forwarded to AgentCore as ``userId``) — the same identity the
instruments are created under. This keeps sessions, instruments, and
ProcessPayment all addressing one user for both CoinbaseCDP and StripePrivy.
All downstream calls are SDK-only — there is no local database.
"""
import sys, os
sys.path.insert(0, "/opt")  # Lambda layer
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "shared"))  # local dev

from agentcore_client import get_dp_client
from response import ok, error, parse_body, get_user_id


def handler(event, context):
    method = event.get("requestContext", {}).get("http", {}).get("method", "GET")
    path_params = event.get("pathParameters") or {}
    session_id = path_params.get("id")
    user_id = get_user_id(event)

    if not user_id:
        return error("Unauthorized — no user identity", 401)

    if method == "OPTIONS":
        return ok({"message": "ok"})

    dp = get_dp_client()

    try:
        if method == "POST":
            return create(dp, event, user_id)
        elif method == "GET" and session_id:
            return get_one(dp, event, user_id, session_id)
        elif method == "GET":
            return list_all(dp, event, user_id)
        elif method == "DELETE" and session_id:
            return delete(dp, event, user_id, session_id)
        else:
            return error("Method not allowed", 405)
    except Exception as e:
        return error(str(e), 500)


def create(dp, event, user_id):
    body = parse_body(event)
    manager_arn = body.get("paymentManagerArn")
    if not manager_arn:
        return error("paymentManagerArn is required")

    expiry_minutes = int(body.get("expiryTimeInMinutes", 15))
    max_spend = body.get("maxSpendAmount", {"value": "1.0", "currency": "USD"})

    # expiryTimeInMinutes — service requires 15–480 minutes
    expiry_duration = max(15, min(expiry_minutes, 480))

    # Scope the session to the same Cognito sub the wallet was created under,
    # so ProcessPayment can find the session when it debits the instrument.
    resp = dp.create_payment_session(
        paymentManagerArn=manager_arn,
        userId=user_id,
        expiryTimeInMinutes=expiry_duration,
        limits={"maxSpendAmount": max_spend},
    )
    resp.pop("ResponseMetadata", None)
    return ok(resp, 201)


def get_one(dp, event, user_id, session_id):
    qs = event.get("queryStringParameters") or {}
    manager_arn = qs.get("managerArn", "")

    if not manager_arn:
        return error("managerArn is a required query parameter")

    resp = dp.get_payment_session(
        paymentManagerArn=manager_arn,
        paymentSessionId=session_id,
        userId=user_id,
    )
    resp.pop("ResponseMetadata", None)
    return ok(resp)


def list_all(dp, event, user_id):
    """List payment sessions under a given manager for the current user.

    Required query param: ``managerArn``. The runtime enforces ``userId``
    even though the model marks it optional, so we always scope by the
    Cognito sub. The frontend fans out over the payment managers it holds
    and merges results client-side.
    """
    qs = event.get("queryStringParameters") or {}
    manager_arn = qs.get("managerArn", "")

    if not manager_arn:
        return ok({"paymentSessions": []})

    resp = dp.list_payment_sessions(
        paymentManagerArn=manager_arn,
        userId=user_id,
        maxResults=50,
    )
    resp.pop("ResponseMetadata", None)
    return ok(resp)


def delete(dp, event, user_id, session_id):
    """Hard-delete a payment session.

    AgentCore removes the session record permanently — no undelete. Manager
    ARN must be supplied as a query parameter; the frontend has it from the
    list response.
    """
    qs = event.get("queryStringParameters") or {}
    manager_arn = qs.get("managerArn", "")

    if not manager_arn:
        return error("managerArn is a required query parameter")

    try:
        resp = dp.delete_payment_session(
            paymentManagerArn=manager_arn,
            paymentSessionId=session_id,
            userId=user_id,
        )
        resp.pop("ResponseMetadata", None)
    except Exception as e:
        msg = str(e)
        if "ResourceNotFoundException" not in msg:
            return error(f"DeletePaymentSession failed: {msg}", 500)
        # Idempotent — service-side already gone is still a clean delete.
        resp = {"status": "ALREADY_DELETED"}

    return ok(resp)
