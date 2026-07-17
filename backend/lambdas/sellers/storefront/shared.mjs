/**
 * Shared helpers for the agent-economy storefront seller lambdas.
 * x402 (HTTP 402 Payment Required) order endpoint + seller-originated refunds.
 *
 * Data protection: this module handles user data (email addresses, order and
 * purchase history, digital library keyed by Cognito sub). Payments settle in
 * stablecoin (USDC) over x402 and no payment card data is ever processed or
 * stored, so PCI-DSS does not apply to this sample. Where end users are EU data
 * subjects, the email and purchase-history fields are personal data under GDPR:
 * production deployments should apply data-protection controls (lawful basis,
 * retention limits, access control, audit, and data-subject request handling)
 * appropriate to their jurisdiction. See the README Security section.
 */
import crypto from "node:crypto";
import {
  DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";

const REGION = process.env.AWS_REGION || "us-east-1";
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
const s3 = new S3Client({ region: REGION });
const ses = new SESClient({ region: REGION });

export const PRODUCTS_TABLE = process.env.PRODUCTS_TABLE || "";
export const ORDERS_TABLE = process.env.ORDERS_TABLE || "";
export const SELLER_CONFIG_TABLE = process.env.SELLER_CONFIG_TABLE || "";
export const SELLER_CONFIG_PK = "SELLER#default";

// Digital delivery buckets:
//   ASSETS_BUCKET  — private store of the seller's deliverable files
//   LIBRARY_BUCKET — per-buyer copies of digital purchases + generated media
export const ASSETS_BUCKET = process.env.ASSETS_BUCKET || "";
export const LIBRARY_BUCKET = process.env.LIBRARY_BUCKET || "";
export const DOWNLOAD_TTL_SECONDS = 900; // 15 min presigned links

// SES sender for physical-order confirmation emails. When unset (or send
// fails), the order still completes and an emailPreview is stored instead.
export const STORE_FROM_EMAIL = process.env.STORE_FROM_EMAIL || "";
// Signing secret for license redeem tokens (entitlement digital goods).
// No hardcoded fallback: the stack injects LICENSE_SIGNING_SECRET (sourced from
// .env, blank by default). If unset we fall back to a per-process random value
// so tokens stay unforgeable; tokens are signed-only (never verified
// server-side), so cross-instance stability is not required.
export const LICENSE_SIGNING_SECRET = process.env.LICENSE_SIGNING_SECRET || crypto.randomUUID();

// x402 networks (testnet)
export const EVM_NETWORK = "eip155:84532";
export const EVM_ASSET = process.env.USDC_CONTRACT || "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
export const SOLANA_NETWORK = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
export const SOLANA_ASSET = process.env.SOLANA_USDC_MINT || "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
export const FACILITATOR_URL = process.env.X402_FACILITATOR_URL || "https://x402.org/facilitator";
export const USDC_DECIMALS = 6;

export const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type,X-Payment,Payment-Signature,Authorization",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Expose-Headers": "PAYMENT-REQUIRED,PAYMENT-RESPONSE",
};

export function json(body, status = 200, extraHeaders = {}) {
  return {
    statusCode: status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS, ...extraHeaders },
    body: JSON.stringify(body),
  };
}

// ── Auth helpers (for admin endpoints on the Cognito-authed main API) ──
// The storefront API itself is Cognito-free (x402 proof authorizes orders),
// but admin lambdas reached through the main API's JWT authorizer use these to
// enforce ID-token-only + admin-group, mirroring the Python require_admin.
function jwtClaims(event) {
  return event?.requestContext?.authorizer?.jwt?.claims || {};
}

export function getUserId(event) {
  const c = jwtClaims(event);
  // ID-token only: the JWT authorizer also accepts Cognito access tokens
  // (their client_id matches the audience). Reject anything not token_use=id.
  if (c.token_use !== "id") return "";
  return c.sub || c["cognito:username"] || "";
}

export function getUserGroups(event) {
  const raw = jwtClaims(event)["cognito:groups"];
  if (raw == null) return [];
  if (Array.isArray(raw)) return raw.map((g) => String(g).trim()).filter(Boolean);
  let s = String(raw).trim();
  if (s.startsWith("[") && s.endsWith("]")) s = s.slice(1, -1);
  return s.replace(/,/g, " ").split(/\s+/).map((p) => p.trim()).filter(Boolean);
}

export function isAdmin(event) {
  return getUserGroups(event).includes("admin");
}

// Returns a 401/403 json() response if the caller is not an admin ID token,
// otherwise null (authorized).
export function requireAdmin(event) {
  const c = jwtClaims(event);
  if (c.token_use !== "id") return json({ error: "Unauthorized: ID token required" }, 401);
  if (!getUserId(event)) return json({ error: "Unauthorized" }, 401);
  if (!isAdmin(event)) return json({ error: "Forbidden: admin group membership required" }, 403);
  return null;
}

// ── DynamoDB helpers ──
export async function getProduct(productId) {
  const r = await ddb.send(new GetCommand({ TableName: PRODUCTS_TABLE, Key: { productId } }));
  return r.Item || null;
}

export async function listProducts() {
  const r = await ddb.send(new ScanCommand({ TableName: PRODUCTS_TABLE }));
  return (r.Items || []).filter((p) => p.active !== false);
}

export async function getOrder(orderId) {
  const r = await ddb.send(new GetCommand({ TableName: ORDERS_TABLE, Key: { orderId } }));
  return r.Item || null;
}

export async function putOrder(order) {
  await ddb.send(new PutCommand({ TableName: ORDERS_TABLE, Item: order }));
}

export async function updateOrderStatus(orderId, status, extra = {}) {
  const names = { "#s": "status" };
  const values = { ":s": status, ":u": new Date().toISOString() };
  let setExpr = "#s = :s, updatedAt = :u";
  Object.entries(extra).forEach(([k, v], i) => {
    names[`#k${i}`] = k;
    values[`:v${i}`] = v;
    setExpr += `, #k${i} = :v${i}`;
  });
  await ddb.send(new UpdateCommand({
    TableName: ORDERS_TABLE,
    Key: { orderId },
    UpdateExpression: `SET ${setExpr}`,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
  }));
}

export async function listOrders(limit = 100) {
  const r = await ddb.send(new ScanCommand({ TableName: ORDERS_TABLE, Limit: limit }));
  return r.Items || [];
}

// List a single buyer's orders via the buyerUserId GSI (newest-first sort done
// by the caller). Used by the order-backed library.
export async function listOrdersByUser(userId, limit = 200) {
  if (!userId) return [];
  try {
    const r = await ddb.send(new QueryCommand({
      TableName: ORDERS_TABLE,
      IndexName: "buyerUserId-index",
      KeyConditionExpression: "buyerUserId = :u",
      ExpressionAttributeValues: { ":u": userId },
      Limit: limit,
    }));
    return r.Items || [];
  } catch (e) {
    console.error("listOrdersByUser failed:", e?.message);
    return [];
  }
}

// Atomic inventory decrement — fails if insufficient stock (no overselling).
export async function reserveInventory(productId, qty) {
  try {
    await ddb.send(new UpdateCommand({
      TableName: PRODUCTS_TABLE,
      Key: { productId },
      UpdateExpression: "SET inventory = inventory - :q",
      ConditionExpression: "inventory >= :q",
      ExpressionAttributeValues: { ":q": qty },
    }));
    return true;
  } catch (e) {
    if (e.name === "ConditionalCheckFailedException") return false;
    throw e;
  }
}

export async function restockInventory(productId, qty) {
  await ddb.send(new UpdateCommand({
    TableName: PRODUCTS_TABLE,
    Key: { productId },
    UpdateExpression: "SET inventory = inventory + :q",
    ExpressionAttributeValues: { ":q": qty },
  }));
}

export async function getSellerConfig() {
  const r = await ddb.send(new GetCommand({ TableName: SELLER_CONFIG_TABLE, Key: { pk: SELLER_CONFIG_PK } }));
  return r.Item || null;
}

export async function putSellerConfig(cfg) {
  await ddb.send(new PutCommand({
    TableName: SELLER_CONFIG_TABLE,
    Item: { pk: SELLER_CONFIG_PK, ...cfg, updatedAt: new Date().toISOString() },
  }));
}

// ── x402 helpers ──
//
// The x402 WIRE FORMAT is no longer hand-rolled here. The inbound path (buyer
// pays the storefront) is handled by the @x402/* resource server in x402.mjs;
// the outbound path (seller refunds the buyer) is handled by payments.mjs.
// This module keeps only the two primitives both facades share: the USD->minor
// conversion and the facilitator feePayer lookup.

// Solana x402 payments are gasless: the facilitator sponsors the transaction
// fee, so the payer must sign a transaction that names the facilitator's
// feePayer. The feePayer is not static config — it comes from the facilitator's
// /supported endpoint — so we fetch it once per container and cache it. The
// inbound resource server fetches this itself via initialize(); payments.mjs
// (refunds) uses this helper. EVM does not need it.
let _solanaFeePayerCache; // undefined = not fetched, null = unavailable, string = address

export async function getSolanaFeePayer() {
  if (_solanaFeePayerCache !== undefined) return _solanaFeePayerCache;
  try {
    const base = FACILITATOR_URL.replace(/\/+$/, "");
    const resp = await fetch(`${base}/supported`, {
      method: "GET",
      headers: { Accept: "application/json" },
      redirect: "follow",
    });
    if (!resp.ok) throw new Error(`supported returned ${resp.status}`);
    const data = await resp.json();
    const kinds = Array.isArray(data?.kinds) ? data.kinds : [];
    const match =
      kinds.find((k) => k.network === SOLANA_NETWORK && k.scheme === "exact" && k?.extra?.feePayer) ||
      kinds.find((k) => String(k.network || "").startsWith("solana:") && k.scheme === "exact" && k?.extra?.feePayer);
    _solanaFeePayerCache = match?.extra?.feePayer || null;
    if (!_solanaFeePayerCache) {
      console.warn("Facilitator /supported has no Solana feePayer; Solana refunds will fail validation");
    }
  } catch (e) {
    console.error("Failed to fetch Solana feePayer from facilitator /supported:", e.message);
    _solanaFeePayerCache = null;
  }
  return _solanaFeePayerCache;
}

// USD price string ("$0.05") → integer minor units (6-decimal USDC).
export function usdToMinor(priceUsd) {
  const n = typeof priceUsd === "string" ? parseFloat(priceUsd.replace(/[^0-9.]/g, "")) : Number(priceUsd);
  return String(Math.round(n * 10 ** USDC_DECIMALS));
}

// ── Digital delivery helpers ──

// Presign a GET for an object in a bucket (15 min default).
async function presign(bucket, key, ttl = DOWNLOAD_TTL_SECONDS, filename = "") {
  const params = { Bucket: bucket, Key: key };
  if (filename) {
    params.ResponseContentDisposition = `attachment; filename="${filename}"`;
  }
  return getSignedUrl(s3, new GetObjectCommand(params), { expiresIn: ttl });
}

// Presign a download for a product's deliverable file in the assets bucket.
export async function presignDeliverable(assetKey, filename = "") {
  if (!ASSETS_BUCKET || !assetKey) return "";
  try {
    return await presign(ASSETS_BUCKET, assetKey, DOWNLOAD_TTL_SECONDS, filename);
  } catch (e) {
    console.error("presignDeliverable failed:", e?.message);
    return "";
  }
}

// Presign a download for an object already in the library bucket (used by the
// tracked download endpoint so the buyer gets the persisted copy).
export async function presignLibraryObject(libraryKey, filename = "") {
  if (!LIBRARY_BUCKET || !libraryKey) return "";
  try {
    return await presign(LIBRARY_BUCKET, libraryKey, DOWNLOAD_TTL_SECONDS, filename);
  } catch (e) {
    console.error("presignLibraryObject failed:", e?.message);
    return "";
  }
}

// Delete a buyer's library copy (called on refund so refunded goods leave the
// library). Best-effort.
export async function deleteFromLibrary(libraryKey) {
  if (!LIBRARY_BUCKET || !libraryKey) return false;
  try {
    const { DeleteObjectCommand } = await import("@aws-sdk/client-s3");
    await s3.send(new DeleteObjectCommand({ Bucket: LIBRARY_BUCKET, Key: libraryKey }));
    return true;
  } catch (e) {
    console.error("deleteFromLibrary failed:", e?.message);
    return false;
  }
}

// Copy a delivered file into the buyer's library (so it persists past the
// short-lived presigned link). Best-effort — never blocks the order.
export async function copyToLibrary(userId, sourceKey, productId) {
  if (!LIBRARY_BUCKET || !ASSETS_BUCKET || !userId || !sourceKey) return "";
  try {
    const obj = await s3.send(new GetObjectCommand({ Bucket: ASSETS_BUCKET, Key: sourceKey }));
    const body = await obj.Body.transformToByteArray();
    const base = sourceKey.split("/").pop() || "download";
    const libKey = `library/${userId}/${productId}/${base}`;
    await s3.send(new PutObjectCommand({
      Bucket: LIBRARY_BUCKET,
      Key: libKey,
      Body: body,
      ContentType: obj.ContentType || "application/octet-stream",
      Metadata: { productId, userId },
    }));
    return libKey;
  } catch (e) {
    console.error("copyToLibrary failed:", e?.message);
    return "";
  }
}

// Generate a signed, opaque redeem token for entitlement digital goods
// (API credits, dataset license, compute hour). HMAC over the claims so the
// seller can later verify a token it issued without a database lookup.
export function makeLicenseToken(productId, orderId, userId) {
  const claims = { p: productId, o: orderId, u: userId || "", t: Date.now() };
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const sig = crypto
    .createHmac("sha256", LICENSE_SIGNING_SECRET)
    .update(payload)
    .digest("base64url");
  return `LIC.${payload}.${sig}`;
}

// Send a physical-order confirmation email via SES. Returns
// { sent: bool, preview: string }. Degrades gracefully when SES is not
// configured or the send fails — the order still completes. `fromEmail` is the
// seller's provisioned payout email; STORE_FROM_EMAIL is the fallback sender.
export async function sendOrderEmail(toEmail, order, product, shippingAddress, fromEmail = "") {
  const source = fromEmail || STORE_FROM_EMAIL;
  const lines = [
    `Order confirmed: ${order.orderId}`,
    ``,
    `Item: ${product.name}`,
    `Amount: ${order.amountUsd} USDC on ${order.network === "SOLANA" ? "Solana Devnet" : "Base Sepolia"}`,
    `Ships to: ${shippingAddress || "address on file"}`,
    ``,
    `This is a demo storefront order. To change the shipping address or`,
    `quantity, use the order update endpoint`,
    `(POST /orders/${order.orderId}/update) before the order ships.`,
  ];
  const preview = lines.join("\n");

  if (!source || !toEmail) {
    return { sent: false, preview };
  }
  try {
    await ses.send(new SendEmailCommand({
      Source: source,
      Destination: { ToAddresses: [toEmail] },
      Message: {
        Subject: { Data: `Your order ${order.orderId} is confirmed` },
        Body: { Text: { Data: preview } },
      },
    }));
    return { sent: true, preview };
  } catch (e) {
    console.error("sendOrderEmail failed:", e?.message);
    return { sent: false, preview };
  }
}

// Send a refund confirmation from the seller's payout email to the buyer who is
// being refunded. Best-effort: degrades to a preview when SES is not configured,
// the sender identity is not verified, or the buyer has no email on the order.
export async function sendRefundEmail(toEmail, order, fromEmail = "") {
  const source = fromEmail || STORE_FROM_EMAIL;
  const itemName = (order.items && order.items[0] && order.items[0].name) || "your order";
  const lines = [
    `Refund processed: ${order.orderId}`,
    ``,
    `Item: ${itemName}`,
    `Refunded: ${order.amountUsd} USDC on ${order.network === "SOLANA" ? "Solana Devnet" : "Base Sepolia"}`,
    ``,
    `The amount has been returned to the wallet you paid from.`,
    `This is a demo storefront refund.`,
  ];
  const preview = lines.join("\n");

  if (!source || !toEmail) {
    return { sent: false, preview };
  }
  try {
    await ses.send(new SendEmailCommand({
      Source: source,
      Destination: { ToAddresses: [toEmail] },
      Message: {
        Subject: { Data: `Your order ${order.orderId} was refunded` },
        Body: { Text: { Data: preview } },
      },
    }));
    return { sent: true, preview };
  } catch (e) {
    console.error("sendRefundEmail failed:", e?.message);
    return { sent: false, preview };
  }
}

// List a buyer's library: purchased digital-file goods (order-backed, so
// refunded items disappear and downloaded items are flagged non-refundable)
// plus generated media saved under library/{userId}/generated/.
//
// Purchased files use a tracked download path (the order service mints the
// presigned URL on demand and records the download), so the item carries an
// `orderId` rather than a raw URL — the caller builds the short download link.
export async function listLibrary(userId) {
  if (!userId) return [];
  const items = [];

  // 1. Purchased digital-file goods from orders.
  try {
    const orders = await listOrdersByUser(userId);
    for (const o of orders) {
      // Only confirmed digital-file purchases that still have a library copy
      // and have not been refunded belong in the library.
      const isFile = (o.fulfillmentType || "digital") === "digital" && o.libraryKey;
      if (!isFile) continue;
      if (o.status === "REFUNDED") continue;
      const it = (o.items && o.items[0]) || {};
      items.push({
        kind: "purchase",
        orderId: o.orderId,
        name: it.name || (o.libraryKey || "").split("/").pop(),
        productId: it.productId || "",
        purchasedAt: o.createdAt,
        downloaded: o.downloaded === true,
        // A file is refundable until it has been downloaded.
        refundable: o.downloaded !== true,
      });
    }
  } catch (e) {
    console.error("listLibrary (orders) failed:", e?.message);
  }

  // 2. Generated media saved under library/{userId}/generated/.
  if (LIBRARY_BUCKET) {
    try {
      const { ListObjectsV2Command } = await import("@aws-sdk/client-s3");
      const r = await s3.send(new ListObjectsV2Command({
        Bucket: LIBRARY_BUCKET,
        Prefix: `library/${userId}/generated/`,
        MaxKeys: 200,
      }));
      for (const o of r.Contents || []) {
        items.push({
          kind: "generated",
          key: o.Key,
          name: (o.Key || "").split("/").pop(),
          size: o.Size,
          createdAt: o.LastModified,
          url: await presign(LIBRARY_BUCKET, o.Key, DOWNLOAD_TTL_SECONDS),
        });
      }
    } catch (e) {
      console.error("listLibrary (generated) failed:", e?.message);
    }
  }

  items.sort((a, b) => {
    const ta = new Date(a.purchasedAt || a.createdAt || 0).getTime();
    const tb = new Date(b.purchasedAt || b.createdAt || 0).getTime();
    return tb - ta;
  });
  return items;
}
