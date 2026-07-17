/**
 * Library + Order History service — authenticated (Cognito JWT), per-buyer.
 *
 *   GET /user/library  → digital deliverables: purchased file goods (not
 *                        refunded) + saved generated media, each with a
 *                        short-lived presigned download URL / tracked path.
 *   GET /user/orders   → full order history: every order the caller placed,
 *                        physical and digital, all statuses, with the details
 *                        needed for a "Your Orders" view.
 *
 * Identity: scoped to the caller's Cognito sub from the JWT claims, so a user
 * only ever sees their own items. Lives on the MAIN authenticated API (not the
 * public storefront API) because it returns private content.
 */
import { json, listLibrary, listOrdersByUser } from "./shared.mjs";

function getUserId(event) {
  const claims = event?.requestContext?.authorizer?.jwt?.claims || {};
  // ID-token only: the API Gateway JWT authorizer also accepts Cognito access
  // tokens (their client_id matches the audience). This app uses ID tokens, so
  // reject anything where token_use !== "id" to avoid token-type confusion.
  if (claims.token_use !== "id") return "";
  return claims.sub || claims["cognito:username"] || "";
}

// Map a raw order record to the fields the Order History UI needs (no raw
// wallet addresses or internal keys).
function toHistoryItem(o) {
  const item = (o.items && o.items[0]) || {};
  return {
    orderId: o.orderId,
    name: item.name || "",
    quantity: item.qty || 1,
    amountUsd: o.amountUsd,
    network: o.network || "ETHEREUM",
    fulfillmentType: o.fulfillmentType || "digital",
    status: o.status,
    downloaded: o.downloaded === true,
    shippingAddress: o.shippingAddress || "",
    estimatedDelivery: o.estimatedDelivery || "",
    refundedAt: o.refundedAt || "",
    forcedRefund: o.forcedRefund === true,
    createdAt: o.createdAt || "",
  };
}

export const handler = async (event) => {
  const method = event.requestContext?.http?.method || "GET";
  if (method === "OPTIONS") return json({ message: "ok" });

  const userId = getUserId(event);
  if (!userId) return json({ error: "Unauthorized" }, 401);

  const rawPath = event.rawPath || event.requestContext?.http?.path || "";

  try {
    if (rawPath.endsWith("/orders")) {
      const orders = await listOrdersByUser(userId);
      const items = orders
        .map(toHistoryItem)
        .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
      return json({ orders: items });
    }
    // Default: digital library.
    const items = await listLibrary(userId);
    return json({ items });
  } catch (err) {
    console.error("Library/history error:", err?.message);
    return json({ error: err.message }, 500);
  }
};
