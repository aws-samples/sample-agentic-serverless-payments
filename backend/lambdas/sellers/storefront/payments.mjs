/**
 * Outbound x402 facade — the storefront seller PAYS someone (refunds).
 * --------------------------------------------------------------------
 * The inbound resource-server (x402.mjs) handles "someone pays me". It cannot
 * initiate a payment. A refund is the seller acting as the PAYER: seller wallet
 * -> buyer address, on the same network, governed by a per-refund spend-capped
 * PaymentSession. That is AgentCore ProcessPayment with the buyer in payTo,
 * which is the same primitive a buyer uses, just with the roles reversed.
 *
 * This one function owns the entire seller-as-payer flow so the wire-format
 * concerns (feePayer for Solana, v2 payload, the facilitator settle + the
 * "authorization not yet valid" retry) live in exactly one place:
 *
 *     create capped session -> ProcessPayment (seller signs) -> facilitator settle
 *
 * It reuses the library's facilitator client and /supported feePayer lookup so
 * the outbound path shares the same protocol source of truth as the inbound
 * resource server.
 */
import crypto from "node:crypto";
import { BedrockAgentCore } from "@aws-sdk/client-bedrock-agentcore";
import { HTTPFacilitatorClient } from "@x402/core/server";

import {
  EVM_NETWORK,
  EVM_ASSET,
  SOLANA_NETWORK,
  SOLANA_ASSET,
  FACILITATOR_URL,
  getSolanaFeePayer,
  usdToMinor,
} from "./shared.mjs";

const REGION = process.env.AWS_REGION || "us-east-1";
const dp = new BedrockAgentCore({ region: REGION });
const facilitator = new HTTPFacilitatorClient({ url: FACILITATOR_URL });

function clientToken() {
  return crypto.randomUUID() + "-" + crypto.randomUUID().slice(0, 8);
}

// Build the reverse accept (seller -> buyer) for the refund network. Mirrors
// the inbound accept shape; injects the facilitator feePayer for Solana so the
// gasless transaction + ProcessPayment validation succeed.
async function buildRefundAccept(network, toAddress, amountMinor) {
  if (network === "SOLANA") {
    const feePayer = await getSolanaFeePayer();
    return {
      scheme: "exact",
      network: SOLANA_NETWORK,
      amount: amountMinor,
      maxAmountRequired: amountMinor,
      asset: SOLANA_ASSET,
      payTo: toAddress,
      maxTimeoutSeconds: 300,
      extra: feePayer ? { feePayer } : {},
    };
  }
  return {
    scheme: "exact",
    network: EVM_NETWORK,
    amount: amountMinor,
    maxAmountRequired: amountMinor,
    asset: EVM_ASSET,
    payTo: toAddress,
    maxTimeoutSeconds: 300,
    extra: { name: "USDC", version: "2" },
  };
}

/**
 * Settle a seller-originated payout (refund) to `toAddress`.
 *
 * @param {object} args
 * @param {object} args.sellerConfig  READY seller config (managerArn, instruments, sellerUserId)
 * @param {string} args.toAddress     buyer wallet to receive the refund
 * @param {"SOLANA"|"ETHEREUM"} args.network
 * @param {number|string} args.amountUsd   amount in USD (for the session cap + minor units)
 * @param {string} [args.amountMinor]      optional precomputed minor units
 * @param {string} [args.agentName]        observability attribution
 *
 * Returns:
 *   { ok: true, refundTx }
 *   { ok: false, error, retryable }   // funds did NOT move; caller leaves order CONFIRMED
 */
export async function settlePayout({ sellerConfig, toAddress, network, amountUsd, amountMinor, agentName }) {
  if (!toAddress) return { ok: false, error: "No payout address", retryable: false };

  const isSolana = network === "SOLANA";
  const instrumentId = isSolana ? sellerConfig.solInstrumentId : sellerConfig.evmInstrumentId;
  if (!instrumentId) return { ok: false, error: `Seller has no ${network} payout instrument`, retryable: false };

  const minor = amountMinor || usdToMinor(amountUsd);
  // Every seller-side op is scoped to the seller's userId (the identity the
  // payout instruments were created under). AgentCore forwards it as
  // X-Amzn-Bedrock-AgentCore-Payments-User-Id.
  const sellerUserId = sellerConfig.sellerUserId || "storefront-seller";

  // Per-refund PaymentSession capped at exactly the refund amount — a buggy or
  // compromised refund path cannot exceed it. Governance hero.
  let sessionId;
  try {
    const sess = await dp.createPaymentSession({
      paymentManagerArn: sellerConfig.managerArn,
      userId: sellerUserId,
      expiryTimeInMinutes: 15,
      limits: { maxSpendAmount: { value: String(amountUsd), currency: "USD" } },
    });
    sessionId = sess.paymentSession?.paymentSessionId || sess.paymentSessionId;
  } catch (e) {
    console.error("Refund session create failed:", e?.message);
    return { ok: false, error: `Could not create refund session: ${e.message}`, retryable: false };
  }

  const accept = await buildRefundAccept(network, toAddress, minor);

  // ProcessPayment as the seller (payer) -> signed reverse proof.
  let proof;
  try {
    const resp = await dp.processPayment({
      paymentManagerArn: sellerConfig.managerArn,
      paymentSessionId: sessionId,
      paymentInstrumentId: instrumentId,
      userId: sellerUserId,
      agentName: agentName || process.env.PAYMENTS_AGENT_NAME || "storefront-seller-refund",
      paymentType: "CRYPTO_X402",
      paymentInput: { cryptoX402: { version: "2", payload: { ...accept, x402Version: 2 } } },
      clientToken: clientToken(),
    });
    if (!["PROOF_GENERATED", "SUCCEEDED"].includes(resp.status)) {
      return { ok: false, error: `Refund ProcessPayment failed: ${resp.status}`, retryable: false };
    }
    proof = resp.paymentOutput?.cryptoX402 || {};
  } catch (e) {
    console.error("Refund ProcessPayment failed:", e?.message);
    return { ok: false, error: `Refund payment failed: ${e.message}`, retryable: false };
  }

  // Settle the seller -> buyer transfer through the library's facilitator
  // client (same wire format the inbound path uses). The v2 PaymentPayload must
  // carry `accepted` (the requirements the proof was signed against); the EVM
  // and SVM facilitators read payload.accepted.scheme / .network. Omitting it
  // crashes settle with "Cannot read properties of undefined (reading 'scheme')".
  // The refund proof's validAfter is set a few seconds ahead (clock-skew
  // buffer), so the facilitator's on-chain simulation can revert with
  // "authorization is not yet valid" on the first try. Retry briefly.
  const paymentPayload = {
    x402Version: 2,
    scheme: "exact",
    network: isSolana ? SOLANA_NETWORK : EVM_NETWORK,
    accepted: accept,
    payload: proof.payload || proof,
  };
  const paymentRequirements = accept;

  const attemptSettle = async () => {
    try {
      const res = await facilitator.settle(paymentPayload, paymentRequirements);
      return { ok: res?.success === true, body: res };
    } catch (e) {
      // SettleError carries the facilitator response; surface its reason.
      const body = e?.response || e?.body || { errorReason: e?.message || String(e) };
      return { ok: false, body };
    }
  };

  let settle = await attemptSettle();
  const backoffsMs = [3000, 4000, 6000];
  for (let i = 0; i < backoffsMs.length && !settle.ok; i++) {
    const reason = String(settle.body?.errorReason || settle.body?.error || "");
    if (!/not yet valid/i.test(reason)) break; // only retry the timing case
    await new Promise((r) => setTimeout(r, backoffsMs[i]));
    settle = await attemptSettle();
  }

  if (!settle.ok) {
    const reason = settle.body?.errorReason || settle.body?.error || "settlement did not succeed";
    const retryable = /not yet valid/i.test(String(reason));
    console.error("Refund settle failed:", reason);
    return {
      ok: false,
      retryable,
      error: retryable
        ? "Refund could not settle yet — the payment authorization is not valid for a few more seconds. Please try again shortly."
        : `Refund could not be settled on-chain: ${String(reason).slice(0, 200)}`,
    };
  }

  const refundTx = settle.body?.transaction || settle.body?.txHash || "";
  return { ok: true, refundTx };
}
