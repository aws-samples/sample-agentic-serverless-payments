#!/usr/bin/env bash
# Cleanup Script - Delete all deployed resources

set -Eeuo pipefail
trap 'echo -e "\033[0;31m[ERROR]\033[0m Command failed: ${BASH_COMMAND} (exit $?) at line $LINENO"' ERR

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
APP_NAME="ai-content-monetization"

print_status() { echo -e "${BLUE}[INFO]${NC} $1"; }
print_success() { echo -e "${GREEN}[SUCCESS]${NC} $1"; }
print_warning() { echo -e "${YELLOW}[WARNING]${NC} $1"; }
print_error() { echo -e "${RED}[ERROR]${NC} $1"; }

delete_amplify() {
    print_status "Deleting Amplify app..."
    
    APP_ID=$(aws amplify list-apps --query "apps[?name=='$APP_NAME'].appId" --output text 2>/dev/null || true)
    
    if [ -n "$APP_ID" ] && [ "$APP_ID" != "None" ]; then
        aws amplify delete-app --app-id "$APP_ID"
        print_success "Amplify app deleted"
    else
        print_warning "No Amplify app found"
    fi
}

delete_serverless_cdk() {
    print_status "Deleting Serverless CDK stack..."
    cd "$PROJECT_ROOT/serverless"
    
    if [ -d "node_modules" ]; then
        cdk destroy --force || print_warning "Serverless CDK stack not found"
        print_success "Serverless CDK stack deleted"
    else
        print_warning "Serverless CDK not installed"
    fi
    
    cd "$PROJECT_ROOT"
}

delete_agentic_cdk() {
    print_status "Deleting Agentic CDK stack (Gateway + AgentCore Runtime + Memory)..."
    cd "$PROJECT_ROOT/agentic/cdk"
    
    if [ -d "node_modules" ]; then
        # CDK destroy handles: API Gateway, Lambda, ECR, AgentCore Runtime, AgentCore Memory
        cdk destroy --force || print_warning "Agentic CDK stack not found"
        print_success "Agentic CDK stack deleted"
    else
        print_warning "Agentic CDK not installed"
    fi
    
    cd "$PROJECT_ROOT"
}

delete_cloudwatch_logs() {
    print_status "Deleting CloudWatch log groups..."
    
    # Delete Lambda log groups (created at runtime, not by CDK)
    for prefix in "/aws/lambda/AiContent" "/aws/lambda/X402" "/aws/codebuild/X402" "/aws/bedrock-agentcore/runtimes/x402_payment_agent"; do
        log_groups=$(aws logs describe-log-groups --log-group-name-prefix "$prefix" --query 'logGroups[*].logGroupName' --output text 2>/dev/null || true)
        if [ -n "$log_groups" ] && [ "$log_groups" != "None" ]; then
            for lg in $log_groups; do
                aws logs delete-log-group --log-group-name "$lg" 2>/dev/null || true
            done
            print_success "Deleted log groups with prefix: $prefix"
        fi
    done
    
    print_success "CloudWatch log groups cleaned"
}

cleanup_local_files() {
    print_status "Cleaning up local files..."
    cd "$PROJECT_ROOT"
    
    rm -rf \
        node_modules/ \
        dist/ \
        serverless/node_modules/ \
        serverless/cdk.out/ \
        serverless/outputs.json \
        serverless/lib/*.js \
        serverless/lib/*.d.ts \
        serverless/bin/*.js \
        serverless/bin/*.d.ts \
        agentic/cdk/node_modules/ \
        agentic/cdk/cdk.out/ \
        agentic/lambda/node_modules/
    
    print_success "Local files cleaned"
}

main() {
    echo -e "${BLUE}=== Cleanup - Delete All Resources ===${NC}\n"
    
    echo "This will delete:"
    echo "1. Amplify app (if deployed)"
    echo "2. Serverless CDK stack"
    echo "3. Agentic CDK stack (includes AgentCore Runtime, Memory, ECR, Gateway)"
    echo "4. CloudWatch log groups"
    echo "5. Local build files"
    echo ""
    
    read -p "Are you sure? This cannot be undone. (y/N): " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        print_status "Cleanup cancelled"
        exit 0
    fi
    
    # Delete in reverse order of dependencies
    delete_amplify
    delete_serverless_cdk
    delete_agentic_cdk
    delete_cloudwatch_logs
    cleanup_local_files
    
    echo -e "\n${GREEN}✅ Cleanup complete!${NC}"
}

main "$@"
