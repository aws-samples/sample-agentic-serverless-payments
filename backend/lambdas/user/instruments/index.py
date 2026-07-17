"""
User Lambda: Payment Instruments (Data Plane)
Routes:
  POST   /user/instruments                 → create embedded crypto wallet
  GET    /user/instruments?managerArn=…    → list instruments under a manager
  GET    /user/instruments/{id}            → get specific instrument
  GET    /user/instruments/{id}/balance    → token balance for an instrument
  DELETE /user/instruments/{id}            → soft-delete an instrument

Identity model: every payment operation is scoped to the caller's Cognito
``sub`` (forwarded to AgentCore as ``userId``). The same value is used on
create, list, get, balance, and delete for BOTH CoinbaseCDP and StripePrivy
instruments, so a wallet created under a user always lists back under that
same user. All downstream calls are SDK-only — there is no local database.
"""
import sys, os, uuid
sys.path.insert(0, "/opt")  # Lambda layer
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "shared"))  # local dev

from agentcore_client import get_dp_client
from response import ok, error, parse_body, get_user_id


def client_token():
    return str(uuid.uuid4()) + "-" + str(uuid.uuid4())[:8]


def handler(event, context):
    method = event.get("requestContext", {}).get("http", {}).get("method", "GET")
    path_params = event.get("pathParameters") or {}
    instrument_id = path_params.get("id")
    user_id = get_user_id(event)
    # API Gateway preserves the full path under `rawPath`; use it to distinguish
    # /user/instruments/{id} from /user/instruments/{id}/balance since both
    # match the same Lambda integration.
    raw_path = event.get("rawPath") or event.get("requestContext", {}).get("http", {}).get("path", "")
    is_balance_route = raw_path.endswith("/balance")

    if not user_id:
        return error("Unauthorized — no user identity", 401)

    if method == "OPTIONS":
        return ok({"message": "ok"})

    dp = get_dp_client()

    try:
        if method == "POST":
            return create(dp, event, user_id)
        elif method == "GET" and instrument_id and is_balance_route:
            return get_balance(dp, event, user_id, instrument_id)
        elif method == "GET" and instrument_id:
            return get_one(dp, event, user_id, instrument_id)
        elif method == "GET":
            return list_all(dp, event, user_id)
        elif method == "DELETE" and instrument_id:
            return delete(dp, event, user_id, instrument_id)
        else:
            return error("Method not allowed", 405)
    except Exception as e:
        return error(str(e), 500)


def create(dp, event, user_id):
    body = parse_body(event)
    manager_arn = body.get("paymentManagerArn")
    connector_id = body.get("paymentConnectorId")
    if not manager_arn or not connector_id:
        return error("paymentManagerArn and paymentConnectorId are required")

    network = body.get("network", "ETHEREUM")

    # Resolve the user's email — required for EMBEDDED_CRYPTO_WALLET linked
    # accounts. Prefer the request body, fall back to the Cognito JWT `email`
    # claim.
    email = body.get("email")
    if not email:
        claims = (
            event.get("requestContext", {})
            .get("authorizer", {})
            .get("jwt", {})
            .get("claims", {})
        )
        email = claims.get("email")
    if not email:
        return error("email is required (either in request body or Cognito claims)")

    # The Cognito sub is the single identity we scope every payment op to.
    # boto3 forwards it as the X-Amzn-Bedrock-AgentCore-Payments-User-Id
    # header. Using it consistently on create + list + get + balance + delete
    # (and on session create) means a wallet always lists back under the same
    # user that created it — for both CoinbaseCDP and StripePrivy.
    create_kwargs = {
        "paymentManagerArn": manager_arn,
        "paymentConnectorId": connector_id,
        "userId": user_id,
        "paymentInstrumentType": "EMBEDDED_CRYPTO_WALLET",
        "paymentInstrumentDetails": {
            "embeddedCryptoWallet": {
                "network": network,
                "linkedAccounts": [{"email": {"emailAddress": email}}],
            }
        },
        "clientToken": client_token(),
    }

    resp = dp.create_payment_instrument(**create_kwargs)
    resp.pop("ResponseMetadata", None)
    return ok(resp, 201)


def get_one(dp, event, user_id, instrument_id):
    qs = event.get("queryStringParameters") or {}
    manager_arn = qs.get("managerArn", "")
    connector_id = qs.get("connectorId", "")

    if not manager_arn or not connector_id:
        return error("managerArn and connectorId are required query parameters")

    resp = dp.get_payment_instrument(
        paymentManagerArn=manager_arn,
        paymentConnectorId=connector_id,
        paymentInstrumentId=instrument_id,
        userId=user_id,
    )
    resp.pop("ResponseMetadata", None)
    return ok(resp)


def list_all(dp, event, user_id):
    """List payment instruments under a given manager for the current user.

    ``ListPaymentInstruments`` requires ``paymentManagerArn`` and, in
    practice, also requires ``userId`` (the runtime rejects calls without one
    even though the model marks it optional). We always scope by the Cognito
    sub. When no ``managerArn`` is supplied we return an empty list; the
    frontend fans out per manager and merges client-side.
    """
    qs = event.get("queryStringParameters") or {}
    manager_arn = qs.get("managerArn", "")
    connector_id = qs.get("connectorId", "")

    if not manager_arn:
        return ok({"paymentInstruments": []})

    kwargs = {
        "paymentManagerArn": manager_arn,
        "userId": user_id,
        "maxResults": 50,
    }
    if connector_id:
        kwargs["paymentConnectorId"] = connector_id

    resp = dp.list_payment_instruments(**kwargs)
    resp.pop("ResponseMetadata", None)
    return ok(resp)


# Mapping from the instrument's CryptoWalletNetwork to the GetPaymentInstrumentBalance
# `chain` enum. Both networks are USDC-only for the x402 flow.
_NETWORK_TO_CHAIN = {
    "ETHEREUM": "BASE_SEPOLIA",
    "SOLANA": "SOLANA_DEVNET",
}


def get_balance(dp, event, user_id, instrument_id):
    """Fetch USDC balance for an instrument via GetPaymentInstrumentBalance.

    Manager ARN and connector ID come from query params. Chain is derived
    from the ``network`` query param (or defaults to BASE_SEPOLIA for EVM).
    """
    qs = event.get("queryStringParameters") or {}
    manager_arn = qs.get("managerArn", "")
    connector_id = qs.get("connectorId", "")
    chain = qs.get("chain", "")
    token = qs.get("token", "USDC")
    network = qs.get("network", "")

    # Derive chain from the network query param when the caller didn't send
    # one explicitly. Falls back to BASE_SEPOLIA (EVM) if nothing's provided.
    if not chain:
        chain = _NETWORK_TO_CHAIN.get(network, "BASE_SEPOLIA")

    if not manager_arn or not connector_id:
        return error("managerArn and connectorId are required query parameters")

    resp = dp.get_payment_instrument_balance(
        paymentManagerArn=manager_arn,
        paymentConnectorId=connector_id,
        paymentInstrumentId=instrument_id,
        userId=user_id,
        chain=chain,
        token=token,
    )
    resp.pop("ResponseMetadata", None)
    return ok(resp)


def delete(dp, event, user_id, instrument_id):
    """Soft-delete a payment instrument.

    AgentCore performs a soft delete — the instrument record is preserved
    service-side for audit but marked DELETED and excluded from future
    ``list_payment_instruments`` responses. Manager ARN and connector ID
    must be supplied as query parameters; the frontend has them from the
    list response.
    """
    qs = event.get("queryStringParameters") or {}
    manager_arn = qs.get("managerArn", "")
    connector_id = qs.get("connectorId", "")

    if not manager_arn or not connector_id:
        return error("managerArn and connectorId are required query parameters")

    try:
        resp = dp.delete_payment_instrument(
            paymentManagerArn=manager_arn,
            paymentConnectorId=connector_id,
            paymentInstrumentId=instrument_id,
            userId=user_id,
        )
        resp.pop("ResponseMetadata", None)
    except Exception as e:
        # Idempotent — a resource that's already gone is a successful delete.
        msg = str(e)
        if "ResourceNotFoundException" not in msg:
            return error(f"DeletePaymentInstrument failed: {msg}", 500)
        resp = {"status": "ALREADY_DELETED"}

    return ok(resp)
