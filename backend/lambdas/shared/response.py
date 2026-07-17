"""Shared HTTP response helpers for Lambda functions."""
import json
from decimal import Decimal


class DecimalEncoder(json.JSONEncoder):
    def default(self, o):
        if isinstance(o, Decimal):
            return str(o)
        return super().default(o)


def ok(body, status=200):
    return {
        "statusCode": status,
        "headers": {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Headers": "Content-Type,Authorization",
            "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
        },
        "body": json.dumps(body, default=str, cls=DecimalEncoder),
    }


def error(message, status=400):
    return ok({"error": message}, status)


def _get_claims(event):
    return (
        event.get("requestContext", {})
        .get("authorizer", {})
        .get("jwt", {})
        .get("claims", {})
    )


def is_id_token(event):
    """True only if the presented Cognito JWT is an ID token.

    The API Gateway HTTP API JWT authorizer validates signature, issuer,
    expiry, and audience — but it accepts Cognito ACCESS tokens too, because an
    access token's ``client_id`` matches the configured audience. Access tokens
    lack ``aud`` / ``email`` / ``cognito:username`` and carry the
    ``aws.cognito.signin.user.admin`` scope, so accepting them skips audience
    validation and enables token-type confusion. This app authenticates with
    ID tokens only, so we explicitly require ``token_use == "id"``.
    """
    return _get_claims(event).get("token_use") == "id"


def get_user_id(event):
    """Extract userId from Cognito authorizer claims.

    Returns the Cognito ``sub`` ONLY for a valid ID token. For an access token
    (or any token without ``token_use == "id"``) this returns ``None`` so every
    protected handler — which already treats a missing user id as 401 — rejects
    access tokens uniformly. This closes the token_use / audience bypass.
    """
    if not is_id_token(event):
        return None
    claims = _get_claims(event)
    return claims.get("sub") or claims.get("cognito:username")


def get_user_groups(event):
    """Return the caller's Cognito groups as a list of strings.

    The ``cognito:groups`` claim arrives differently depending on the
    integration. Through the API Gateway HTTP API JWT authorizer it is a
    STRING (often bracketed, e.g. ``[admin user]`` or comma/space separated),
    while a raw decoded JWT yields a JSON list. Normalize both shapes.
    """
    raw = _get_claims(event).get("cognito:groups")
    if raw is None:
        return []
    if isinstance(raw, list):
        return [str(g).strip() for g in raw if str(g).strip()]
    s = str(raw).strip()
    if not s:
        return []
    # Strip surrounding brackets if present, then split on comma or whitespace.
    if s.startswith("[") and s.endswith("]"):
        s = s[1:-1]
    parts = [p.strip() for p in s.replace(",", " ").split()]
    return [p for p in parts if p]


def is_admin(event):
    """True only if the caller is in the Cognito ``admin`` group."""
    return "admin" in get_user_groups(event)


def require_admin(event):
    """Authorization guard for /admin/* endpoints.

    Returns an HTTP error response dict if the caller is not authorized,
    otherwise ``None``. Enforces, in order:
      1. ID-token only — reject Cognito access tokens (401).
      2. A resolvable user identity (401).
      3. Membership in the Cognito ``admin`` group (403).

    Authentication (signature/issuer/expiry/audience) is handled by the API
    Gateway JWT authorizer; this adds the token-type and role checks the
    authorizer cannot enforce.

    Usage at the top of an admin handler:
        denied = require_admin(event)
        if denied:
            return denied
    """
    if not is_id_token(event):
        return error("Unauthorized: ID token required", 401)
    if not get_user_id(event):
        return error("Unauthorized", 401)
    if not is_admin(event):
        return error("Forbidden: admin group membership required", 403)
    return None


def parse_body(event):
    """Parse JSON body from API Gateway event."""
    body = event.get("body", "{}")
    if isinstance(body, str):
        return json.loads(body) if body else {}
    return body or {}
