/**
 * Order service — the x402 seller middleware for the agent-economy storefront.
 *
 * Compliance: payments settle in stablecoin (USDC) over x402 with wallet
 * signatures; no payment card data is processed, so PCI-DSS does not apply. If
 * extended to handle card data, PCI-DSS controls would be required (see the
 * README Security/Compliance section and the AWS shared responsibility model).
 *
 *   POST /orders               → place an order. No payment proof → HTTP 402
 *                                with x402 requirements. With proof →
 *                                verify → reserve inventory → settle → CONFIRMED.
 *   POST /orders/{id}/refund   → seller-originated reverse payment (governed by
 *                                a per-refund spend-capped PaymentSession).
 *                                Callable by the buying agent or the admin.
 *   GET  /orders               → list orders (admin).
 *   GET  /orders/{id}          → single order.
 *
 * Identity / auth: the x402 payment proof IS the authorization for placing an
 * order — no Cognito on this path. Refunds are guarded by order state.
 *
 * Refunds use the AgentCore Payments data plane SERVERLESSLY: this lambda
 * acts as the payer (seller instrument → buyer address), the same ProcessPayment
 * primitive the buying agent uses, just triggered by backend code.
 */
import crypto from "node:crypto";
import {
  json,
  getProduct,
  getOrder,
  putOrder,
  updateOrderStatus,
  listOrders,
  listOrdersByUser,
  reserveInventory,
  restockInventory,
  getSellerConfig,
  usdToMinor,
  presignDeliverable,
  presignLibraryObject,
  deleteFromLibrary,
  copyToLibrary,
  makeLicenseToken,
  sendOrderEmail,
  sendRefundEmail,
  CORS_HEADERS,
  requireAdmin,
} from "./shared.mjs";
import {
  verifyOrder,
  settleOrder,
  buyerAddressFromPayload,
  networkFromRequirements,
  responseFromInstructions,
} from "./x402.mjs";
import { settlePayout } from "./payments.mjs";

function header(event, name) {
  const h = event.headers || {};
  return h[name] || h[name.toLowerCase()] || h[name.toUpperCase()] || "";
}

export const handler = async (event) => {
  const method = event.requestContext?.http?.method || "GET";
  const rawPath = event.rawPath || "";
  const orderId = event.pathParameters?.id;

  if (method === "OPTIONS") return json({ message: "ok" });

  // Admin routes are mounted under /admin/storefront/* on the main Cognito API.
  // They require an admin ID token and unlock privileged behavior (order list,
  // force refund). Public storefront routes (/orders/*) stay open for the agent
  // and browser and can never force a refund.
  const isAdminRoute = rawPath.includes("/admin/storefront");
  if (isAdminRoute) {
    const denied = requireAdmin(event);
    if (denied) return denied;
  }

  try {
    if (method === "POST" && orderId && rawPath.endsWith("/refund")) {
      // force is honored ONLY on the authed admin route; the public agent path
      // can refund a normal order but can never override the download rule.
      return await refundOrder(orderId, event, { allowForce: isAdminRoute });
    }
    if (method === "POST" && orderId && rawPath.endsWith("/update")) {
      return await updateOrder(orderId, event);
    }
    if (method === "GET" && orderId && rawPath.endsWith("/download")) {
      return await downloadOrder(orderId, event);
    }
    if (method === "POST" && !orderId) {
      return await placeOrder(event);
    }
    if (method === "GET" && orderId) {
      const order = await getOrder(orderId);
      return order ? json({ order }) : json({ error: "Order not found" }, 404);
    }
    if (method === "GET") {
      // Admin route lists every buyer's order (privileged).
      if (isAdminRoute) return json({ orders: await listOrders() });
      // Public buyer scope: list ONLY the caller's own orders, keyed by userId.
      // The agent runtime injects its bound userId (the buyer's Cognito sub);
      // we return only refund-relevant fields (no wallet/shipping/email). This
      // matches the storefront capability model (userId identifies the buyer,
      // orderId is the refund/download capability). For production, put this
      // behind the authenticated /user/orders route instead.
      const uid = event.queryStringParameters?.userId || "";
      if (!uid) return json({ error: "Not found" }, 404);
      const mine = await listOrdersByUser(uid);
      const summary = mine
        .map(toAgentOrderSummary)
        .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
      return json({ orders: summary });
    }
    return json({ error: "Method not allowed" }, 405);
  } catch (err) {
    console.error("Order service error:", err?.message);
    // Return a generic message to the client; the specific error is logged
    // server-side and may reference buyer email, wallet, or order details.
    return json({ error: "Internal server error" }, 500);
  }
};

// Minimal, refund-relevant view of an order for the buying agent. Deliberately
// omits wallet address, shipping address, and email.
function toAgentOrderSummary(o) {
  const item = (o.items && o.items[0]) || {};
  return {
    orderId: o.orderId,
    name: item.name || "",
    quantity: item.qty || 1,
    amountUsd: o.amountUsd,
    network: o.network || "ETHEREUM",
    fulfillmentType: o.fulfillmentType || "digital",
    status: o.status,
    // Hint for the agent: a CONFIRMED order that hasn't been consumed
    // (downloaded) can be refunded. The refund endpoint re-checks this.
    refundable: o.status === "CONFIRMED" && o.downloaded !== true,
    createdAt: o.createdAt || "",
  };
}

// ── Place order: x402 verify → reserve inventory → settle → CONFIRMED ──
// The x402 wire format (402 requirements, proof verify, settle) is owned by the
// @x402/* resource server in x402.mjs. We drive verify and settle as explicit
// steps around the inventory + fulfillment logic so goods are only delivered
// after a successful on-chain settle.
async function placeOrder(event) {
  const sellerConfig = await getSellerConfig();
  if (!sellerConfig || sellerConfig.status !== "READY") {
    return json({ error: "Storefront not yet configured by the seller. Try again later." }, 503);
  }

  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch { /* ignore */ }
  const productId = body.productId;
  const qty = Math.max(1, parseInt(body.quantity || body.qty || 1, 10));
  if (!productId) return json({ error: "productId is required" }, 400);

  const product = await getProduct(productId);
  if (!product || product.active === false) return json({ error: `Unknown product: ${productId}` }, 404);

  // Step 1 — verify the proof (no funds move). The resource server builds the
  // 402 (with correct accepts incl. the Solana feePayer) when there is no/an
  // invalid proof; we just forward it.
  const v = await verifyOrder(event, sellerConfig);
  if (v.kind === "unpaid" || v.kind === "error") {
    return responseFromInstructions(v.response, CORS_HEADERS);
  }
  // v.kind === "verified"
  const { http, paymentPayload, paymentRequirements, declaredExtensions } = v;

  // Idempotency: a retried proof (same nonce) must not double-create/charge.
  const proofHeader = header(event, "payment-signature") || header(event, "x-payment");
  const pp = paymentPayload?.payload || {};
  const nonce = pp.authorization?.nonce || pp.nonce || String(proofHeader).slice(0, 64);
  const existing = await getOrder(`nonce-${nonce}`).catch(() => null);
  if (existing) return json({ order: existing, note: "idempotent replay" }, 200);

  const amountMinor = usdToMinor(Number(product.priceUsd) * qty);

  // Step 2 — reserve inventory (atomic, no overselling). Done before settle so
  // we never charge for stock we can't fulfill.
  const reserved = await reserveInventory(productId, qty);
  if (!reserved) return json({ error: `Out of stock: ${product.name}` }, 409);

  const network = networkFromRequirements(paymentRequirements);
  const buyerAddress = buyerAddressFromPayload(paymentPayload);
  const orderId = "order-" + crypto.randomUUID();
  const now = new Date().toISOString();

  // Buyer contact + shipping come from the request body (the agent passes the
  // user's email; physical orders may include a mock shipping address).
  const buyerEmail = body.email || body.buyerEmail || "";
  const shippingAddress = body.shippingAddress || body.address || "";

  const order = {
    orderId,
    nonceKey: `nonce-${nonce}`,
    buyerUserId: body.userId || "",
    buyerEmail,
    buyerWalletAddress: buyerAddress,
    items: [{ productId, name: product.name, qty, priceUsd: product.priceUsd }],
    amountUsd: Number(product.priceUsd) * qty,
    amountMinor,
    network,
    fulfillmentType: product.fulfillmentType || "digital",
    shippingAddress,
    status: "PENDING",
    createdAt: now,
    updatedAt: now,
  };
  await putOrder(order);

  // Step 3 — settle (moves funds) only after inventory reserved + record written.
  const settle = await settleOrder(http, paymentPayload, paymentRequirements, declaredExtensions);
  if (!settle.ok) {
    // Settlement failed after verify — release the reserved stock and report.
    await restockInventory(productId, qty);
    await updateOrderStatus(orderId, "VOIDED", { voidReason: "settlement_failed" });
    return json({ error: "Payment settlement failed", orderId }, 402);
  }

  const tx = settle.body?.transaction || settle.body?.txHash || "";

  // ── Fulfillment (runs only after a successful settle) ──
  // digital + file    → presigned download of the deliverable + library copy
  // digital + license → signed redeem token (entitlement)
  // physical          → SES confirmation email (graceful preview fallback)
  const fulfillment = await fulfillOrder(order, product, sellerConfig);

  const confirmedExtra = { paymentTx: tx, ...fulfillment.persist };
  await updateOrderStatus(orderId, "CONFIRMED", confirmedExtra);

  const confirmed = {
    ...order,
    status: "CONFIRMED",
    paymentTx: tx,
    ...fulfillment.persist,
  };

  return json({ order: confirmed, delivery: fulfillment.delivery }, 201);
}

// ── Fulfillment dispatch by product type ──
async function fulfillOrder(order, product, sellerConfig) {
  const userId = order.buyerUserId || "";
  const fType = product.fulfillmentType || "digital";

  if (fType === "physical") {
    const emailRes = await sendOrderEmail(order.buyerEmail, order, product, order.shippingAddress, sellerConfig?.walletEmail || "");
    return {
      persist: {
        fulfillmentStatus: "SHIPMENT_PENDING",
        estimatedDelivery: "3 to 7 business days",
        emailSent: emailRes.sent,
        emailPreview: emailRes.sent ? "" : emailRes.preview,
      },
      delivery: {
        type: "physical",
        message: emailRes.sent
          ? `A confirmation email was sent to ${order.buyerEmail}.`
          : "Order confirmed. Email is not configured, so here is the confirmation preview.",
        emailSent: emailRes.sent,
        emailPreview: emailRes.preview,
        estimatedDelivery: "3 to 7 business days",
      },
    };
  }

  // Digital
  const deliveryKind = product.deliveryKind || "file";
  if (deliveryKind === "license") {
    const token = makeLicenseToken(product.productId, order.orderId, userId);
    return {
      persist: { fulfillmentStatus: "DELIVERED", licenseToken: token },
      delivery: {
        type: "license",
        message: "Your license token is ready. Redeem it from your account.",
        licenseToken: token,
      },
    };
  }

  // deliveryKind === "file" → save a library copy; deliver via a TRACKED
  // download path (short URL) rather than a raw presigned S3 link. The tracked
  // endpoint records the download (which disables the refund) and mints a fresh
  // presigned URL on demand. This keeps the chat link short and enforces the
  // "downloaded goods are non-refundable" rule.
  const libraryKey = await copyToLibrary(userId, product.assetKey, product.productId);
  return {
    persist: {
      fulfillmentStatus: libraryKey ? "DELIVERED" : "DELIVERY_PENDING",
      libraryKey,
      assetKey: product.assetKey || "",
      downloaded: false,
    },
    delivery: {
      type: "file",
      // The agent does NOT hand out a download link or discuss refundability.
      // The file lives in the buyer's Library, which owns the download action
      // and the non-refundable warning.
      message: libraryKey
        ? "Your purchase is confirmed and is now available in your Library."
        : "Your purchase is confirmed. Your file is being prepared and will appear in your Library shortly.",
      savedToLibrary: Boolean(libraryKey),
    },
  };
}

// ── Tracked download: record the download (disables refund), then redirect to
//    a fresh presigned URL for the buyer's library copy. ──
async function downloadOrder(orderId, event) {
  const order = await getOrder(orderId);
  if (!order) return json({ error: "Order not found" }, 404);
  if (order.status === "REFUNDED") {
    return json({ error: "This order was refunded; the file is no longer available." }, 410);
  }
  if (!order.libraryKey) {
    return json({ error: "No downloadable file for this order" }, 404);
  }

  // Mark downloaded (idempotent) — this is what makes the order non-refundable.
  if (order.downloaded !== true) {
    await updateOrderStatus(orderId, order.status, {
      downloaded: true,
      downloadedAt: new Date().toISOString(),
    });
  }

  const filename = (order.libraryKey || "").split("/").pop() || "download";
  const url = await presignLibraryObject(order.libraryKey, filename);
  if (!url) return json({ error: "Could not prepare download" }, 500);

  // 302 redirect so the browser downloads directly; the agent/UI just opens it.
  return {
    statusCode: 302,
    headers: { ...CORS_HEADERS, Location: url },
    body: "",
  };
}

// ── Mock order change (physical orders): update shipping address ──
async function updateOrder(orderId, event) {
  const order = await getOrder(orderId);
  if (!order) return json({ error: "Order not found" }, 404);
  if (order.fulfillmentType !== "physical") {
    return json({ error: "Only physical orders support shipping changes" }, 409);
  }
  if (order.status !== "CONFIRMED" || order.fulfillmentStatus === "SHIPPED") {
    return json({ error: `Order can no longer be changed (status: ${order.status})` }, 409);
  }

  let body = {};
  try { body = JSON.parse(event.body || "{}"); } catch { /* ignore */ }
  const newAddress = body.shippingAddress || body.address;
  if (!newAddress) return json({ error: "shippingAddress is required" }, 400);

  await updateOrderStatus(orderId, order.status, { shippingAddress: newAddress });

  // Re-send the confirmation with the updated address (graceful fallback).
  const product = (order.items && order.items[0]) ? await getProduct(order.items[0].productId) : null;
  let emailRes = { sent: false, preview: "" };
  if (product) {
    emailRes = await sendOrderEmail(order.buyerEmail, { ...order, shippingAddress: newAddress }, product, newAddress);
  }

  return json({
    order: { ...order, shippingAddress: newAddress },
    update: {
      message: emailRes.sent
        ? `Shipping address updated. A new confirmation was sent to ${order.buyerEmail}.`
        : "Shipping address updated.",
      emailSent: emailRes.sent,
      emailPreview: emailRes.sent ? "" : emailRes.preview,
    },
  });
}

// ── Refund: seller-originated reverse payment, governed by a capped session ──
// ``opts.allowForce`` is true only on the authed admin route. The public agent
// path can refund a normal (not-downloaded) order but can never force.
async function refundOrder(orderId, event, opts = {}) {
  const allowForce = opts.allowForce === true;
  const sellerConfig = await getSellerConfig();
  if (!sellerConfig || sellerConfig.status !== "READY") {
    return json({ error: "Seller payout not configured" }, 503);
  }

  const order = await getOrder(orderId);
  if (!order) return json({ error: "Order not found" }, 404);
  if (order.status === "REFUNDED") return json({ error: "Order already refunded", order }, 409);
  if (order.status !== "CONFIRMED") {
    return json({ error: `Only CONFIRMED orders can be refunded (status: ${order.status})` }, 409);
  }
  // Downloaded digital goods are non-refundable via the self-serve / agent
  // path. An admin can still override with force=true (e.g. a support case),
  // which we record on the order for the audit trail.
  let refundBody = {};
  try { refundBody = JSON.parse(event.body || "{}"); } catch { /* ignore */ }
  // force is honored ONLY on the authed admin route. On the public agent path
  // allowForce is false, so a forced flag in the body is ignored — the agent
  // can never override the downloaded-is-final rule.
  const forced = allowForce && (refundBody.force === true || refundBody.force === "true");
  if (order.downloaded === true && !forced) {
    return json({
      error: "This order was already downloaded and is no longer refundable.",
      downloaded: true,
      forceRefundable: true,
    }, 409);
  }
  if (!order.buyerWalletAddress) {
    return json({ error: "No buyer wallet address on order — cannot refund" }, 422);
  }

  // Outbound payment: seller → buyer, on the order's network, governed by a
  // per-refund spend-capped session. All the x402 wire concerns (feePayer,
  // v2 payload, facilitator settle + the "not yet valid" retry) live in the
  // settlePayout facade so this path reads as pure business logic.
  const payout = await settlePayout({
    sellerConfig,
    toAddress: order.buyerWalletAddress,
    network: order.network,
    amountUsd: order.amountUsd,
    amountMinor: order.amountMinor,
  });

  // Only mark REFUNDED when the on-chain settle actually succeeded. Otherwise
  // the funds never moved — leave the order CONFIRMED so it can be retried and
  // report the real reason.
  if (!payout.ok) {
    return json({ error: payout.error, retryable: payout.retryable === true }, 502);
  }

  const refundTx = payout.refundTx || "";
  await updateOrderStatus(orderId, "REFUNDED", {
    refundTx,
    refundedAt: new Date().toISOString(),
    // Audit: was this an admin override of the downloaded-is-final rule?
    forcedRefund: forced === true && order.downloaded === true,
  });
  // Restock the refunded item.
  for (const it of order.items || []) {
    await restockInventory(it.productId, it.qty).catch(() => {});
  }
  // Refunded digital goods leave the buyer's library.
  if (order.libraryKey) {
    await deleteFromLibrary(order.libraryKey).catch(() => {});
  }

  // Notify the buyer of the refund, from the seller's provisioned payout email
  // to the email on the order. Best-effort: works for both the agent's
  // cancel_order path and the admin force-refund, and degrades to nothing when
  // the order has no buyer email or SES is not configured/verified.
  if (order.buyerEmail) {
    await sendRefundEmail(order.buyerEmail, { ...order, status: "REFUNDED" }, sellerConfig.walletEmail).catch(() => {});
  }

  return json({
    order: { ...order, status: "REFUNDED", refundTx },
    refund: { amountUsd: order.amountUsd, network: order.network, to: order.buyerWalletAddress, settled: true, refundTx },
  });
}
