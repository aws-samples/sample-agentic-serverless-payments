# Obtaining Wallet Provider Credentials

This guide walks through getting the credentials this project needs to provision
embedded crypto wallets through Amazon Bedrock AgentCore payments. You can use
either provider, or both side by side:

- [Coinbase Developer Platform (CDP)](#coinbase-developer-platform-cdp)
- [Stripe via Privy](#stripe-via-privy)

You enter these values once, in the admin app on the **Credential Providers**
page (or through **Quick Setup**). AgentCore payments hands them to AgentCore
Identity, which stores them in [AWS Secrets Manager](https://aws.amazon.com/secrets-manager/)
under AWS KMS encryption and surfaces only the secret ARN to the agent. The raw
keys are never returned to the running agent and are never committed to source
control (`.env` is gitignored).

You also need testnet USDC to make payments. Request it from the
[Circle Faucet](https://faucet.circle.com/) on Base Sepolia, Solana Devnet, or
both, using the wallet address shown after provisioning.

## Coinbase Developer Platform (CDP)

Coinbase CDP backs an embedded crypto wallet that signs on both EVM (Base
Sepolia) and Solana (Solana Devnet).

### Credentials you need

| Field | Where it comes from |
|-------|---------------------|
| API Key ID | A UUID from the CDP Portal |
| API Key Secret | The secret paired with the API Key ID |
| Wallet Secret | The Server Wallet secret from your project |

### Steps

1. Sign in to the [Coinbase Developer Platform Portal](https://portal.cdp.coinbase.com/).
2. Create a project (or select an existing one).
3. Open **API Keys** in the project, create a key, and copy the **API Key ID**
   and **API Key Secret**. The secret is shown only once, so save it before
   leaving the page.
4. Open **Wallet** in the project and copy the **Wallet Secret** (also called the
   Server Wallet secret).
5. Enable delegated signing before first use: go to **Wallet** to
   **Embedded Wallets** to **Policies** and turn on **Delegated signing**.
   Without this, `ProcessPayment` fails with a delegation grant error.

### One-time delegation grant

After the wallet is provisioned, Coinbase requires a one-time signing-delegation
grant tied to an end-user. In this app the grant runs through an email one-time
passcode (OTP) flow in the frontend, which captures the CDP end-user UUID that
becomes the payment `userId`. Sign in with the email you want to own the wallet,
enter the OTP, grant delegation, and set the delegation duration.

Reference: [CDP documentation](https://docs.cdp.coinbase.com/).

## Stripe via Privy

Stripe-backed wallets are provisioned through Privy and also settle on both EVM
and Solana.

### Credentials you need

| Field | Where it comes from |
|-------|---------------------|
| App ID | Privy Dashboard, App, API Keys |
| App Secret | Privy Dashboard, App, API Keys |
| Authorization Key ID | Privy Dashboard, App, Authorization Keys (P256 key ID) |
| Authorization Private Key | The P256 private key paired with the Authorization Key ID |

### Steps

1. Sign in to the [Privy Dashboard](https://dashboard.privy.io).
2. Create an app (or select an existing one).
3. Open **API Keys** and copy the **App ID** and **App Secret**.
4. Open **Authorization Keys**, create a P256 key, and copy the
   **Authorization Key ID** and its **Authorization Private Key**.
5. Privy returns the private key prefixed with `wallet-auth:`. You can paste it
   with or without the prefix; the backend strips it automatically.

### One-time session-signer attach (Add Signer)

Privy wallets require attaching the AgentCore authorization-key quorum as a
session signer before the agent can sign. The Instruments page exposes an
**Add Signer** action per Privy instrument that runs a one-time Privy email OTP
and then calls `addSessionSigners`. To enable that flow, set two public values
in `.env`:

| Variable | Source |
|----------|--------|
| `VITE_PRIVY_APP_ID` | Privy Dashboard, App, App ID |
| `VITE_PRIVY_SIGNER_ID` | Privy Dashboard, Wallet infrastructure, Authorization keys, key ID |

Both are public identifiers. The App Secret and Authorization Private Key stay on
the backend and are entered only on the admin Credential Providers page.

`VITE_PRIVY_SIGNER_ID` must be the same authorization key as the Credential
Provider's Authorization Key ID (whose private key is the Authorization Private
Key). The Add Signer flow delegates the wallet to `VITE_PRIVY_SIGNER_ID`, and
the agent signs with the credential provider's key — a mismatch makes
`ProcessPayment` fail at signing time.

Reference: [Privy add signers documentation](https://docs.privy.io/wallets/using-wallets/signers/add-signers)
and the [Privy website](https://www.privy.io/).

## Where the credentials are entered

1. Deploy the backend and frontend (see the main [README](../README.md)).
2. Sign in to the admin app and open **Credential Providers**.
3. Choose a vendor (Coinbase CDP or Stripe/Privy), paste the fields above, and
   create the provider. **Quick Setup** creates the credential provider, payment
   manager, and connector in one pass per vendor.
4. Provision a wallet from **Seller Setup** (seller payout) or from the user flow
   (buyer instrument), complete the one-time delegation or Add Signer step, then
   fund the wallet from the [Circle Faucet](https://faucet.circle.com/).

## Security

You paste vendor secrets once. From there, AgentCore Identity manages storage and
retrieval: secrets live in AWS Secrets Manager under AWS KMS encryption, and the
agent runtime receives only short-lived vendor tokens at signing time, never the
raw keys. Never commit secrets to source control. The project's `.env` is
gitignored for this reason.
