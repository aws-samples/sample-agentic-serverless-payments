#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────
# Amplify Frontend Deployment Script — Idempotent CI/CD
# Creates the Amplify app on first run, updates it on subsequent runs.
# Never creates duplicate apps — always reuses the existing one.
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
BRANCH_NAME="main"

print_status() { echo -e "${BLUE}[INFO]${NC} $1"; }
print_success() { echo -e "${GREEN}[SUCCESS]${NC} $1"; }
print_warning() { echo -e "${YELLOW}[WARNING]${NC} $1"; }
print_error() { echo -e "${RED}[ERROR]${NC} $1"; }

# ── Prerequisites ──
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

# ── Load and validate .env ──
load_env() {
  print_status "Loading .env..."
  cd "$PROJECT_ROOT"

  if [ ! -f ".env" ]; then
    print_error ".env not found. Run 'npm run setup:backend' first."
    exit 1
  fi

  set -a && source .env && set +a

  local missing=()
  [ -z "${VITE_API_URL:-}" ] && missing+=("VITE_API_URL")
  [ -z "${VITE_COGNITO_USER_POOL_ID:-}" ] && missing+=("VITE_COGNITO_USER_POOL_ID")
  [ -z "${VITE_COGNITO_CLIENT_ID:-}" ] && missing+=("VITE_COGNITO_CLIENT_ID")

  if [ ${#missing[@]} -ne 0 ]; then
    print_error "Missing env vars: ${missing[*]}"
    print_error "Run 'npm run setup:backend' first — it injects these automatically."
    exit 1
  fi

  print_success "Environment validated"
}

# ── Build frontend ──
build_frontend() {
  print_status "Installing frontend dependencies..."
  cd "$PROJECT_ROOT/frontend"
  # npm ci for reproducible installs straight from the committed lock file.
  npm ci

  print_status "Building frontend..."
  npm run build
  print_success "Frontend built"
}

# ── Ensure Amplify app exists (create once, reuse forever) ──
ensure_amplify_app() {
  print_status "Checking for existing Amplify app '$APP_NAME'..."

  APP_ID=$(aws amplify list-apps \
    --query "apps[?name=='$APP_NAME'].appId | [0]" \
    --output text 2>/dev/null || true)

  if [ -n "$APP_ID" ] && [ "$APP_ID" != "None" ] && [ "$APP_ID" != "null" ]; then
    print_status "Reusing existing Amplify app: $APP_ID"
  else
    print_status "Creating new Amplify app..."
    APP_ID=$(aws amplify create-app \
      --name "$APP_NAME" \
      --query 'app.appId' \
      --output text \
      --no-cli-pager)
    print_success "Created Amplify app: $APP_ID"
  fi

  # Ensure branch exists (idempotent — create-branch fails silently if exists)
  aws amplify create-branch \
    --app-id "$APP_ID" \
    --branch-name "$BRANCH_NAME" \
    --no-cli-pager 2>/dev/null || true

  export APP_ID
}

# ── Update environment variables on the app ──
update_amplify_env() {
  print_status "Updating Amplify environment variables..."

  aws amplify update-app \
    --app-id "$APP_ID" \
    --environment-variables \
      "VITE_API_URL=$VITE_API_URL,VITE_COGNITO_USER_POOL_ID=$VITE_COGNITO_USER_POOL_ID,VITE_COGNITO_CLIENT_ID=$VITE_COGNITO_CLIENT_ID,VITE_USDC_CONTRACT=${VITE_USDC_CONTRACT:-0x036CbD53842c5426634e7929541eC2318f3dCF7e},VITE_BASE_SEPOLIA_RPC=${VITE_BASE_SEPOLIA_RPC:-https://sepolia.base.org},VITE_STOREFRONT_API_URL=${VITE_STOREFRONT_API_URL:-},VITE_STOREFRONT_URL=${VITE_STOREFRONT_URL:-}" \
    --no-cli-pager >/dev/null

  print_success "Environment variables updated"
}

# ── Deploy (zip upload → start deployment) ──
deploy_frontend() {
  print_status "Deploying to Amplify (branch: $BRANCH_NAME)..."
  cd "$PROJECT_ROOT"

  # Create deployment slot
  DEPLOYMENT=$(aws amplify create-deployment \
    --app-id "$APP_ID" \
    --branch-name "$BRANCH_NAME" \
    --no-cli-pager)
  JOB_ID=$(echo "$DEPLOYMENT" | jq -r '.jobId')
  UPLOAD_URL=$(echo "$DEPLOYMENT" | jq -r '.zipUploadUrl')

  # Zip dist and upload
  cd "$PROJECT_ROOT/frontend/dist"
  zip -qr "$PROJECT_ROOT/deploy.zip" .
  cd "$PROJECT_ROOT"
  curl -s -T deploy.zip "$UPLOAD_URL"

  # Start deployment
  aws amplify start-deployment \
    --app-id "$APP_ID" \
    --branch-name "$BRANCH_NAME" \
    --job-id "$JOB_ID" \
    --no-cli-pager >/dev/null

  # Clean up zip
  rm -f deploy.zip

  AMPLIFY_URL="https://${BRANCH_NAME}.${APP_ID}.amplifyapp.com"
  print_success "Deployment started (job: $JOB_ID)"
}

# ── Save App ID to .env for cleanup ──
save_app_id() {
  local env_file="$PROJECT_ROOT/.env"
  if grep -q "^AMPLIFY_APP_ID=" "$env_file" 2>/dev/null; then
    if [[ "$OSTYPE" == "darwin"* ]]; then
      sed -i '' "s|^AMPLIFY_APP_ID=.*|AMPLIFY_APP_ID=${APP_ID}|" "$env_file"
    else
      sed -i "s|^AMPLIFY_APP_ID=.*|AMPLIFY_APP_ID=${APP_ID}|" "$env_file"
    fi
  else
    echo "AMPLIFY_APP_ID=${APP_ID}" >> "$env_file"
  fi
}

# ── Main ──
main() {
  echo -e "${BLUE}=== Amplify Frontend Deployment (CI/CD) ===${NC}\n"

  check_prerequisites
  load_env
  build_frontend
  ensure_amplify_app
  update_amplify_env
  deploy_frontend
  save_app_id

  echo -e ""
  echo -e "${GREEN}✅ Amplify deployment complete!${NC}"
  echo -e ""
  echo -e "  URL: ${GREEN}${AMPLIFY_URL}${NC}"
  echo -e "  App ID: ${APP_ID} (saved to .env as AMPLIFY_APP_ID)"
  echo -e ""
  echo -e "  Run this script again to update the deployment — it will"
  echo -e "  reuse the same app and push a new version."
}

main "$@"
