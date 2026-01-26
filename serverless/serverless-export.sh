#!/bin/bash

# Export CDK stack outputs to .env file and update Lambda environment variables
STACK_NAME="AiContentMonetizationStack"
ENV_FILE="../.env"

echo "Fetching CDK outputs from $STACK_NAME..."

# Get stack outputs
HTTP_API_URL=$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" \
  --query "Stacks[0].Outputs[?OutputKey=='HttpApiUrl'].OutputValue" --output text)
WEBSOCKET_URL=$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" \
  --query "Stacks[0].Outputs[?OutputKey=='WebSocketUrl'].OutputValue" --output text)

if [ -z "$HTTP_API_URL" ] || [ "$HTTP_API_URL" == "None" ]; then
  echo "Error: Could not retrieve stack outputs. Ensure the stack is deployed."
  exit 1
fi

# Remove trailing slash for API_GATEWAY_HTTP_URL
API_GATEWAY_HTTP_URL="${HTTP_API_URL%/}"

echo "Retrieved outputs:"
echo "  HTTP API URL: $HTTP_API_URL"
echo "  WebSocket URL: $WEBSOCKET_URL"
echo "  API Gateway HTTP URL (no trailing slash): $API_GATEWAY_HTTP_URL"

# Check if .env exists
if [ ! -f "$ENV_FILE" ]; then
  echo "Error: $ENV_FILE not found. Run 'cp .env-sample .env' first."
  exit 1
fi

# Update .env file - replace or append values
update_env_var() {
  local key=$1
  local value=$2
  if grep -q "^${key}=" "$ENV_FILE"; then
    # Replace existing value
    sed -i.bak "s|^${key}=.*|${key}=${value}|" "$ENV_FILE"
  else
    # Append new value
    echo "${key}=${value}" >> "$ENV_FILE"
  fi
}

update_env_var "VITE_AWS_API_GATEWAY_HTTP_URL" "$HTTP_API_URL"
update_env_var "VITE_AWS_API_GATEWAY_WEBSOCKET_URL" "$WEBSOCKET_URL"
update_env_var "API_GATEWAY_HTTP_URL" "$API_GATEWAY_HTTP_URL"

# Clean up backup file created by sed
rm -f "${ENV_FILE}.bak"

echo ""
echo "Environment variables exported to $ENV_FILE"
echo ""
echo "Next steps:"
echo "  1. Redeploy CDK to update Lambda environment variables:"
echo "     set -a && source ../.env && set +a && cdk deploy && cd .."
echo ""
