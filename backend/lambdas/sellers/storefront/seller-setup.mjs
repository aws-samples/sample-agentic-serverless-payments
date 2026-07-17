/**
 * Seller Setup service — admin-triggered, one-time seller provisioning.
 *
 *   GET  /seller/config   → current seller config + status
 *   POST /seller/setup    → provision the seller's AgentCore payment resources:
 *                           PaymentManager + Connector + Coinbase CDP credential
 *                           provider + 2 payout Instruments (ETH + Solana), then
 *                           write SellerConfig. Returns Wallet Hub delegation
 *                           links the admin must click once per payout wallet.
 *
 * This mirrors the buyer-side control-plane setup, but the wallet is the
 * SELLER's payout wallet (receives purchases, originates refunds). The admin
 * supplies a REAL email for the wallet (separate from the Cognito login email)
 * so the Coinbase Wallet Hub OTP / delegation can be completed.
 *
 * Infra is NOT updated by this — it writes a SellerConfig DynamoDB item that
 * the Order service reads at request time. No redeploy.
 */
import crypto from "node:crypto";
import {
  BedrockAgentCoreControl,
} from "@aws-sdk/client-bedrock-agentcore-control";
import {
  BedrockAgentCore,
} from "@aws-sdk/client-bedrock-agentcore";
import { SESClient, VerifyEmailIdentityCommand } from "@aws-sdk/client-ses";
import { json, getSellerConfig, putSellerConfig, requireAdmin } from "./shared.mjs";

const REGION = process.env.AWS_REGION || "us-east-1";
const SELLER_MANAGER_ROLE_ARN = process.env.SELLER_MANAGER_ROLE_ARN || "";

const cp = new BedrockAgentCoreControl({ region: REGION });
const dp = new BedrockAgentCore({ region: REGION });
const ses = new SESClient({ region: REGION });

const VENDOR = "CoinbaseCDP";
// The seller is a single logical payer. Every seller-side payment op
// (instrument create, refund session, refund ProcessPayment) is scoped to this
// userId — AgentCore forwards it as the X-Amzn-Bedrock-AgentCore-Payments-User-Id
// header and requires it on session/payment calls.
const SELLER_USER_ID = "storefront-seller";

function clientToken() {
  return crypto.randomUUID() + "-" + crypto.randomUUID().slice(0, 8);
}
function header(event, name) {
  const h = event.headers || {};
  return h[name] || h[name.toLowerCase()] || "";
}

export const handler = async (event) => {
  const method = event.requestContext?.http?.method || "GET";
  const rawPath = event.rawPath || "";
  if (method === "OPTIONS") return json({ message: "ok" });

  // Admin-only: this lambda now sits behind the main API's Cognito authorizer.
  // require_admin enforces ID-token + admin group (the authorizer alone does
  // not check token_use or group).
  const denied = requireAdmin(event);
  if (denied) return denied;

  try {
    if (method === "GET") {
      const cfg = await getSellerConfig();
      return json({ config: cfg || { status: "NOT_CONFIGURED" } });
    }
    if (method === "POST" && rawPath.endsWith("/setup")) {
      return await setupSeller(event);
    }
    return json({ error: "Method not allowed" }, 405);
  } catch (err) {
    console.error("Seller setup error:", err?.message);
    return json({ error: err.message }, 500);
  }
};

async function setupSeller(event) {
  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch { /* ignore */ }

  // Coinbase CDP credentials + the REAL wallet email (for Wallet Hub OTP).
  const { apiKeyId, apiKeySecret, walletSecret, walletEmail } = body;
  if (!apiKeyId || !apiKeySecret) {
    return json({ error: "apiKeyId and apiKeySecret (Coinbase CDP) are required" }, 400);
  }
  if (!walletEmail) {
    return json({ error: "walletEmail is required (receives the Wallet Hub delegation OTP)" }, 400);
  }
  if (!SELLER_MANAGER_ROLE_ARN) {
    return json({ error: "SELLER_MANAGER_ROLE_ARN not configured on the lambda" }, 500);
  }

  // 1. Credential provider (Coinbase CDP)
  const credName = `StorefrontSellerCDP${crypto.randomBytes(3).toString("hex")}`;
  const credConfig = { coinbaseCdpConfiguration: { apiKeyId, apiKeySecret } };
  if (walletSecret) credConfig.coinbaseCdpConfiguration.walletSecret = walletSecret;
  const credResp = await cp.createPaymentCredentialProvider({
    name: credName,
    credentialProviderVendor: VENDOR,
    providerConfigurationInput: credConfig,
  });
  const credentialProviderArn = credResp.credentialProviderArn;

  // 2. Payment manager
  const mgrResp = await cp.createPaymentManager({
    name: `StorefrontSeller${crypto.randomBytes(3).toString("hex")}`,
    authorizerType: "AWS_IAM",
    roleArn: SELLER_MANAGER_ROLE_ARN,
    clientToken: clientToken(),
  });
  const manager = mgrResp.paymentManager || mgrResp;
  const managerId = manager.paymentManagerId;
  const managerArn = manager.paymentManagerArn;

  // 3. Connector (CoinbaseCDP)
  const connResp = await cp.createPaymentConnector({
    paymentManagerId: managerId,
    name: `StorefrontConnector${crypto.randomBytes(3).toString("hex")}`,
    type: VENDOR,
    credentialProviderConfigurations: [{ coinbaseCDP: { credentialProviderArn } }],
    clientToken: clientToken(),
  });
  const connectorId = (connResp.paymentConnector || connResp).paymentConnectorId;

  // 4. Two payout instruments — ETH (Base Sepolia) + Solana — under the seller.
  async function createInstrument(network) {
    const r = await dp.createPaymentInstrument({
      paymentManagerArn: managerArn,
      paymentConnectorId: connectorId,
      userId: SELLER_USER_ID,
      paymentInstrumentType: "EMBEDDED_CRYPTO_WALLET",
      paymentInstrumentDetails: {
        embeddedCryptoWallet: { network, linkedAccounts: [{ email: { emailAddress: walletEmail } }] },
      },
      clientToken: clientToken(),
    });
    return r.paymentInstrument || r;
  }
  const evm = await createInstrument("ETHEREUM");
  const sol = await createInstrument("SOLANA");

  const evmDetails = evm.paymentInstrumentDetails?.embeddedCryptoWallet || {};
  const solDetails = sol.paymentInstrumentDetails?.embeddedCryptoWallet || {};

  // Persist config. Status PENDING_DELEGATION until the admin completes the
  // Wallet Hub delegation for each wallet (the redirectUrl below). The Order
  // service treats only READY as live; flip to READY via /seller/setup again
  // (idempotent) or a dedicated confirm step once delegation is done.
  const cfg = {
    managerId,
    managerArn,
    connectorId,
    credentialProviderArn,
    walletEmail,
    sellerUserId: SELLER_USER_ID,
    evmInstrumentId: evm.paymentInstrumentId,
    evmPayToAddress: evmDetails.walletAddress || "",
    evmDelegationUrl: evmDetails.redirectUrl || "",
    solInstrumentId: sol.paymentInstrumentId,
    solPayToAddress: solDetails.walletAddress || "",
    solDelegationUrl: solDetails.redirectUrl || "",
    // READY because purchases (receiving) work immediately; refunds (paying out)
    // require the admin to complete the delegation links below.
    status: "READY",
  };
  await putSellerConfig(cfg);

  // Verify the seller's payout email as an SES sender identity so order and
  // refund confirmations can be sent FROM it. SES emails the address a one-time
  // verification link; until the seller clicks it, emails degrade to a returned
  // preview. Best-effort, never blocks setup.
  let sesVerificationRequested = false;
  try {
    await ses.send(new VerifyEmailIdentityCommand({ EmailAddress: walletEmail }));
    sesVerificationRequested = true;
  } catch (e) {
    console.warn("SES VerifyEmailIdentity failed (continuing):", e.message);
  }

  return json({
    config: cfg,
    delegation: {
      message: "Open each delegation link once and complete the Coinbase Wallet Hub verification so the seller wallet can sign refunds.",
      evm: cfg.evmDelegationUrl,
      solana: cfg.solDelegationUrl,
    },
    sesVerification: {
      message: sesVerificationRequested
        ? `A verification email was sent to ${walletEmail}. Click the link so the storefront can send order and refund confirmations from this address. In the SES sandbox, recipient addresses must also be verified, or request SES production access.`
        : `Could not start SES verification for ${walletEmail}. Verify it in the SES console to enable order and refund emails.`,
      email: walletEmail,
    },
    // One-time Solana onboarding step. A brand-new Solana wallet has no USDC
    // token account yet, and an SPL token can only land in an account that
    // already exists. If the wallet's first incoming payment has to create that
    // account, AgentCore appends a create-account instruction to the transfer,
    // and the x402 facilitator rejects the non-standard transaction. Sending a
    // small amount of testnet USDC to the wallet once creates the account, after
    // which all purchases settle cleanly. EVM has no equivalent step.
    solanaFunding: {
      message:
        "One-time step: send a small amount of testnet USDC to the Solana payout " +
        "address below so its token account exists. Until then, Solana purchases " +
        "will fail at the facilitator. EVM needs no such step.",
      payoutAddress: cfg.solPayToAddress,
      network: "Solana Devnet",
      token: "USDC",
      faucet: "https://faucet.circle.com/",
    },
  }, 201);
}
