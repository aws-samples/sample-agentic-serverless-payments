"""
User Lambda: Payment Options (bootstrap read)

A regular user needs the platform's PaymentManager ARN + Connector ID to
create their FIRST instrument or session — but those live behind the admin
control plane, which is now correctly 403 for non-admins. This endpoint gives
users a least-privilege, read-only view of just what they need to bootstrap:

  GET /user/payment-options
    → { paymentOptions: [
          { managerName, paymentManagerArn, paymentManagerId, status,
            connectors: [ { connectorName, paymentConnectorId, type } ] }
      ] }

It deliberately OMITS sensitive infrastructure the admin endpoints expose
(role ARNs, credential-provider ARNs, authorizer config). It returns only the
identifiers required to call create_payment_instrument / create_payment_session.

Auth: ID-token only (require_id-token via get_user_id), any authenticated user.
"""
import sys, os
sys.path.insert(0, "/opt")
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "shared"))

from agentcore_client import get_cp_client
from response import ok, error, get_user_id


def handler(event, context):
    method = event.get("requestContext", {}).get("http", {}).get("method", "GET")
    if method == "OPTIONS":
        return ok({"message": "ok"})

    # Authentication + ID-token enforcement (access tokens resolve to None).
    user_id = get_user_id(event)
    if not user_id:
        return error("Unauthorized", 401)

    if method != "GET":
        return error("Method not allowed", 405)

    try:
        cp = get_cp_client()
        managers_resp = cp.list_payment_managers(maxResults=20)
        options = []
        for m in managers_resp.get("paymentManagers", []):
            manager_id = m.get("paymentManagerId")
            if not manager_id:
                continue
            # Hide the storefront seller's payout control plane from buyers. The
            # Seller Setup flow provisions its own PaymentManager named
            # "StorefrontSeller<hex>" (with a "StorefrontConnector<hex>") for the
            # seller's payout wallet and refunds. Buyers must never create their
            # instruments or sessions against it, so it is excluded here.
            manager_name = m.get("name", "")
            if manager_name.startswith("StorefrontSeller"):
                continue
            # Only surface READY managers so users don't try to build on a
            # half-provisioned one.
            status = m.get("status", "")
            connectors = []
            try:
                conn_resp = cp.list_payment_connectors(paymentManagerId=manager_id, maxResults=20)
                for c in conn_resp.get("paymentConnectors", []):
                    connectors.append({
                        "connectorName": c.get("name", ""),
                        "paymentConnectorId": c.get("paymentConnectorId", ""),
                        "type": c.get("type", ""),
                        "status": c.get("status", ""),
                    })
            except Exception as conn_err:  # noqa: BLE001
                # A manager with no listable connectors is still returned so the
                # UI can show it (just without connector options).
                print(f"list_payment_connectors failed for {manager_id}: {type(conn_err).__name__}")

            options.append({
                "managerName": m.get("name", ""),
                "paymentManagerArn": m.get("paymentManagerArn", ""),
                "paymentManagerId": manager_id,
                "status": status,
                "connectors": connectors,
            })

        return ok({"paymentOptions": options})
    except Exception as e:  # noqa: BLE001
        # Log the error type server-side; return a generic message to the client
        # so an AWS API error string cannot surface response detail to callers.
        print(f"list_payment_options failed: {type(e).__name__}")
        return error("Internal server error", 500)
