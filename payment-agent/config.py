"""
Centralized configuration for the Payment Agent.
All env vars, endpoints, and constants in one place.
Build: v2-solana
"""
import os

# AWS
AWS_REGION = os.environ.get("AWS_REGION", os.environ.get("AWS_DEFAULT_REGION", "us-east-1"))

# AgentCore data-plane endpoint override (optional; boto3 derives it from region)
DP_ENDPOINT = os.environ.get("DP_ENDPOINT", "")

# Voice model (Nova Sonic) for the WS voice mode
VOICE_MODEL_ID = os.environ.get("VOICE_MODEL_ID", "amazon.nova-2-sonic-v1:0")

# AgentCore Memory
MEMORY_ID = os.environ.get("BEDROCK_AGENTCORE_MEMORY_ID", os.environ.get("MEMORY_ID", ""))

# Direct Seller API (x402 sellers deployed via CDK)
SELLER_API_URL = os.environ.get("SELLER_API_URL", "")

# Agent-economy storefront API (products + x402 order endpoint + refunds)
STOREFRONT_API_URL = os.environ.get("STOREFRONT_API_URL", "")

# S3 Media Bucket (for presigned URL delivery of images/audio)
MEDIA_BUCKET = os.environ.get("MEDIA_BUCKET", "")

# S3 Library Bucket (persistent per-buyer library: saved generated images +
# purchased digital goods, keyed by Cognito sub under library/{userId}/...)
LIBRARY_BUCKET = os.environ.get("LIBRARY_BUCKET", "")
