#!/usr/bin/env bash
# Agentic Architecture Setup Script
# Uses CDK for reliable AgentCore Runtime deployment (replaces toolkit)

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
    
    command -v node &>/dev/null || missing+=("node")
    command -v npm &>/dev/null || missing+=("npm")
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

deploy_cdk_stack() {
    print_status "Deploying CDK stack (Gateway + AgentCore Runtime + Memory)..."
    cd "$PROJECT_ROOT/agentic/cdk"
    
    # Export env vars for CDK
    set -a && source "$PROJECT_ROOT/agentic/.env" && set +a
    
    npm install
    cdk bootstrap
    
    print_status "Deploying stack (this may take 10-15 minutes for container build)..."
    cdk deploy --require-approval never
    
    print_success "CDK stack deployed"
}

# Export outputs to .env files
export_outputs() {
    print_status "Exporting CDK outputs to .env files..."
    cd "$PROJECT_ROOT/agentic"
    
    chmod +x agentic-export.sh
    ./agentic-export.sh
    
    print_success "Outputs exported"
}

# Redeploy serverless stack with Agent Runtime ARN
redeploy_serverless() {
    print_status "Redeploying serverless stack with Agent Runtime ARN..."
    
    cd "$PROJECT_ROOT/serverless"
    set -a && source "$PROJECT_ROOT/.env" && set +a
    
    if [ -z "${AGENT_RUNTIME_ARN:-}" ]; then
        print_error "AGENT_RUNTIME_ARN not set in root .env"
        exit 1
    fi
    
    npm install
    cdk deploy --require-approval never
    
    print_success "Serverless stack redeployed"
}

main() {
    echo -e "${BLUE}=== Agentic Architecture Setup (CDK-based) ===${NC}\n"
    
    check_prerequisites
    validate_env
    deploy_cdk_stack
    export_outputs
    redeploy_serverless
    
    echo -e "\n${GREEN}✅ Agentic setup complete!${NC}"
    echo ""
    echo "Resources created:"
    echo "  - x402 Payment Gateway (API Gateway + Lambda)"
    echo "  - AgentCore Runtime (container-based)"
    echo "  - AgentCore Memory (short-term, 30-day expiry)"
    echo "  - ECR Repository for agent container"
    echo ""
    echo "Environment variables exported to:"
    echo "  - agentic/.env (GATEWAY_URL, BEDROCK_AGENTCORE_MEMORY_ID)"
    echo "  - .env (AGENT_RUNTIME_ARN)"
}

main "$@"
