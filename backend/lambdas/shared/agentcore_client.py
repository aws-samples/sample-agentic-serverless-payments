"""
Shared boto3 client factory for AgentCore Payments.

The bedrock-agentcore control-plane (CreatePaymentManager, ListPaymentManagers,
CreatePaymentCredentialProvider, ...) and data-plane (CreatePaymentInstrument,
ProcessPayment, ...) operations ship in the standard boto3/botocore
distribution (boto3 >= 1.42). boto3 derives the endpoint from the region.
CoinbaseCDP and StripePrivy credential providers are both created through the
same control-plane client.
"""
import os
import boto3

REGION = os.environ.get("AWS_REGION", "us-east-1")


def get_cp_client():
    """Create a Control Plane client (bedrock-agentcore-control).

    Handles payment managers, connectors, and credential providers for all
    vendors (CoinbaseCDP and StripePrivy).
    """
    return boto3.client("bedrock-agentcore-control", region_name=REGION)


def get_dp_client():
    """Create a Data Plane client (bedrock-agentcore)."""
    return boto3.client("bedrock-agentcore", region_name=REGION)
