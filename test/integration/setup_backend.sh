#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────
# Backend Setup Script — Clean repo → fully deployed stack
# Handles: .env creation, npm installs (backend + seller lambdas),
#          CDK bootstrap, CDK deploy, and .env injection of outputs.
# ─────────────────────────────────────────────────────────────────
set -Eeuo pipefail
trap 'echo -e "\033[0;31m[ERROR]\033[0m Command failed: ${BASH_COMMAND} (exit $?) at line $LINENO"' ERR

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CDK_STACK_NAME="PaymentAgentStack"

print_status() { echo -e "${BLUE}[INFO]${NC} $1"; }
print_success() { echo -e "${GREEN}[SUCCESS]${NC} $1"; }
print_warning() { echo -e "${YELLOW}[WARNING]${NC} $1"; }
print_error() { echo -e "${RED}[ERROR]${NC} $1"; }

# ── Step 0: Prerequisites ──
check_prerequisites() {
  print_status "Checking prerequisites..."
  local missing=()
  command -v aws &>/dev/null || missing+=("aws-cli")
  command -v npm &>/dev/null || missing+=("npm")
  command -v npx &>/dev/null || missing+=("npx")
  command -v jq &>/dev/null || missing+=("jq")

  if [ ${#missing[@]} -ne 0 ]; then
    print_error "Missing: ${missing[*]}"
    exit 1
  fi

  # Verify AWS credentials
  if ! aws sts get-caller-identity &>/dev/null; then
    print_error "AWS credentials not configured. Run 'aws configure' first."
    exit 1
  fi

  print_success "Prerequisites satisfied"
}

# ── Step 1: Ensure .env exists ──
ensure_env_file() {
  cd "$PROJECT_ROOT"

  if [ ! -f ".env" ]; then
    print_status "No .env found — copying from .env-sample..."
    if [ ! -f ".env-sample" ]; then
      print_error ".env-sample not found. Are you in the agentcore-payments directory?"
      exit 1
    fi
    cp .env-sample .env
    print_warning ".env created from .env-sample"
  else
    print_status ".env already exists"
  fi

  # Source it
  set -a && source .env && set +a

  # Auto-detect AWS_ACCOUNT_ID if not set
  if [ -z "${AWS_ACCOUNT_ID:-}" ]; then
    print_status "AWS_ACCOUNT_ID not set — detecting from caller identity..."
    AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
    _inject_env_var "AWS_ACCOUNT_ID" "$AWS_ACCOUNT_ID"
    export AWS_ACCOUNT_ID
    print_success "Detected AWS_ACCOUNT_ID=$AWS_ACCOUNT_ID"
  fi

  # Default AWS_REGION if not set
  if [ -z "${AWS_REGION:-}" ]; then
    AWS_REGION=$(aws configure get region 2>/dev/null || echo "us-east-1")
    _inject_env_var "AWS_REGION" "$AWS_REGION"
    export AWS_REGION
    print_success "Defaulted AWS_REGION=$AWS_REGION"
  fi

  # AgentCore control-plane and data-plane endpoints are resolved from
  # AWS_REGION by boto3 — no CP/DP endpoint env vars needed for production.
  # RUNTIME_ENDPOINT is used by the agent ws/invoke lambda to reach the
  # AgentCore Runtime; default it to the region's AgentCore endpoint.
  if [ -z "${RUNTIME_ENDPOINT:-}" ]; then
    RUNTIME_ENDPOINT="https://bedrock-agentcore.${AWS_REGION}.amazonaws.com"
    _inject_env_var "RUNTIME_ENDPOINT" "$RUNTIME_ENDPOINT"
    export RUNTIME_ENDPOINT
  fi

  print_success "Environment loaded (region=$AWS_REGION, account=$AWS_ACCOUNT_ID)"
}

# Helper: inject or update a key=value in .env
_inject_env_var() {
  local key="$1" value="$2"
  local env_file="$PROJECT_ROOT/.env"

  if grep -q "^${key}=" "$env_file" 2>/dev/null; then
    # Update existing (macOS-safe sed)
    if [[ "$OSTYPE" == "darwin"* ]]; then
      sed -i '' "s|^${key}=.*|${key}=${value}|" "$env_file"
    else
      sed -i "s|^${key}=.*|${key}=${value}|" "$env_file"
    fi
  else
    echo "${key}=${value}" >> "$env_file"
  fi
}

# ── Step 2: Install all dependencies ──
install_dependencies() {
  print_status "Installing backend CDK dependencies..."
  cd "$PROJECT_ROOT/backend"
  npm install

  # Shared Lambda layer: the Lambda Python runtime bundles an older boto3 that
  # predates the AgentCore Payments APIs, so install a GA-capable boto3 into the
  # layer's python/ dir. Versions are pinned exactly in requirements.txt
  # (boto3/botocore==1.43.37) for reproducible builds. Pure-Python wheels — no
  # Docker needed; runs against the Python 3.13 Lambda runtime.
  print_status "Installing shared Lambda layer dependencies (boto3)..."
  local shared_dir="$PROJECT_ROOT/backend/lambdas/shared"
  local py=""
  for cand in python3.12 python3.11 python3.10 python3; do
    if command -v "$cand" &>/dev/null; then py="$cand"; break; fi
  done
  if [ -z "$py" ]; then
    print_error "No suitable python (3.10+) found for building the Lambda layer."
    exit 1
  fi
  rm -rf "$shared_dir/python"
  "$py" -m pip install -r "$shared_dir/requirements.txt" -t "$shared_dir/python" --quiet
  print_success "Shared layer boto3 installed with $py"

  print_status "Installing seller Lambda dependencies..."
  cd "$PROJECT_ROOT/backend/lambdas/sellers/image-gen"
  npm install
  cd "$PROJECT_ROOT/backend/lambdas/sellers/storefront"
  npm install

  print_success "All dependencies installed"
}

# ── Step 3: CDK Bootstrap (idempotent) ──
bootstrap_cdk() {
  print_status "Bootstrapping CDK (if needed)..."
  cd "$PROJECT_ROOT/backend"
  npx cdk bootstrap "aws://${AWS_ACCOUNT_ID}/${AWS_REGION}" 2>/dev/null || true
  print_success "CDK bootstrapped"
}

# ── Step 4: CDK Deploy ──
deploy_cdk() {
  print_status "Deploying CDK stack ($CDK_STACK_NAME)..."
  cd "$PROJECT_ROOT/backend"
  npx cdk deploy --require-approval never --outputs-file "$PROJECT_ROOT/cdk-outputs.json"
  print_success "CDK stack deployed"
}

# ── Step 5: Inject CDK outputs into .env ──
inject_outputs() {
  print_status "Injecting CDK outputs into .env..."
  cd "$PROJECT_ROOT"

  local outputs_file="$PROJECT_ROOT/cdk-outputs.json"
  if [ ! -f "$outputs_file" ]; then
    print_warning "cdk-outputs.json not found — skipping .env injection"
    print_warning "Manually copy stack outputs into .env"
    return
  fi

  # Extract values from CDK outputs JSON
  local stack_key
  stack_key=$(jq -r 'keys[0]' "$outputs_file")

  local user_pool_id api_url client_id seller_api_url manager_role_arn memory_id storefront_api_url storefront_url admin_secret_name
  user_pool_id=$(jq -r ".\"${stack_key}\".UserPoolId // empty" "$outputs_file")
  client_id=$(jq -r ".\"${stack_key}\".UserPoolClientId // empty" "$outputs_file")
  api_url=$(jq -r ".\"${stack_key}\".ApiUrl // empty" "$outputs_file")
  seller_api_url=$(jq -r ".\"${stack_key}\".SellerApiUrl // empty" "$outputs_file")
  manager_role_arn=$(jq -r ".\"${stack_key}\".PaymentManagerRoleArn // empty" "$outputs_file")
  memory_id=$(jq -r ".\"${stack_key}\".AgentMemoryId // empty" "$outputs_file")
  storefront_api_url=$(jq -r ".\"${stack_key}\".StorefrontApiUrl // empty" "$outputs_file")
  storefront_url=$(jq -r ".\"${stack_key}\".StorefrontUrl // empty" "$outputs_file")
  admin_secret_name=$(jq -r ".\"${stack_key}\".AdminCredentialsSecretName // empty" "$outputs_file")

  # Inject backend vars
  [ -n "$user_pool_id" ] && _inject_env_var "COGNITO_USER_POOL_ID" "$user_pool_id"
  [ -n "$client_id" ] && _inject_env_var "COGNITO_CLIENT_ID" "$client_id"
  [ -n "$api_url" ] && _inject_env_var "API_URL" "$api_url"
  [ -n "$seller_api_url" ] && _inject_env_var "SELLER_API_URL" "$seller_api_url"
  [ -n "$manager_role_arn" ] && _inject_env_var "PAYMENT_MANAGER_ROLE_ARN" "$manager_role_arn"
  [ -n "$memory_id" ] && _inject_env_var "MEMORY_ID" "$memory_id"
  [ -n "$storefront_api_url" ] && _inject_env_var "STOREFRONT_API_URL" "$storefront_api_url"
  [ -n "$storefront_url" ] && _inject_env_var "STOREFRONT_URL" "$storefront_url"
  [ -n "$admin_secret_name" ] && _inject_env_var "ADMIN_SECRET_NAME" "$admin_secret_name"

  # Inject VITE_ frontend vars (same values, different prefix)
  [ -n "$api_url" ] && _inject_env_var "VITE_API_URL" "$api_url"
  [ -n "$user_pool_id" ] && _inject_env_var "VITE_COGNITO_USER_POOL_ID" "$user_pool_id"
  [ -n "$client_id" ] && _inject_env_var "VITE_COGNITO_CLIENT_ID" "$client_id"
  [ -n "$storefront_api_url" ] && _inject_env_var "VITE_STOREFRONT_API_URL" "$storefront_api_url"
  [ -n "$storefront_url" ] && _inject_env_var "VITE_STOREFRONT_URL" "$storefront_url"

  # Clean up
  rm -f "$outputs_file"

  print_success ".env updated with CDK outputs"
  echo ""
  echo -e "  ${GREEN}COGNITO_USER_POOL_ID${NC} = $user_pool_id"
  echo -e "  ${GREEN}COGNITO_CLIENT_ID${NC}    = $client_id"
  echo -e "  ${GREEN}API_URL${NC}              = $api_url"
  echo -e "  ${GREEN}SELLER_API_URL${NC}       = $seller_api_url"
  echo -e "  ${GREEN}MEMORY_ID${NC}            = $memory_id"
  echo -e "  ${GREEN}STOREFRONT_API_URL${NC}   = $storefront_api_url"
  echo -e "  ${GREEN}STOREFRONT_URL${NC}       = $storefront_url"
  echo ""
}

# ── Step 6: Seed the demo admin user (one-time, idempotent) ──
# Self-signup only ever produces a `user`-group account, so the admin surface
# (Seller Setup, credential providers, order list) needs at least one `admin`.
# The username is fixed (demo@agentcore-payments.dev); the password is generated
# once by the CDK stack and stored in AWS Secrets Manager (never hardcoded). We
# read it here to create the Cognito admin. Safe to re-run: if the user already
# exists we skip it. Retrieve the password later from Secrets Manager using the
# ADMIN_SECRET_NAME injected above. Rotate or remove this account before any
# real exposure.
create_admin_user() {
  cd "$PROJECT_ROOT"
  # Re-read .env so we pick up COGNITO_USER_POOL_ID and ADMIN_SECRET_NAME.
  set -a && source .env && set +a

  local pool="${COGNITO_USER_POOL_ID:-}"
  local secret_name="${ADMIN_SECRET_NAME:-}"

  if [ -z "$pool" ]; then
    print_warning "COGNITO_USER_POOL_ID not set — skipping demo admin creation"
    return
  fi
  if [ -z "$secret_name" ]; then
    print_warning "ADMIN_SECRET_NAME not set — skipping demo admin creation"
    return
  fi

  # Read the generated credentials from Secrets Manager (created by the stack).
  local secret_json email password
  secret_json=$(aws secretsmanager get-secret-value --secret-id "$secret_name" \
    --query SecretString --output text --region "$AWS_REGION" 2>/dev/null || true)
  if [ -z "$secret_json" ]; then
    print_warning "Could not read admin credentials secret ($secret_name) — skipping"
    return
  fi
  email=$(echo "$secret_json" | jq -r '.username // empty')
  password=$(echo "$secret_json" | jq -r '.password // empty')
  if [ -z "$email" ] || [ -z "$password" ]; then
    print_warning "Admin credentials secret missing username/password — skipping"
    return
  fi

  print_status "Seeding demo admin user ($email)..."

  # Idempotent: if the user already exists, leave it untouched.
  if aws cognito-idp admin-get-user \
      --user-pool-id "$pool" --username "$email" \
      --region "$AWS_REGION" >/dev/null 2>&1; then
    print_success "Admin user already exists — skipping"
    return
  fi

  # Create the user without sending an invite email (the demo domain is not a
  # real mailbox), mark the email verified, set the generated password as
  # permanent (no forced reset on first login), and add to the admin group.
  aws cognito-idp admin-create-user \
    --user-pool-id "$pool" \
    --username "$email" \
    --user-attributes Name=email,Value="$email" Name=email_verified,Value=true \
    --message-action SUPPRESS \
    --region "$AWS_REGION" >/dev/null

  aws cognito-idp admin-set-user-password \
    --user-pool-id "$pool" \
    --username "$email" \
    --password "$password" \
    --permanent \
    --region "$AWS_REGION" >/dev/null

  aws cognito-idp admin-add-user-to-group \
    --user-pool-id "$pool" \
    --username "$email" \
    --group-name admin \
    --region "$AWS_REGION" >/dev/null

  print_success "Demo admin created: $email (password in Secrets Manager: $secret_name)"
}

# CloudFormation can leave AllowAdminCreateUserOnly=true on a freshly created
# Cognito pool even when the template sets false (a create-time quirk of the
# Cognito resource handler), which blocks public self sign-up. Force it off
# after deploy so the "user" group can self-register. The admin account is
# seeded separately, so self sign-up only ever produces regular users. We
# re-pass the password policy, PostConfirmation trigger, auto-verified email,
# and verification template because update-user-pool resets omitted fields.
enable_self_signup() {
  cd "$PROJECT_ROOT"
  set -a && source .env && set +a
  local pool="${COGNITO_USER_POOL_ID:-}"
  [ -z "$pool" ] && return
  local cur
  cur=$(aws cognito-idp describe-user-pool --user-pool-id "$pool" --region "$AWS_REGION" 2>/dev/null) || return
  if [ "$(echo "$cur" | jq -r '.UserPool.AdminCreateUserConfig.AllowAdminCreateUserOnly // false')" = "false" ]; then
    print_success "Self sign-up already enabled"
    return
  fi
  print_status "Enabling self sign-up (AllowAdminCreateUserOnly=false)..."
  local pol lam ver
  pol=$(echo "$cur" | jq -c '.UserPool.Policies')
  lam=$(echo "$cur" | jq -c '.UserPool.LambdaConfig // {}')
  ver=$(echo "$cur" | jq -c '.UserPool.VerificationMessageTemplate')
  aws cognito-idp update-user-pool --user-pool-id "$pool" --region "$AWS_REGION" \
    --admin-create-user-config AllowAdminCreateUserOnly=false \
    --auto-verified-attributes email \
    --policies "$pol" \
    --lambda-config "$lam" \
    --verification-message-template "$ver" >/dev/null
  print_success "Self sign-up enabled"
}

# Display the demo admin credentials (read from Secrets Manager) at the end of
# setup so the deployer does not have to run a separate command. Secrets Manager
# remains the source of truth; this only echoes them to the operator's own
# terminal during their own deploy.
print_admin_credentials() {
  cd "$PROJECT_ROOT"
  set -a && source .env && set +a
  local secret_name="${ADMIN_SECRET_NAME:-}"
  [ -z "$secret_name" ] && return
  local secret_json email password
  secret_json=$(aws secretsmanager get-secret-value --secret-id "$secret_name" \
    --query SecretString --output text --region "${AWS_REGION:-us-east-1}" 2>/dev/null || true)
  [ -z "$secret_json" ] && return
  email=$(echo "$secret_json" | jq -r '.username // empty')
  password=$(echo "$secret_json" | jq -r '.password // empty')
  if [ -z "$email" ] || [ -z "$password" ]; then return; fi
  echo -e "     ${GREEN}Email:${NC}    ${BLUE}${email}${NC}"
  echo -e "     ${GREEN}Password:${NC} ${BLUE}${password}${NC}"
  echo -e "     (stored in Secrets Manager: ${secret_name})"
}

# ── Main ──
main() {
  echo -e "${BLUE}=== Backend Setup (Clean Repo → Deployed Stack) ===${NC}\n"

  check_prerequisites
  ensure_env_file
  install_dependencies
  bootstrap_cdk
  deploy_cdk
  inject_outputs
  enable_self_signup
  create_admin_user

  echo -e "${GREEN}✅ Backend setup complete!${NC}"
  echo -e ""
  echo -e "Next steps:"
  echo -e "  1. Run ${BLUE}npm run setup:amplify${NC} to deploy the frontend"
  echo -e "  2. Sign in as the demo admin (or sign up your own account):"
  print_admin_credentials
  echo -e "     Retrieve these again anytime with:"
  echo -e "       ${BLUE}aws secretsmanager get-secret-value --secret-id \"\$ADMIN_SECRET_NAME\" --query SecretString --output text${NC}"
  echo -e "  3. As the admin, run Seller Setup to provision the seller payout wallet"
}

main "$@"
