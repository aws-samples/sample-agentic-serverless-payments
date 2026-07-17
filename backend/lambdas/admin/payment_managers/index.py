"""
Admin Lambda: Payment Managers (Control Plane)
Routes:
  POST   /admin/managers          → create
  GET    /admin/managers           → list
  GET    /admin/managers/{id}      → get
  PUT    /admin/managers/{id}      → update
  DELETE /admin/managers/{id}      → delete
"""
import sys, os, uuid
sys.path.insert(0, "/opt")  # Lambda layer
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "shared"))  # local dev

from agentcore_client import get_cp_client
from response import ok, error, parse_body, require_admin

ROLE_ARN = os.environ.get("PAYMENT_MANAGER_ROLE_ARN", "")


def client_token():
    return str(uuid.uuid4()) + "-" + str(uuid.uuid4())[:8]


def handler(event, context):
    method = event.get("requestContext", {}).get("http", {}).get("method", "GET")
    path_params = event.get("pathParameters") or {}
    manager_id = path_params.get("id")

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
        elif method == "GET" and manager_id:
            return get_one(cp, manager_id)
        elif method == "GET":
            return list_all(cp)
        elif method == "PUT" and manager_id:
            return update(cp, manager_id, event)
        elif method == "DELETE" and manager_id:
            return delete(cp, manager_id)
        else:
            return error("Method not allowed", 405)
    except Exception as e:
        # Log detail server-side (CloudWatch); return a generic message to the
        # client so raw internal exception details are not exposed to callers.
        print(f"payment_managers handler error: {type(e).__name__}: {e}")
        return error("Internal server error", 500)


def create(cp, event):
    body = parse_body(event)
    name = body.get("name")
    if not name:
        return error("name is required")

    kwargs = dict(
        name=name,
        authorizerType="AWS_IAM",
        roleArn=ROLE_ARN,
        clientToken=client_token(),
    )
    if body.get("description"):
        kwargs["description"] = body["description"]

    resp = cp.create_payment_manager(**kwargs)
    resp.pop("ResponseMetadata", None)
    return ok(resp, 201)


def get_one(cp, manager_id):
    resp = cp.get_payment_manager(paymentManagerId=manager_id)
    resp.pop("ResponseMetadata", None)
    return ok(resp)


def list_all(cp):
    resp = cp.list_payment_managers(maxResults=20)
    resp.pop("ResponseMetadata", None)
    return ok(resp)


def update(cp, manager_id, event):
    body = parse_body(event)
    kwargs = {"paymentManagerId": manager_id}
    if body.get("description"):
        kwargs["description"] = body["description"]
    resp = cp.update_payment_manager(**kwargs)
    resp.pop("ResponseMetadata", None)
    return ok(resp)


def delete(cp, manager_id):
    cp.delete_payment_manager(paymentManagerId=manager_id)
    return ok({"message": f"Deleted payment manager: {manager_id}"})
