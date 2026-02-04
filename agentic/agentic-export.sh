#!/bin/bash

# Export CDK stack outputs to agentic .env file and root .env file
STACK_NAME="X402GatewayStack"
ENV_FILE=".env"
ROOT_ENV_FILE="../.env"

echo "Fetching CDK outputs from $STACK_NAME..."

# Get stack outputs
GATEWAY_URL=$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" \
  --query "Stacks[0].Outputs[?OutputKey=='ApiUrl'].OutputValue" --output text)

MEMORY_ID=$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" \
  --query "Stacks[0].Outputs[?OutputKey=='MemoryId'].OutputValue" --output text)

AGENT_RUNTIME_ARN=$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" \
  --query "Stacks[0].Outputs[?OutputKey=='AgentRuntimeArn'].OutputValue" --output text)

if [ -z "$GATEWAY_URL" ] || [ "$GATEWAY_URL" == "None" ]; then
  echo "Error: Could not retrieve GATEWAY_URL. Ensure the stack is deployed."
  exit 1
fi

# Remove trailing slash from GATEWAY_URL
GATEWAY_URL="${GATEWAY_URL%/}"

echo "Retrieved outputs:"
echo "  GATEWAY_URL: $GATEWAY_URL"
echo "  BEDROCK_AGENTCORE_MEMORY_ID: $MEMORY_ID"
echo "  AGENT_RUNTIME_ARN: $AGENT_RUNTIME_ARN"

# Check if .env exists
if [ ! -f "$ENV_FILE" ]; then
  echo "Error: $ENV_FILE not found. Run 'cp .env-sample .env' first."
  exit 1
fi

# Update agentic/.env file
update_env_var() {
  local file=$1
  local key=$2
  local value=$3
  
  if grep -q "^${key}=" "$file" 2>/dev/null; then
    sed -i.bak "s|^${key}=.*|${key}=${value}|" "$file"
  else
    echo "${key}=${value}" >> "$file"
  fi
}

# Update GATEWAY_URL in agentic/.env
update_env_var "$ENV_FILE" "GATEWAY_URL" "$GATEWAY_URL"

# Update BEDROCK_AGENTCORE_MEMORY_ID in agentic/.env
if [ -n "$MEMORY_ID" ] && [ "$MEMORY_ID" != "None" ]; then
  update_env_var "$ENV_FILE" "BEDROCK_AGENTCORE_MEMORY_ID" "$MEMORY_ID"
fi

# Update AGENT_RUNTIME_ARN in root .env (for serverless stack)
if [ -n "$AGENT_RUNTIME_ARN" ] && [ "$AGENT_RUNTIME_ARN" != "None" ]; then
  if [ -f "$ROOT_ENV_FILE" ]; then
    update_env_var "$ROOT_ENV_FILE" "AGENT_RUNTIME_ARN" "$AGENT_RUNTIME_ARN"
    echo ""
    echo "AGENT_RUNTIME_ARN exported to $ROOT_ENV_FILE"
  else
    echo "Warning: $ROOT_ENV_FILE not found. AGENT_RUNTIME_ARN not exported to root."
  fi
fi

# Clean up backup files
rm -f "${ENV_FILE}.bak" "${ROOT_ENV_FILE}.bak" 2>/dev/null

echo ""
echo "GATEWAY_URL and BEDROCK_AGENTCORE_MEMORY_ID exported to $ENV_FILE"
