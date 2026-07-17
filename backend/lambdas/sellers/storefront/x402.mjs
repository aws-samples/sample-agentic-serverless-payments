/**
 * Inbound x402 facade — buyer pays the storefront seller.
 * ------------------------------------------------------
 * This module hands the x402 wire format to the official @x402/* packages (the
 * same engine the @x402/hono image-gen seller uses), instead of hand-rolling
 * the 402 requirements, verify, and settle. The library owns:
 *   - fetching the facilitator's /supported kinds (incl. the Solana feePayer)
 *   - the v1/v2 wire format per network
 *   - building the 402 PAYMENT-REQUIRED response and verifying the proof
 *
 * We drive the resource server's verify and settle as SEPARATE explicit steps
 * (not the hono auto-settle-after-handler middleware), so the storefront keeps
 * its ordering guarantee:
 *
 *     verify  →  reserve inventory  →  settle  →  fulfill  →  CONFIRMED
 *
 * The hono middleware settles after the handler returns, which would let us
 * fulfill (mint a license, send an email, copy a file) before knowing the
 * payment settled. We never want to deliver goods we might not get paid for,
 * so we call processHTTPRequest (verify) and processSettlement (settle)
 * ourselves around the inventory + fulfillment logic.
 */
import { x402ResourceServer, HTTPFacilitatorClient, x402HTTPResourceServer } from "@x402/core/server";
import { registerExactEvmScheme } from "@x402/evm/exact/server";
import { registerExactSvmScheme } from "@x402/svm/exact/server";
import { getBase64Encoder, getTransactionDecoder, getCompiledTransactionMessageDecoder } from "@solana/kit";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { TOKEN_2022_PROGRAM_ADDRESS } from "@solana-program/token-2022";

import {
  EVM_NETWORK,
  SOLANA_NETWORK,
  FACILITATOR_URL,
  getProduct,
} from "./shared.mjs";

const ORDER_ROUTE = "POST /orders";

// ── Per-request price resolver ──
// The 402 must advertise the price of the specific product in the request body.
// DynamicPrice receives the HTTP request context (with getBody) so we can look
// up the product and compute the amount.
//
// We return a Money string ("$4.99"), NOT an AssetAmount. This is the same
// thing the @x402/hono image-gen seller does (price: "$0.04"). A Money string
// makes each scheme run its money conversion, which resolves the canonical USDC
// asset for the network AND injects the required `extra`: name/version for EVM,
// feePayer for Solana. Returning a bare AssetAmount bypasses that and leaves
// `extra` empty, which makes ProcessPayment reject the payload with
// "Extra must contain either EVM fields (name, version) or SVM fields (feePayer)".

async function priceFromContext(ctx) {
  const body = (await ctx.adapter.getBody?.()) || {};
  const productId = body.productId;
  const qty = Math.max(1, parseInt(body.quantity || body.qty || 1, 10));
  // No/invalid product → advertise $0 so the lib still builds a valid 402;
  // placeOrder rejects the missing/unknown productId before we ever settle.
  if (!productId) return "$0";
  const product = await getProduct(productId);
  if (!product || product.active === false) return "$0";
  const total = Number(product.priceUsd) * qty;
  return `$${total.toFixed(6)}`;
}

// ── One resource server per container (cached) ──
// initialize() fetches the facilitator's /supported kinds once. Routes carry
// both EVM and Solana payment options; payTo comes from the seller config that
// was READY at first build. The seller payout addresses are static per deploy,
// so capturing them at first call is safe.
let _httpServerPromise = null;

function buildHttpServer(sellerConfig) {
  const facilitator = new HTTPFacilitatorClient({ url: FACILITATOR_URL });
  const resourceServer = new x402ResourceServer(facilitator);
  registerExactEvmScheme(resourceServer);
  registerExactSvmScheme(resourceServer);

  const accepts = [];
  if (sellerConfig?.evmPayToAddress) {
    accepts.push({
      scheme: "exact",
      network: EVM_NETWORK,
      payTo: sellerConfig.evmPayToAddress,
      price: (ctx) => priceFromContext(ctx),
      maxTimeoutSeconds: 300,
    });
  }
  if (sellerConfig?.solPayToAddress) {
    accepts.push({
      scheme: "exact",
      network: SOLANA_NETWORK,
      payTo: sellerConfig.solPayToAddress,
      price: (ctx) => priceFromContext(ctx),
      maxTimeoutSeconds: 300,
    });
  }

  const routes = {
    [ORDER_ROUTE]: {
      accepts,
      resource: "/orders",
      description: "Storefront order",
      mimeType: "application/json",
    },
  };

  return new x402HTTPResourceServer(resourceServer, routes);
}

async function getHttpServer(sellerConfig) {
  if (!_httpServerPromise) {
    _httpServerPromise = (async () => {
      const http = buildHttpServer(sellerConfig);
      await http.initialize(); // fetch /supported (feePayer, supported kinds)
      return http;
    })();
  }
  return _httpServerPromise;
}

// ── Framework-agnostic HTTP adapter over the API Gateway (HTTP API) event ──
// The library ships a hono adapter; for a bare Lambda integration we implement
// the small HTTPAdapter surface from the APIGW v2 event. Only the methods the
// resource server actually calls are needed.
function makeAdapter(event) {
  const headers = event.headers || {};
  const getHeader = (name) =>
    headers[name] || headers[name.toLowerCase()] || headers[name.toUpperCase()];
  let parsedBody;
  let bodyParsed = false;
  return {
    getHeader,
    getMethod: () => event.requestContext?.http?.method || "POST",
    getPath: () => event.rawPath || "/orders",
    getUrl: () => event.rawPath || "/orders",
    getAcceptHeader: () => getHeader("accept") || "",
    getUserAgent: () => getHeader("user-agent") || "",
    getBody: () => {
      if (!bodyParsed) {
        bodyParsed = true;
        try { parsedBody = JSON.parse(event.body || "{}"); } catch { parsedBody = {}; }
      }
      return parsedBody;
    },
  };
}

function makeContext(event) {
  const adapter = makeAdapter(event);
  return {
    adapter,
    path: event.rawPath || "/orders",
    method: event.requestContext?.http?.method || "POST",
    paymentHeader: adapter.getHeader("payment-signature") || adapter.getHeader("x-payment"),
  };
}

/**
 * Verify the inbound order payment (no funds move).
 *
 * Returns one of:
 *   { kind: "unpaid", response }       — no/invalid proof; `response` is the
 *                                        library-built 402 (status/headers/body)
 *                                        carrying correct accepts incl. feePayer.
 *   { kind: "verified", http,
 *     paymentPayload, paymentRequirements, declaredExtensions }
 *                                      — proof valid; caller reserves inventory
 *                                        then calls settleOrder(...).
 *   { kind: "error", response }        — verification error; forward `response`.
 */
export async function verifyOrder(event, sellerConfig) {
  const http = await getHttpServer(sellerConfig);
  const ctx = makeContext(event);
  const hasProof = Boolean(ctx.paymentHeader);

  const result = await http.processHTTPRequest(ctx);

  if (result.type === "payment-verified") {
    return {
      kind: "verified",
      http,
      paymentPayload: result.paymentPayload,
      paymentRequirements: result.paymentRequirements,
      declaredExtensions: result.declaredExtensions,
    };
  }
  if (result.type === "payment-error") {
    // The library returns the 402 (with accepts + PAYMENT-REQUIRED header) for
    // an unpaid request, or an error for a bad proof. A request that DID carry a
    // payment proof but still gets a 402 means verification rejected the proof —
    // an exceptional, hard-to-diagnose case. Emit one structured warning with
    // the facilitator's reason and the submitted requirements so operators can
    // see why a payment was rejected (e.g. network/asset mismatch, or a Solana
    // wallet whose token account does not exist yet). No secrets are logged: the
    // `accepted` object is the public payment requirements the client already
    // received in the 402.
    if (hasProof) {
      // Production logs carry only the event and HTTP status — no payment
      // context — to avoid a side channel for tracking payment attempts. The
      // facilitator rejection reason aids diagnosis but is payment-related, so
      // it is included only under an explicit debug flag that is off in prod.
      const logEntry = { event: "order_verify_rejected", status: result.response?.status };
      if (process.env.DEBUG_PAYMENT_LOGS === "1") {
        let reason = "unknown";
        try {
          const h = result.response?.headers?.["PAYMENT-REQUIRED"] || result.response?.headers?.["payment-required"];
          if (h) reason = JSON.parse(Buffer.from(h, "base64").toString())?.error || "unknown";
        } catch { /* ignore */ }
        logEntry.reason = reason;
      }
      console.warn(JSON.stringify(logEntry));
    }
    return { kind: result.response?.status === 402 ? "unpaid" : "error", response: result.response };
  }
  // "no-payment-required" should not happen for POST /orders, but treat it as
  // unpaid so the caller never settles without a verified proof.
  return { kind: "unpaid", response: { status: 402, headers: {}, body: {} } };
}

/**
 * Settle a verified order payment (moves funds). Call only AFTER inventory is
 * reserved. Returns { ok, body } mirroring the old settleProof shape.
 */
export async function settleOrder(http, paymentPayload, paymentRequirements, declaredExtensions) {
  const result = await http.processSettlement(paymentPayload, paymentRequirements, declaredExtensions);
  const ok = result?.success === true;
  return { ok, body: result };
}

/**
 * Extract the buyer's Solana wallet from a verified SVM proof. The proof's
 * payload is a base64 signed transaction; the buyer is the OWNER (authority) of
 * the TransferChecked instruction — accounts order [source, mint, destination,
 * owner]. Mirrors the facilitator's getTokenPayerFromTransaction so the stored
 * address matches the on-chain payer. Best-effort; returns "" on any failure.
 */
function solanaPayerFromTransaction(base64Tx) {
  try {
    const bytes = getBase64Encoder().encode(base64Tx);
    const tx = getTransactionDecoder().decode(bytes);
    const compiled = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
    const staticAccounts = compiled.staticAccounts ?? [];
    const instructions = compiled.instructions ?? [];
    const tokenPrograms = new Set([TOKEN_PROGRAM_ADDRESS.toString(), TOKEN_2022_PROGRAM_ADDRESS.toString()]);
    for (const ix of instructions) {
      const programAddress = staticAccounts[ix.programAddressIndex]?.toString();
      if (!tokenPrograms.has(programAddress)) continue;
      const accountIndices = ix.accountIndices ?? [];
      if (accountIndices.length >= 4) {
        const owner = staticAccounts[accountIndices[3]]?.toString();
        if (owner) return owner;
      }
    }
  } catch { /* ignore */ }
  return "";
}

/**
 * Best-effort buyer wallet address from the verified payment payload, across
 * EVM (EIP-3009 `from`) and Solana (the TransferChecked owner inside the signed
 * transaction). Used to record where a refund would be sent.
 */
export function buyerAddressFromPayload(paymentPayload) {
  const p = paymentPayload?.payload || {};
  // Solana: the payload carries a base64 transaction; derive the payer from it.
  if (typeof p.transaction === "string" && p.transaction) {
    const solPayer = solanaPayerFromTransaction(p.transaction);
    if (solPayer) return solPayer;
  }
  // EVM (EIP-3009) and generic shapes.
  return (
    p.authorization?.from ||
    p.from ||
    p.signer ||
    paymentPayload?.accepted?.from ||
    ""
  );
}

/**
 * The network label ("ETHEREUM" | "SOLANA") from the verified requirements, so
 * the order records which chain it was paid on (refunds reverse on the same).
 */
export function networkFromRequirements(paymentRequirements) {
  const net = paymentRequirements?.network || "";
  return String(net).startsWith("solana:") || net === SOLANA_NETWORK ? "SOLANA" : "ETHEREUM";
}

/**
 * Build a Lambda HTTP response from the library's 402/error instructions.
 */
export function responseFromInstructions(instructions, corsHeaders) {
  const status = instructions?.status || 402;
  const libHeaders = instructions?.headers || {};
  const body = instructions?.body ?? {};
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json", ...corsHeaders, ...libHeaders },
    body: typeof body === "string" ? body : JSON.stringify(body),
  };
}
