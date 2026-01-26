#!/bin/bash

# Export CDK stack outputs to agentic .env file
STACK_NAME="X402GatewayStack"
ENV_FILE=".env"

echo "Fetching CDK outputs from $STACK_NAME..."

# Get stack outputs
GATEWAY_URL=$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" \
  --query "Stacks[0].Outputs[?OutputKey=='ApiUrl'].OutputValue" --output text)

if [ -z "$GATEWAY_URL" ] || [ "$GATEWAY_URL" == "None" ]; then
  echo "Error: Could not retrieve stack outputs. Ensure the stack is deployed."
  exit 1
fi

# Remove trailing slash
GATEWAY_URL="${GATEWAY_URL%/}"

echo "Retrieved outputs:"
echo "  GATEWAY_URL: $GATEWAY_URL"

# Check if .env exists
if [ ! -f "$ENV_FILE" ]; then
  echo "Error: $ENV_FILE not found. Run 'cp .env.sample .env' first."
  exit 1
fi

# Update .env file
if grep -q "^GATEWAY_URL=" "$ENV_FILE"; then
  sed -i.bak "s|^GATEWAY_URL=.*|GATEWAY_URL=${GATEWAY_URL}|" "$ENV_FILE"
else
  echo "GATEWAY_URL=${GATEWAY_URL}" >> "$ENV_FILE"
fi

rm -f "${ENV_FILE}.bak"

echo ""
echo "GATEWAY_URL exported to $ENV_FILE"
