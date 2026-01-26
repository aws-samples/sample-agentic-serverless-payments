#!/usr/bin/env bash
# End-to-End Setup Script - Quick Start

set -Eeuo pipefail
trap 'echo -e "\033[0;31m[ERROR]\033[0m Command failed: ${BASH_COMMAND} (exit $?) at line $LINENO"' ERR

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

print_status() { echo -e "${BLUE}[INFO]${NC} $1"; }
print_success() { echo -e "${GREEN}[SUCCESS]${NC} $1"; }
print_warning() { echo -e "${YELLOW}[WARNING]${NC} $1"; }
print_error() { echo -e "${RED}[ERROR]${NC} $1"; }

print_header() {
    echo -e "\n${BLUE}================================${NC}"
    echo -e "${BLUE} $1${NC}"
    echo -e "${BLUE}================================${NC}\n"
}

check_env_files() {
    print_status "Checking environment files..."
    
    if [ ! -f "$PROJECT_ROOT/.env" ]; then
        print_error "Root .env file not found"
        echo "Run: cp .env-sample .env and configure required values"
        exit 1
    fi
    
    if [ ! -f "$PROJECT_ROOT/agentic/.env" ]; then
        print_error "agentic/.env file not found"
        echo "Run: cd agentic && cp .env-sample .env and configure required values"
        exit 1
    fi
    
    print_success "Environment files found"
}

run_serverless_setup() {
    print_header "Step 1: Serverless Architecture"
    chmod +x "$SCRIPT_DIR/setup_serverless.sh"
    "$SCRIPT_DIR/setup_serverless.sh"
}

run_agentic_setup() {
    print_header "Step 2: Agentic Architecture"
    chmod +x "$SCRIPT_DIR/setup_agentic.sh"
    "$SCRIPT_DIR/setup_agentic.sh"
}

run_amplify_setup() {
    print_header "Step 3: Amplify Deployment"
    chmod +x "$SCRIPT_DIR/setup_amplify.sh"
    "$SCRIPT_DIR/setup_amplify.sh"
}

display_summary() {
    print_header "Setup Complete!"
    
    set -a && source "$PROJECT_ROOT/.env" && set +a
    
    echo -e "${GREEN}🎉 Your AI Content Monetization Platform is ready!${NC}\n"
    
    echo -e "${BLUE}📋 Endpoints:${NC}"
    echo "• HTTP API: ${VITE_AWS_API_GATEWAY_HTTP_URL:-Not set}"
    echo "• WebSocket: ${VITE_AWS_API_GATEWAY_WEBSOCKET_URL:-Not set}"
    
    echo -e "\n${BLUE}🚀 Next Steps:${NC}"
    echo "1. Ensure you have USDC on Base Sepolia (https://faucet.circle.com/)"
    echo "2. Access your deployed frontend or run 'npm run dev' locally"
    echo "3. Connect your wallet and start generating content!"
    
    echo -e "\n${GREEN}✅ All components deployed successfully!${NC}"
}

main() {
    print_header "AI Content Monetization - Full Setup"
    
    echo "This script will deploy:"
    echo "1. Serverless architecture (CDK stack)"
    echo "2. Agentic architecture (AgentCore + Gateway)"
    echo "3. Amplify frontend (optional)"
    echo ""
    
    read -p "Continue with full setup? (y/N): " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        print_status "Setup cancelled"
        exit 0
    fi
    
    check_env_files
    run_serverless_setup
    run_agentic_setup
    
    read -p "Deploy frontend to Amplify? (y/N): " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        run_amplify_setup
    else
        print_warning "Skipping Amplify. Run 'npm run dev' for local frontend."
    fi
    
    display_summary
}

main "$@"
