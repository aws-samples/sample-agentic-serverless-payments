"""
Admin Lambda: Credential Providers (Control Plane)

Supports two vendors, both created through the standard
bedrock-agentcore-control endpoint:
  - CoinbaseCDP
  - StripePrivy

Routes:
  POST   /admin/credential-providers          → create
  GET    /admin/credential-providers           → list
  GET    /admin/credential-providers/{id}      → get
  DELETE /admin/credential-providers/{id}      → delete

Body for CoinbaseCDP:
  { "name": "...", "vendor": "CoinbaseCDP",
    "apiKeyId": "...", "apiKeySecret": "...", "walletSecret": "..." }

Body for StripePrivy:
  { "name": "...", "vendor": "StripePrivy",
    "appId": "...", "appSecret": "...",
    "authorizationId": "...", "authorizationPrivateKey": "..." }
"""
import sys, os
sys.path.insert(0, "/opt")  # Lambda layer
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "shared"))  # local dev

from agentcore_client import get_cp_client
from response import ok, error, parse_body, require_admin


VENDOR_COINBASE = "CoinbaseCDP"
VENDOR_STRIPE_PRIVY = "StripePrivy"

# Privy sometimes ships its private key with a "wallet-auth:" prefix that the
# service rejects. Strip it silently so users don't have to think about it.
PRIVY_KEY_PREFIX = "wallet-auth:"


def _strip_privy_prefix(value: str) -> str:
    if value and value.startswith(PRIVY_KEY_PREFIX):
        return value[len(PRIVY_KEY_PREFIX):]
    return value


def handler(event, context):
    method = event.get("requestContext", {}).get("http", {}).get("method", "GET")
    path_params = event.get("pathParameters") or {}
    provider_name = path_params.get("id")

    if method == "OPTIONS":
        return ok({"message": "ok"})

    # Authorization: /admin/* requires Cognito 'admin' group membership.
    # Authentication is enforced by the API Gateway JWT authorizer; this adds
    # the role check so a valid non-admin token cannot reach admin operations.
    denied = require_admin(event)
    if denied:
        return denied

    try:
        if method == "POST":
            return create(event)
        elif method == "GET" and provider_name:
            return get_one(event, provider_name)
        elif method == "GET":
            return list_all()
        elif method == "DELETE" and provider_name:
            return delete(event, provider_name)
        elif method == "PUT" and provider_name:
            return update(event, provider_name)
        else:
            return error("Method not allowed", 405)
    except Exception as e:
        return error(str(e), 500)


def create(event):
    body = parse_body(event)
    name = body.get("name")
    if not name:
        return error("name is required")

    vendor = body.get("vendor", VENDOR_COINBASE)

    if vendor == VENDOR_COINBASE:
        config = {"coinbaseCdpConfiguration": {
            "apiKeyId": body.get("apiKeyId", ""),
            "apiKeySecret": body.get("apiKeySecret", ""),
        }}
        if body.get("walletSecret"):
            config["coinbaseCdpConfiguration"]["walletSecret"] = body["walletSecret"]
    elif vendor == VENDOR_STRIPE_PRIVY:
        missing = [k for k in ("appId", "appSecret", "authorizationId", "authorizationPrivateKey") if not body.get(k)]
        if missing:
            return error(f"StripePrivy requires: {', '.join(missing)}")
        config = {"stripePrivyConfiguration": {
            "appId": body["appId"],
            "appSecret": body["appSecret"],
            "authorizationId": body["authorizationId"],
            "authorizationPrivateKey": _strip_privy_prefix(body["authorizationPrivateKey"]),
        }}
    else:
        return error(f"Unsupported vendor: {vendor}")

    resp = get_cp_client().create_payment_credential_provider(
        name=name,
        credentialProviderVendor=vendor,
        providerConfigurationInput=config,
    )
    resp.pop("ResponseMetadata", None)
    return ok(resp, 201)


def get_one(event, name):
    """Fetch a credential provider by name."""
    try:
        resp = get_cp_client().get_payment_credential_provider(name=name)
        resp.pop("ResponseMetadata", None)
        return ok(resp)
    except Exception:
        return error(f"Credential provider not found: {name}", 404)


def list_all():
    """List credential providers (both CoinbaseCDP and StripePrivy)."""
    resp = get_cp_client().list_payment_credential_providers(maxResults=20)
    return ok({"credentialProviders": resp.get("credentialProviders", [])})


def delete(event, name):
    """Delete a credential provider."""
    try:
        get_cp_client().delete_payment_credential_provider(name=name)
        return ok({"message": f"Deleted credential provider: {name}"})
    except Exception as e:
        return error(f"Failed to delete {name}: {e}", 500)


def update(event, name):
    """Rotate credentials for a provider. UpdatePaymentCredentialProvider is
    a full-replace of providerConfigurationInput — users must resubmit the
    vendor secrets."""
    body = parse_body(event)
    vendor = body.get("vendor", VENDOR_COINBASE)

    if vendor == VENDOR_COINBASE:
        config = {"coinbaseCdpConfiguration": {
            "apiKeyId": body.get("apiKeyId", ""),
            "apiKeySecret": body.get("apiKeySecret", ""),
        }}
        if body.get("walletSecret"):
            config["coinbaseCdpConfiguration"]["walletSecret"] = body["walletSecret"]
    elif vendor == VENDOR_STRIPE_PRIVY:
        missing = [k for k in ("appId", "appSecret", "authorizationId", "authorizationPrivateKey") if not body.get(k)]
        if missing:
            return error(f"StripePrivy requires: {', '.join(missing)}")
        config = {"stripePrivyConfiguration": {
            "appId": body["appId"],
            "appSecret": body["appSecret"],
            "authorizationId": body["authorizationId"],
            "authorizationPrivateKey": _strip_privy_prefix(body["authorizationPrivateKey"]),
        }}
    else:
        return error(f"Unsupported vendor: {vendor}")

    resp = get_cp_client().update_payment_credential_provider(
        name=name,
        credentialProviderVendor=vendor,
        providerConfigurationInput=config,
    )
    resp.pop("ResponseMetadata", None)
    return ok(resp)
