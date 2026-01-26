#!/usr/bin/env bash
# Amplify Frontend Deployment Script

set -Eeuo pipefail
trap 'echo -e "\033[0;31m[ERROR]\033[0m Command failed: ${BASH_COMMAND} (exit $?) at line $LINENO"' ERR

RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m'

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
APP_NAME="ai-content-monetization"

print_status() { echo -e "${BLUE}[INFO]${NC} $1"; }
print_success() { echo -e "${GREEN}[SUCCESS]${NC} $1"; }
print_error() { echo -e "${RED}[ERROR]${NC} $1"; }

check_prerequisites() {
    print_status "Checking prerequisites..."
    local missing=()
    
    command -v aws &>/dev/null || missing+=("aws-cli")
    command -v npm &>/dev/null || missing+=("npm")
    command -v jq &>/dev/null || missing+=("jq")
    command -v zip &>/dev/null || missing+=("zip")
    command -v curl &>/dev/null || missing+=("curl")
    
    if [ ${#missing[@]} -ne 0 ]; then
        print_error "Missing: ${missing[*]}"
        exit 1
    fi
    print_success "Prerequisites satisfied"
}

validate_env() {
    print_status "Validating environment..."
    cd "$PROJECT_ROOT"
    
    if [ ! -f ".env" ]; then
        print_error ".env file not found"
        exit 1
    fi
    
    set -a && source .env && set +a
    
    local missing=()
    [ -z "${VITE_AWS_API_GATEWAY_HTTP_URL:-}" ] && missing+=("VITE_AWS_API_GATEWAY_HTTP_URL")
    [ -z "${VITE_AWS_API_GATEWAY_WEBSOCKET_URL:-}" ] && missing+=("VITE_AWS_API_GATEWAY_WEBSOCKET_URL")
    [ -z "${VITE_PAYER_WALLETCONNECT_PROJECT_ID:-}" ] && missing+=("VITE_PAYER_WALLETCONNECT_PROJECT_ID")
    
    if [ ${#missing[@]} -ne 0 ]; then
        print_error "Missing env vars: ${missing[*]}"
        print_error "Run setup_serverless.sh first"
        exit 1
    fi
    print_success "Environment validated"
}

build_frontend() {
    print_status "Building frontend..."
    cd "$PROJECT_ROOT"
    
    npm install
    npm run build
    
    print_success "Frontend built"
}

deploy_amplify() {
    print_status "Deploying to Amplify..."
    cd "$PROJECT_ROOT"
    
    set -a && source .env && set +a
    
    # Create Amplify app
    APP_ID=$(aws amplify create-app --name "$APP_NAME" --query 'app.appId' --output text --no-cli-pager)
    echo "App ID: $APP_ID"
    
    # Set environment variables
    aws amplify update-app --app-id "$APP_ID" --environment-variables \
        "VITE_AWS_API_GATEWAY_HTTP_URL=$VITE_AWS_API_GATEWAY_HTTP_URL,VITE_AWS_API_GATEWAY_WEBSOCKET_URL=$VITE_AWS_API_GATEWAY_WEBSOCKET_URL,VITE_PAYER_WALLETCONNECT_PROJECT_ID=$VITE_PAYER_WALLETCONNECT_PROJECT_ID" --no-cli-pager
    
    # Create branch
    aws amplify create-branch --app-id "$APP_ID" --branch-name main --no-cli-pager
    
    # Create deployment
    DEPLOYMENT=$(aws amplify create-deployment --app-id "$APP_ID" --branch-name main --no-cli-pager)
    JOB_ID=$(echo "$DEPLOYMENT" | jq -r '.jobId')
    UPLOAD_URL=$(echo "$DEPLOYMENT" | jq -r '.zipUploadUrl')
    
    # Zip and upload
    cd dist && zip -r ../deploy.zip . && cd ..
    curl -s -T deploy.zip "$UPLOAD_URL"
    
    # Start deployment
    aws amplify start-deployment --app-id "$APP_ID" --branch-name main --job-id "$JOB_ID" --no-cli-pager
    
    # Cleanup
    rm deploy.zip
    
    print_success "Deployed to: https://main.$APP_ID.amplifyapp.com"
}

main() {
    echo -e "${BLUE}=== Amplify Frontend Deployment ===${NC}\n"
    
    check_prerequisites
    validate_env
    build_frontend
    deploy_amplify
    
    echo -e "\n${GREEN}✅ Amplify deployment complete!${NC}"
}

main "$@"
