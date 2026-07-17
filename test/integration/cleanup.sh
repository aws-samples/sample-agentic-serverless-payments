#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────
# Cleanup Script — Delete all deployed resources
# Uses AMPLIFY_APP_ID from .env (saved by setup_amplify.sh) to
# target the exact Amplify app instead of searching by name.
# ─────────────────────────────────────────────────────────────────
set -Eeuo pipefail
trap 'echo -e "\033[0;31m[ERROR]\033[0m Command failed: ${BASH_COMMAND} (exit $?) at line $LINENO"' ERR

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
APP_NAME="agentcore-payments"
CDK_STACK_NAME="PaymentAgentStack"

print_status() { echo -e "${BLUE}[INFO]${NC} $1"; }
print_success() { echo -e "${GREEN}[SUCCESS]${NC} $1"; }
print_warning() { echo -e "${YELLOW}[WARNING]${NC} $1"; }
print_error() { echo -e "${RED}[ERROR]${NC} $1"; }

load_env() {
  cd "$PROJECT_ROOT"
  if [ -f ".env" ]; then
    set -a && source .env && set +a
  fi
}

delete_amplify() {
  print_status "Deleting Amplify app..."

  # Prefer the saved AMPLIFY_APP_ID from .env (set by setup_amplify.sh)
  local app_id="${AMPLIFY_APP_ID:-}"

  # Fallback: search by name if AMPLIFY_APP_ID not in .env
  if [ -z "$app_id" ] || [ "$app_id" = "None" ]; then
    app_id=$(aws amplify list-apps \
      --query "apps[?name=='$APP_NAME'].appId | [0]" \
      --output text 2>/dev/null || true)
  fi

  if [ -n "$app_id" ] && [ "$app_id" != "None" ] && [ "$app_id" != "null" ]; then
    aws amplify delete-app --app-id "$app_id" --no-cli-pager 2>/dev/null || true
    print_success "Amplify app deleted ($app_id)"

    # Remove AMPLIFY_APP_ID from .env
    local env_file="$PROJECT_ROOT/.env"
    if [ -f "$env_file" ]; then
      if [[ "$OSTYPE" == "darwin"* ]]; then
        sed -i '' '/^AMPLIFY_APP_ID=/d' "$env_file"
      else
        sed -i '/^AMPLIFY_APP_ID=/d' "$env_file"
      fi
    fi
  else
    print_warning "No Amplify app found (checked AMPLIFY_APP_ID and name='$APP_NAME')"
  fi
}

# Delete runtime AgentCore Payments resources (managers, connectors, credential
# providers, instruments, sessions) that the CDK stack does not own. Runs BEFORE
# the stack destroy so the SellerConfig table and Cognito pool are still
# readable for resource enumeration. Account/region-wide, so it gets its own
# explicit confirmation.
delete_payment_resources() {
  print_status "Deleting runtime AgentCore Payments resources..."

  local script="$PROJECT_ROOT/test/integration/delete_payment_resources.py"
  if [ ! -f "$script" ]; then
    print_warning "delete_payment_resources.py not found — skipping payment resource teardown"
    return
  fi

  print_warning "This sweeps ALL AgentCore Payments managers, connectors, credential"
  print_warning "providers, instruments, and sessions in account $AWS_ACCOUNT_ID / region $AWS_REGION,"
  print_warning "not just this deploy. Intended for a dedicated demo account."
  read -p "Delete payment resources? (y/N): " -n 1 -r
  echo
  if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    print_status "Payment resource teardown skipped"
    return
  fi

  # Pick a Python interpreter (same preference order as setup_backend.sh).
  local py=""
  for cand in python3.12 python3.11 python3.10 python3; do
    if command -v "$cand" &>/dev/null; then py="$cand"; break; fi
  done
  if [ -z "$py" ]; then
    print_warning "No python3 found — skipping payment resource teardown"
    return
  fi

  # The script reads AWS_REGION / COGNITO_USER_POOL_ID from the environment
  # (load_env sourced .env above). --yes confirms the account-wide sweep.
  "$py" "$script" --yes || print_warning "Payment resource teardown reported errors; continuing"
  print_success "Payment resources processed"
}

delete_cdk_stack() {
  print_status "Deleting CDK stack ($CDK_STACK_NAME)..."
  cd "$PROJECT_ROOT/backend"

  if [ -d "node_modules" ]; then
    npx cdk destroy --force 2>/dev/null || print_warning "CDK stack not found or already deleted"
    print_success "CDK stack deleted"
  else
    # Try without node_modules — maybe user wants to clean up without reinstalling
    print_warning "Backend node_modules not found — attempting CloudFormation delete directly..."
    aws cloudformation delete-stack --stack-name "$CDK_STACK_NAME" 2>/dev/null || true
    aws cloudformation wait stack-delete-complete --stack-name "$CDK_STACK_NAME" 2>/dev/null || true
    print_success "CDK stack deleted via CloudFormation"
  fi

  cd "$PROJECT_ROOT"
}

delete_cloudwatch_logs() {
  print_status "Deleting CloudWatch log groups..."

  # Lambda log groups are created on first invocation (or as CDK-managed
  # resources) and can outlive `cdk destroy`. Deleting them here lets a later
  # redeploy recreate them without an "already exists" conflict. Prefixes cover
  # every function in the stack:
  #   /aws/lambda/agentcore-payments  → post-confirm, build-trigger,
  #       credential-providers, managers, connectors, instruments, sessions,
  #       agent-ws, payment-options
  #   /aws/lambda/x402                 → image-gen + all storefront lambdas
  #       (products, orders, seller-setup, library, seed)
  for prefix in \
    "/aws/lambda/agentcore-payments" \
    "/aws/lambda/x402" \
    "/aws/codebuild/agentcore-payments" \
    "/aws/bedrock-agentcore/runtimes"; do

    log_groups=$(aws logs describe-log-groups \
      --log-group-name-prefix "$prefix" \
      --query 'logGroups[*].logGroupName' \
      --output text 2>/dev/null || true)

    if [ -n "$log_groups" ] && [ "$log_groups" != "None" ]; then
      for lg in $log_groups; do
        aws logs delete-log-group --log-group-name "$lg" 2>/dev/null || true
      done
      print_success "Deleted log groups with prefix: $prefix"
    fi
  done

  print_success "CloudWatch log groups cleaned"
}

delete_ecr_repo() {
  print_status "Deleting ECR repository (if orphaned)..."
  aws ecr delete-repository \
    --repository-name agentcore-payments-agent \
    --force 2>/dev/null || true
  print_success "ECR repository cleaned"
}

cleanup_local_files() {
  print_status "Cleaning up local build artifacts..."
  cd "$PROJECT_ROOT"

  rm -rf \
    frontend/dist/ \
    frontend/node_modules/ \
    backend/cdk.out/ \
    backend/node_modules/ \
    backend/lib/*.js \
    backend/lib/*.d.ts \
    backend/bin/*.js \
    backend/bin/*.d.ts \
    cdk-outputs.json \
    deploy.zip

  print_success "Local files cleaned"
}

# The demo admin credentials secret is a stack resource, so `cdk destroy` already
# schedules its deletion. Force-delete it (no recovery window) so a destroy +
# redeploy reproducibility test starts clean. Best-effort; uses ADMIN_SECRET_NAME
# from .env when present.
delete_admin_secret() {
  local secret_name="${ADMIN_SECRET_NAME:-}"
  [ -z "$secret_name" ] && return
  print_status "Force-deleting demo admin credentials secret..."
  aws secretsmanager delete-secret \
    --secret-id "$secret_name" \
    --force-delete-without-recovery 2>/dev/null || true
  print_success "Admin credentials secret removed"
}

main() {
  echo -e "${BLUE}=== Cleanup — Delete All Resources ===${NC}\n"

  echo "This will delete:"
  echo "  1. Amplify app (using saved AMPLIFY_APP_ID or name lookup)"
  echo "  2. Runtime AgentCore Payments resources (managers, connectors,"
  echo "     credential providers, instruments, sessions) — separate confirm"
  echo "  3. CDK stack ($CDK_STACK_NAME)"
  echo "  4. CloudWatch log groups"
  echo "  5. ECR repository (if orphaned)"
  echo "  6. Local build artifacts"
  echo ""
  read -p "Are you sure? This cannot be undone. (y/N): " -n 1 -r
  echo

  if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    print_status "Cleanup cancelled"
    exit 0
  fi

  load_env

  # Delete in reverse order of dependencies
  delete_amplify
  delete_payment_resources
  delete_cdk_stack
  delete_admin_secret
  delete_cloudwatch_logs
  delete_ecr_repo
  cleanup_local_files

  echo -e "\n${GREEN}✅ Cleanup complete!${NC}"
  echo -e "${YELLOW}Note:${NC} Runtime AgentCore Payments resources (managers, connectors,"
  echo -e "credential providers, instruments, sessions) are removed by the payment"
  echo -e "teardown step above when confirmed. If you skipped it, delete them via the"
  echo -e "AWS console/CLI or re-run cleanup, since they are not part of the CDK stack."
}

main "$@"
