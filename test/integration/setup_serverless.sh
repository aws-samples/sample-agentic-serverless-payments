#!/usr/bin/env bash
# Serverless Architecture Setup Script

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
    
    if ! aws sts get-caller-identity &>/dev/null; then
        missing+=("aws-credentials")
    fi
    
    if [ ${#missing[@]} -ne 0 ]; then
        print_error "Missing: ${missing[*]}"
        exit 1
    fi
    print_success "Prerequisites satisfied"
}

validate_env() {
    print_status "Validating environment..."
    
    if [ ! -f "$PROJECT_ROOT/.env" ]; then
        print_error ".env file not found. Run: cp .env-sample .env"
        exit 1
    fi
    
    set -a && source "$PROJECT_ROOT/.env" && set +a
    
    local missing=()
    [ -z "${VITE_PAYER_WALLETCONNECT_PROJECT_ID:-}" ] && missing+=("VITE_PAYER_WALLETCONNECT_PROJECT_ID")
    [ -z "${SELLER_WALLET_ADDRESS:-}" ] && missing+=("SELLER_WALLET_ADDRESS")
    
    if [ ${#missing[@]} -ne 0 ]; then
        print_error "Missing env vars: ${missing[*]}"
        exit 1
    fi
    print_success "Environment validated"
}

deploy_serverless() {
    print_status "Installing dependencies..."
    cd "$PROJECT_ROOT"
    npm install
    
    cd "$PROJECT_ROOT/serverless"
    npm install
    
    cd "$PROJECT_ROOT/agentic/cdk"
    npm install
    
    print_status "Deploying serverless stack..."
    cd "$PROJECT_ROOT/serverless"
    
    cdk bootstrap
    npm run build
    cdk deploy --outputs-file outputs.json --require-approval never
    
    print_success "Serverless stack deployed"
}

export_outputs() {
    print_status "Exporting CDK outputs..."
    cd "$PROJECT_ROOT/serverless"
    
    chmod +x serverless-export.sh
    ./serverless-export.sh
    
    print_success "Outputs exported to .env"
}

redeploy_with_env() {
    print_status "Redeploying with environment variables..."
    cd "$PROJECT_ROOT/serverless"
    
    set -a && source "$PROJECT_ROOT/.env" && set +a
    cdk deploy --require-approval never
    
    cd "$PROJECT_ROOT"
    print_success "Redeployment complete"
}

main() {
    echo -e "${BLUE}=== Serverless Architecture Setup ===${NC}\n"
    
    check_prerequisites
    validate_env
    deploy_serverless
    export_outputs
    redeploy_with_env
    
    echo -e "\n${GREEN}✅ Serverless setup complete!${NC}"
    echo "Run 'npm run dev' from project root to start frontend locally"
}

main "$@"
