"""
Admin Lambda: Payment Connectors (Control Plane)
Routes:
  POST   /admin/connectors          → create
  GET    /admin/connectors           → list
  GET    /admin/connectors/{id}      → get (requires managerId query param)
  DELETE /admin/connectors/{id}      → delete (requires managerId query param)
"""
import sys, os, uuid
sys.path.insert(0, "/opt")  # Lambda layer
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "shared"))  # local dev

from agentcore_client import get_cp_client
from response import ok, error, parse_body, require_admin


def client_token():
    return str(uuid.uuid4()) + "-" + str(uuid.uuid4())[:8]


def handler(event, context):
    method = event.get("requestContext", {}).get("http", {}).get("method", "GET")
    path_params = event.get("pathParameters") or {}
    connector_id = path_params.get("id")
    qs = event.get("queryStringParameters") or {}

    if method == "OPTIONS":
        return ok({"message": "ok"})

    # Authorization: /admin/* requires Cognito 'admin' group membership.
    denied = require_admin(event)
    if denied:
        return denied

    cp = get_cp_client()

    try:
        if method == "POST":
            return create(cp, event)
        elif method == "GET" and connector_id:
            manager_id = qs.get("managerId")
            if not manager_id:
                return error("managerId query parameter required")
            return get_one(cp, manager_id, connector_id)
        elif method == "GET":
            return list_all(cp, qs)
        elif method == "DELETE" and connector_id:
            manager_id = qs.get("managerId")
            if not manager_id:
                return error("managerId query parameter required")
            return delete(cp, manager_id, connector_id)
        elif method == "PUT" and connector_id:
            manager_id = (qs.get("managerId") or (parse_body(event) or {}).get("paymentManagerId"))
            if not manager_id:
                return error("managerId is required (query param or body)")
            return update(cp, manager_id, connector_id, event)
        else:
            return error("Method not allowed", 405)
    except Exception as e:
        return error(str(e), 500)


def create(cp, event):
    body = parse_body(event)
    manager_id = body.get("paymentManagerId")
    name = body.get("name")
    cred_arn = body.get("credentialProviderArn")
    if not manager_id or not name or not cred_arn:
        return error("paymentManagerId, name, and credentialProviderArn are required")

    desc = body.get("description")
    connector_type = body.get("type", "CoinbaseCDP")

    # The credentialProviderConfigurations key depends on the vendor type.
    # CoinbaseCDP uses `coinbaseCDP`, StripePrivy uses `stripePrivy`.
    if connector_type == "StripePrivy":
        provider_config = {"stripePrivy": {"credentialProviderArn": cred_arn}}
    elif connector_type == "CoinbaseCDP":
        provider_config = {"coinbaseCDP": {"credentialProviderArn": cred_arn}}
    else:
        return error(f"Unsupported connector type: {connector_type}")

    kwargs = dict(
        paymentManagerId=manager_id,
        name=name,
        type=connector_type,
        credentialProviderConfigurations=[provider_config],
        clientToken=client_token(),
    )
    if desc:
        kwargs["description"] = desc

    resp = cp.create_payment_connector(**kwargs)
    resp.pop("ResponseMetadata", None)
    return ok(resp, 201)


def get_one(cp, manager_id, connector_id):
    resp = cp.get_payment_connector(
        paymentManagerId=manager_id,
        paymentConnectorId=connector_id,
    )
    resp.pop("ResponseMetadata", None)
    return ok(resp)


def list_all(cp, qs):
    manager_id = qs.get("managerId")
    if not manager_id:
        return error("managerId query parameter required to list connectors")
    resp = cp.list_payment_connectors(paymentManagerId=manager_id, maxResults=20)
    resp.pop("ResponseMetadata", None)
    return ok(resp)


def delete(cp, manager_id, connector_id):
    cp.delete_payment_connector(
        paymentManagerId=manager_id,
        paymentConnectorId=connector_id,
    )
    return ok({"message": f"Deleted connector: {connector_id}"})


def update(cp, manager_id, connector_id, event):
    """Update connector metadata. The service allows description, type, and
    credentialProviderConfigurations to change — we keep the UI focused on
    description for now and pass through the rest when provided."""
    body = parse_body(event) or {}
    kwargs = {
        "paymentManagerId": manager_id,
        "paymentConnectorId": connector_id,
        "clientToken": client_token(),
    }
    if body.get("description"):
        kwargs["description"] = body["description"]
    if body.get("type"):
        kwargs["type"] = body["type"]
    # If the caller wants to repoint at a different credential provider they can
    # supply credentialProviderArn + type; we translate into the service shape.
    cred_arn = body.get("credentialProviderArn")
    conn_type = body.get("type")
    if cred_arn and conn_type:
        if conn_type == "StripePrivy":
            kwargs["credentialProviderConfigurations"] = [{"stripePrivy": {"credentialProviderArn": cred_arn}}]
        elif conn_type == "CoinbaseCDP":
            kwargs["credentialProviderConfigurations"] = [{"coinbaseCDP": {"credentialProviderArn": cred_arn}}]
    resp = cp.update_payment_connector(**kwargs)
    resp.pop("ResponseMetadata", None)
    return ok(resp)
