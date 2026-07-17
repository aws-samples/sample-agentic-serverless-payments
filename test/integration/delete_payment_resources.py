#!/usr/bin/env python3
"""
Delete the runtime AgentCore Payments resources that the CDK stack does NOT own.

The stack creates IAM roles, Lambdas, tables, and buckets, but the payment
resources themselves are created at runtime:
  - admin console        -> payment managers, connectors, credential providers
  - per-user UI pages     -> payment instruments, payment sessions
  - Seller Setup          -> the seller's manager + payout instruments

CloudFormation has no knowledge of these, so `cdk destroy` leaves them behind.
This script sweeps them via the same control- and data-plane APIs the lambdas
use, in dependency order:

    instruments + sessions  ->  connectors  ->  managers  ->  credential providers

Instruments and sessions are scoped per userId (the Cognito sub), so there is no
"list everything" call. We enumerate every Cognito user in the pool plus the
seller's service userId (from the SellerConfig row) and delete under each.

ACCOUNT/REGION-WIDE WARNING: list_payment_managers and
list_payment_credential_providers return every such resource in this account and
region, not just this deploy. This is intended for a dedicated demo account.
The script refuses to run without --yes.
"""
import argparse
import os
import sys

REGION = os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION") or "us-east-1"
USER_POOL_ID = os.environ.get("COGNITO_USER_POOL_ID", "")
SELLER_CONFIG_TABLE = os.environ.get("SELLER_CONFIG_TABLE", "StorefrontSellerConfig")
SELLER_CONFIG_PK = "SELLER#default"
# Seller Setup creates the seller manager/instruments under this service userId
# (see seller-setup.mjs / payments.mjs sellerUserId fallback).
DEFAULT_SELLER_USER_IDS = ["storefront-seller"]

_counts = {"instruments": 0, "sessions": 0, "connectors": 0, "managers": 0, "providers": 0}


def _safe_delete(fn, label, **kwargs):
    """Call a delete API; tolerate already-gone resources. Returns True on a
    delete that took effect, False on skip/error."""
    try:
        fn(**kwargs)
        print(f"    deleted {label}")
        return True
    except Exception as e:  # noqa: BLE001
        msg = str(e)
        if "ResourceNotFoundException" in msg or "NotFound" in msg:
            print(f"    skip {label} (already gone)")
        else:
            print(f"    WARN could not delete {label}: {msg.splitlines()[0][:200]}")
        return False


def _paginate(list_fn, items_key, **kwargs):
    """Yield items across a paginated AgentCore list_* call (nextToken)."""
    token = None
    while True:
        if token:
            kwargs["nextToken"] = token
        try:
            resp = list_fn(**kwargs)
        except Exception as e:  # noqa: BLE001
            print(f"  WARN list failed ({items_key}): {str(e).splitlines()[0][:200]}")
            return
        for item in resp.get(items_key, []) or []:
            yield item
        token = resp.get("nextToken")
        if not token:
            return


def _collect_user_ids(cognito, ddb):
    """Every identity payment instruments/sessions could be scoped to: all
    Cognito subs in the pool plus the seller's service userId."""
    ids = set(DEFAULT_SELLER_USER_IDS)

    if USER_POOL_ID:
        try:
            token = None
            while True:
                kwargs = {"UserPoolId": USER_POOL_ID, "Limit": 60}
                if token:
                    kwargs["PaginationToken"] = token
                resp = cognito.list_users(**kwargs)
                for u in resp.get("Users", []):
                    sub = next((a["Value"] for a in u.get("Attributes", []) if a["Name"] == "sub"), "")
                    if sub:
                        ids.add(sub)
                token = resp.get("PaginationToken")
                if not token:
                    break
        except Exception as e:  # noqa: BLE001
            print(f"  WARN could not list Cognito users: {str(e).splitlines()[0][:200]}")
    else:
        print("  WARN COGNITO_USER_POOL_ID not set — buyer instruments/sessions may be missed")

    # Read the seller's service userId from the SellerConfig row (best-effort;
    # the table may already be gone if cleanup order changed).
    try:
        item = ddb.get_item(TableName=SELLER_CONFIG_TABLE, Key={"pk": {"S": SELLER_CONFIG_PK}}).get("Item")
        if item and item.get("sellerUserId", {}).get("S"):
            ids.add(item["sellerUserId"]["S"])
    except Exception as e:  # noqa: BLE001
        print(f"  note: could not read {SELLER_CONFIG_TABLE} ({str(e).splitlines()[0][:120]})")

    return ids


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--yes", action="store_true", help="confirm the account/region-wide payment sweep")
    args = parser.parse_args()
    if not args.yes:
        print("Refusing to run without --yes (this sweep is account/region-wide).")
        sys.exit(2)

    try:
        import boto3  # noqa: F401
    except ImportError:
        print("ERROR: boto3 is required. Install with: pip install 'boto3==1.43.37'")
        sys.exit(2)
    import boto3

    cp = boto3.client("bedrock-agentcore-control", region_name=REGION)
    dp = boto3.client("bedrock-agentcore", region_name=REGION)
    cognito = boto3.client("cognito-idp", region_name=REGION)
    ddb = boto3.client("dynamodb", region_name=REGION)

    # Feature-detect the payment APIs rather than parsing versions: an old
    # botocore simply won't have these operations.
    if not hasattr(cp, "list_payment_managers"):
        print("ERROR: this boto3/botocore is too old for the AgentCore Payments APIs.")
        print("       Upgrade with: pip install --upgrade 'boto3==1.43.37'")
        sys.exit(2)

    print(f"AgentCore Payments teardown (region={REGION})")
    print("  scope: ALL payment managers, connectors, credential providers, instruments,")
    print("         and sessions in this account/region.\n")

    user_ids = _collect_user_ids(cognito, ddb)
    print(f"  enumerating instruments/sessions for {len(user_ids)} user identit(y/ies)\n")

    # ── Managers (+ their connectors, instruments, sessions) ──
    for m in _paginate(cp.list_payment_managers, "paymentManagers", maxResults=50):
        manager_id = m.get("paymentManagerId")
        manager_arn = m.get("paymentManagerArn")
        if not manager_id or not manager_arn:
            continue
        print(f"manager {manager_id} ({m.get('name', '')})")

        connectors = list(_paginate(cp.list_payment_connectors, "paymentConnectors",
                                    paymentManagerId=manager_id, maxResults=50))

        # Instruments are scoped by connector + user.
        for c in connectors:
            connector_id = c.get("paymentConnectorId")
            if not connector_id:
                continue
            for uid in user_ids:
                for inst in _paginate(dp.list_payment_instruments, "paymentInstruments",
                                      paymentManagerArn=manager_arn, paymentConnectorId=connector_id,
                                      userId=uid, maxResults=50):
                    iid = inst.get("paymentInstrumentId")
                    if iid and _safe_delete(dp.delete_payment_instrument, f"instrument {iid} (user {uid})",
                                            paymentManagerArn=manager_arn, paymentConnectorId=connector_id,
                                            paymentInstrumentId=iid, userId=uid):
                        _counts["instruments"] += 1

        # Sessions are scoped by manager + user (no connector).
        for uid in user_ids:
            for sess in _paginate(dp.list_payment_sessions, "paymentSessions",
                                  paymentManagerArn=manager_arn, userId=uid, maxResults=50):
                sid = sess.get("paymentSessionId")
                if sid and _safe_delete(dp.delete_payment_session, f"session {sid} (user {uid})",
                                        paymentManagerArn=manager_arn, paymentSessionId=sid, userId=uid):
                    _counts["sessions"] += 1

        # Connectors before the manager.
        for c in connectors:
            connector_id = c.get("paymentConnectorId")
            if connector_id and _safe_delete(cp.delete_payment_connector, f"connector {connector_id}",
                                             paymentManagerId=manager_id, paymentConnectorId=connector_id):
                _counts["connectors"] += 1

        if _safe_delete(cp.delete_payment_manager, f"manager {manager_id}", paymentManagerId=manager_id):
            _counts["managers"] += 1

    # ── Credential providers (account/region-wide) ──
    # Note: ListPaymentCredentialProviders caps maxResults at 20 (unlike the
    # manager/connector lists which allow 50).
    print("credential providers")
    for p in _paginate(cp.list_payment_credential_providers, "credentialProviders", maxResults=20):
        name = p.get("name")
        if name and _safe_delete(cp.delete_payment_credential_provider, f"credential provider {name}", name=name):
            _counts["providers"] += 1

    print("\nPayment teardown summary:")
    for k in ("instruments", "sessions", "connectors", "managers", "providers"):
        print(f"  {k}: {_counts[k]}")


if __name__ == "__main__":
    main()
