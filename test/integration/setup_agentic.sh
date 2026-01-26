#!/usr/bin/env bash
# Agentic Architecture Setup Script
# Follows README manual steps 5.1-5.9 exactly

set -Eeuo pipefail
trap 'echo -e "\033[0;31m[ERROR]\033[0m Command failed: ${BASH_COMMAND} (exit $?) at line $LINENO"' ERR

RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m'

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

print_status() { echo -e "${BLUE}[INFO]${NC} $1"; }
print_success() { echo -e "${GREEN}[SUCCESS]${NC} $1"; }
print_error() { echo -e "${RED}[ERROR]${NC} $1"; }

check_prerequisites() {
    print_status "Checking prerequisites..."
    local missing=()
    
    command -v python3.11 &>/dev/null || missing+=("python3.11")
    command -v aws &>/dev/null || missing+=("aws-cli")
    command -v cdk &>/dev/null || missing+=("aws-cdk")
    
    if [ ${#missing[@]} -ne 0 ]; then
        print_error "Missing: ${missing[*]}"
        exit 1
    fi
    print_success "Prerequisites satisfied"
}

validate_env() {
    print_status "Validating agentic environment..."
    
    if [ ! -f "$PROJECT_ROOT/agentic/.env" ]; then
        print_error "agentic/.env not found. Run: cd agentic && cp .env-sample .env"
        exit 1
    fi
    
    set -a && source "$PROJECT_ROOT/agentic/.env" && set +a
    
    local missing=()
    [ -z "${CDP_API_KEY_ID:-}" ] && missing+=("CDP_API_KEY_ID")
    [ -z "${CDP_API_KEY_SECRET:-}" ] && missing+=("CDP_API_KEY_SECRET")
    [ -z "${CDP_WALLET_SECRET:-}" ] && missing+=("CDP_WALLET_SECRET")
    [ -z "${SELLER_WALLET:-}" ] && missing+=("SELLER_WALLET")
    
    if [ ${#missing[@]} -ne 0 ]; then
        print_error "Missing env vars in agentic/.env: ${missing[*]}"
        exit 1
    fi
    print_success "Environment validated"
}

cleanup_previous_state() {
    print_status "Cleaning up previous AgentCore state..."
    cd "$PROJECT_ROOT/agentic"
    
    rm -rf .bedrock_agentcore .bedrock_agentcore.yaml venv 2>/dev/null || true
    
    print_success "Previous state cleaned"
}

# Step 5.1
deploy_gateway() {
    print_status "Step 5.1: Deploying x402 Payment Gateway..."
    cd "$PROJECT_ROOT/agentic/cdk"
    
    npm install
    cdk bootstrap
    cdk deploy --require-approval never
    
    print_success "Gateway deployed"
}

# Step 5.2
export_gateway_url() {
    print_status "Step 5.2: Exporting Gateway URL..."
    cd "$PROJECT_ROOT/agentic"
    
    chmod +x agentic-export.sh
    ./agentic-export.sh
    
    print_success "Gateway URL exported"
}

# Step 5.3
setup_python_env() {
    print_status "Step 5.3: Setting up Python environment..."
    cd "$PROJECT_ROOT/agentic"
    
    python3.11 -m venv venv
    source venv/bin/activate
    pip install --upgrade pip
    pip install bedrock-agentcore strands-agents bedrock-agentcore-starter-toolkit
    
    print_success "Python environment ready"
}

# Step 5.4
create_runtime_role() {
    print_status "Step 5.4: Creating Runtime Role..."
    
    ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
    UNIQUE_ID=$(openssl rand -hex 4)
    
    aws iam create-role \
        --role-name "AmazonBedrockAgentCoreSDKRuntime-us-east-1-${UNIQUE_ID}" \
        --assume-role-policy-document '{
            "Version": "2012-10-17",
            "Statement": [{
                "Effect": "Allow",
                "Principal": {"Service": "bedrock-agentcore.amazonaws.com"},
                "Action": "sts:AssumeRole"
            }]
        }'
    
    echo "UNIQUE_ID: ${UNIQUE_ID}"
    export ACCOUNT_ID UNIQUE_ID
    
    print_success "Runtime role created"
}

# Step 5.5
add_runtime_role_permissions() {
    print_status "Step 5.5: Adding Runtime Role Permissions..."
    
    aws iam put-role-policy \
        --role-name "AmazonBedrockAgentCoreSDKRuntime-us-east-1-${UNIQUE_ID}" \
        --policy-name ECRAccess \
        --policy-document '{
            "Version": "2012-10-17",
            "Statement": [{
                "Effect": "Allow",
                "Action": ["ecr:GetAuthorizationToken"],
                "Resource": "*"
            },
            {
                "Effect": "Allow",
                "Action": ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"],
                "Resource": "arn:aws:ecr:us-east-1:*:repository/bedrock-agentcore-*"
            }]
        }'
    
    print_success "Runtime role permissions added"
}

# Step 5.6
configure_agentcore() {
    print_status "Step 5.6: Configuring AgentCore..."
    cd "$PROJECT_ROOT/agentic"
    source venv/bin/activate
    
    agentcore configure \
        --entrypoint agent.py \
        --deployment-type container \
        --ecr auto \
        --execution-role "arn:aws:iam::${ACCOUNT_ID}:role/AmazonBedrockAgentCoreSDKRuntime-us-east-1-${UNIQUE_ID}" \
        --region us-east-1 \
        --non-interactive
    
    print_success "AgentCore configured"
}

# Step 5.7
deploy_agent() {
    print_status "Step 5.7: Deploying agent..."
    cd "$PROJECT_ROOT/agentic"
    source venv/bin/activate
    
    cp dockerfile-sample .bedrock_agentcore/agent/Dockerfile
    export $(grep -v '^#' .env | xargs)
    
    # Try up to 3 times (CodeBuild can be flaky)
    for attempt in 1 2 3; do
        print_status "Deployment attempt $attempt..."
        if agentcore deploy \
            --env CDP_API_KEY_ID="$CDP_API_KEY_ID" \
            --env CDP_API_KEY_SECRET="$CDP_API_KEY_SECRET" \
            --env CDP_WALLET_SECRET="$CDP_WALLET_SECRET" \
            --env NETWORK_ID="$NETWORK_ID" \
            --env RPC_URL="$RPC_URL" \
            --env USDC_CONTRACT="$USDC_CONTRACT" \
            --env SELLER_WALLET="$SELLER_WALLET" \
            --env GATEWAY_URL="$GATEWAY_URL" \
            --env AWS_REGION="$AWS_REGION"; then
            print_success "Agent deployed"
            return 0
        fi
        
        if [ $attempt -lt 3 ]; then
            print_status "Retrying in 5 seconds..."
            sleep 5
        fi
    done
    
    print_error "Agent deployment failed after 3 attempts"
    exit 1
}

# Step 5.8
add_iam_permissions() {
    print_status "Step 5.8: Adding IAM permissions..."
    cd "$PROJECT_ROOT/agentic"
    
    ROLE_NAME=$(grep 'execution_role:' .bedrock_agentcore.yaml | head -1 | sed 's/.*role\///')
    
    aws iam attach-role-policy \
        --role-name "$ROLE_NAME" \
        --policy-arn arn:aws:iam::aws:policy/AmazonBedrockFullAccess
    
    aws iam put-role-policy \
        --role-name "$ROLE_NAME" \
        --policy-name AgentCoreMemoryAccess \
        --policy-document '{
            "Version": "2012-10-17",
            "Statement": [{
                "Effect": "Allow",
                "Action": [
                    "bedrock-agentcore:ListEvents",
                    "bedrock-agentcore:CreateEvent",
                    "bedrock-agentcore:GetEvent",
                    "bedrock-agentcore:DeleteEvent",
                    "bedrock-agentcore:ListMemories",
                    "bedrock-agentcore:GetMemory"
                ],
                "Resource": "arn:aws:bedrock-agentcore:us-east-1:*:memory/*"
            }]
        }'
    
    print_success "IAM permissions added"
}

# Step 5.9
export_agent_arn() {
    print_status "Step 5.9: Exporting Agent Runtime ARN and redeploying serverless..."
    cd "$PROJECT_ROOT/agentic"
    
    AGENT_RUNTIME_ARN=$(grep 'agent_arn:' .bedrock_agentcore.yaml | awk '{print $2}')
    echo "Agent ARN: $AGENT_RUNTIME_ARN"
    
    cd "$PROJECT_ROOT"
    sed -i '' "s|^AGENT_RUNTIME_ARN=.*|AGENT_RUNTIME_ARN=$AGENT_RUNTIME_ARN|" .env
    
    cd "$PROJECT_ROOT/serverless"
    set -a && source "$PROJECT_ROOT/.env" && set +a
    cdk deploy --require-approval never
    
    cd "$PROJECT_ROOT"
    print_success "Agent ARN exported and serverless redeployed"
}

main() {
    echo -e "${BLUE}=== Agentic Architecture Setup ===${NC}\n"
    
    check_prerequisites
    validate_env
    cleanup_previous_state
    deploy_gateway
    export_gateway_url
    setup_python_env
    create_runtime_role
    add_runtime_role_permissions
    configure_agentcore
    deploy_agent
    add_iam_permissions
    export_agent_arn
    
    echo -e "\n${GREEN}✅ Agentic setup complete!${NC}"
}

main "$@"
