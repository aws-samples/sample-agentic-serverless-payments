/**
 * Order service refund / download / update state-transition tests.
 *
 *   npm test        (from backend/lambdas/sellers/storefront)
 *
 * The x402 facade and the seller payout are mocked; shared.mjs runs for real
 * against an in-memory DynamoDB that enforces condition expressions and
 * interleaves concurrent requests (see fake-dynamodb.mjs).
 */
import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";

process.env.ORDERS_TABLE = "Orders";
process.env.PRODUCTS_TABLE = "Products";
process.env.SELLER_CONFIG_TABLE = "SellerConfig";
process.env.LIBRARY_BUCKET = "library-bucket";
// Static credentials so S3 URL presigning (a local computation) works offline.
process.env.AWS_REGION = "us-east-1";
process.env.AWS_ACCESS_KEY_ID = "AKIDTEST";
process.env.AWS_SECRET_ACCESS_KEY = "test-secret";

const { installFakeDynamoDB } = await import("./fake-dynamodb.mjs");
const db = installFakeDynamoDB();
// No network: library copy/delete calls against S3 succeed as no-ops.
const { S3Client } = await import("@aws-sdk/client-s3");
mock.method(S3Client.prototype, "send", async () => ({}));

// ── Mocked x402 facade ──
// Only verify/settle are replaced (they talk to the facilitator); every other
// export is the real implementation, loaded under a distinct URL so the mock
// below does not intercept it. The proof header is JSON so tests can shape it.
const realX402 = await import("../x402.mjs?actual");
const x402 = { settleCalls: 0, settle: async () => ({ ok: true, body: { success: true, transaction: "0xsettle" } }) };
mock.module("../x402.mjs", {
  namedExports: {
    ...realX402,
    verifyOrder: async (event) => {
      const h = event.headers?.["payment-signature"];
      if (!h) return { kind: "unpaid", response: { status: 402, headers: {}, body: { accepts: [] } } };
      const paymentPayload = JSON.parse(h);
      return { kind: "verified", http: {}, paymentPayload, paymentRequirements: { network: paymentPayload.network } };
    },
    settleOrder: async (...args) => { x402.settleCalls++; return x402.settle(...args); },
  },
});

// ── Mocked seller payout: slow, like a real ProcessPayment + on-chain settle ──
const payouts = { calls: 0, result: { ok: true, refundTx: "0xrefund" } };
mock.module("../payments.mjs", {
  namedExports: {
    settlePayout: async () => { payouts.calls++; await sleep(20); return payouts.result; },
  },
});

const { handler } = await import("../orders.mjs");

// ── Fixtures ──
const PRODUCT = { productId: "lic-1", name: "Dataset License", priceUsd: 2.5, inventory: 10, active: true, fulfillmentType: "digital", deliveryKind: "license" };

beforeEach(() => {
  db.reset();
  db.put("SellerConfig", { pk: "SELLER#default", status: "READY", evmPayToAddress: "0xseller", solPayToAddress: "SoLSeller111" });
  db.put("Products", { ...PRODUCT });
  x402.settleCalls = 0;
  x402.settle = async () => ({ ok: true, body: { success: true, transaction: "0xsettle" } });
  payouts.calls = 0;
  payouts.result = { ok: true, refundTx: "0xrefund" };
});

const evmProof = (nonce, from = "0xbuyer") => JSON.stringify({
  x402Version: 2, network: "eip155:84532",
  payload: { authorization: { from, nonce }, signature: "0xsig" },
});
const order = (proof, body = { productId: "lic-1", userId: "user-1" }) => ({
  rawPath: "/orders",
  requestContext: { http: { method: "POST" } },
  headers: proof ? { "payment-signature": proof } : {},
  body: JSON.stringify(body),
});
const refund = (orderId, { admin = false, force = false } = {}) => ({
  rawPath: admin ? `/admin/storefront/orders/${orderId}/refund` : `/orders/${orderId}/refund`,
  requestContext: {
    http: { method: "POST" },
    ...(admin ? { authorizer: { jwt: { claims: { sub: "admin-1", token_use: "id", "cognito:groups": "[admin]" } } } } : {}),
  },
  pathParameters: { id: orderId },
  headers: {},
  body: JSON.stringify(force ? { force: true } : {}),
});
const download = (orderId) => ({
  rawPath: `/orders/${orderId}/download`,
  requestContext: { http: { method: "GET" } },
  pathParameters: { id: orderId },
  headers: {},
});
const parse = (res) => ({ status: res.statusCode, body: res.body ? JSON.parse(res.body) : {} });
const inventory = () => db.get("Products", { productId: "lic-1" }).inventory;

async function placeConfirmedOrder(proof = evmProof("0xn1")) {
  const res = parse(await handler(order(proof)));
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.order.orderId;
}

// ── Refunds ──────────────────────────────────────────────────────────────

test("concurrent refunds of one order pay the buyer exactly once", async () => {
  const orderId = await placeConfirmedOrder();

  const results = (await Promise.all([1, 2, 3, 4, 5].map(() => handler(refund(orderId))))).map(parse);

  assert.equal(payouts.calls, 1, "seller payout must run once per order");
  assert.equal(results.filter((r) => r.status === 200).length, 1);
  assert.ok(results.filter((r) => r.status !== 200).every((r) => r.status === 409));
  assert.equal(db.get("Orders", { orderId }).status, "REFUNDED");
  assert.equal(inventory(), PRODUCT.inventory, "restocked exactly once");
});

test("a failed payout returns the order to CONFIRMED so the refund can be retried", async () => {
  const orderId = await placeConfirmedOrder();
  payouts.result = { ok: false, error: "not yet valid", retryable: true };

  const failed = parse(await handler(refund(orderId)));
  assert.equal(failed.status, 502);
  assert.equal(failed.body.retryable, true);
  assert.equal(db.get("Orders", { orderId }).status, "CONFIRMED");

  payouts.result = { ok: true, refundTx: "0xrefund" };
  const retried = parse(await handler(refund(orderId)));
  assert.equal(retried.status, 200);
  assert.equal(db.get("Orders", { orderId }).status, "REFUNDED");
});

async function placeDownloadableOrder(proof = evmProof("0xdl")) {
  const orderId = await placeConfirmedOrder(proof);
  // libraryKey is what makes /download serve the buyer's library copy.
  db.put("Orders", { ...db.get("Orders", { orderId }), libraryKey: "library/user-1/lic-1.md", downloaded: false });
  return orderId;
}

test("a download that lands while a refund is paying out is refused", async () => {
  const orderId = await placeDownloadableOrder();

  const refunding = handler(refund(orderId));
  await sleep(5); // the payout is now in flight
  const d = parse(await handler(download(orderId)));
  const r = parse(await refunding);

  assert.equal(r.status, 200);
  assert.equal(d.status, 409, "goods must not be handed out during a refund");
  assert.equal(db.get("Orders", { orderId }).downloaded, false);
});

// Matches an UpdateCommand whose SET clause assigns `attr` (not one that only
// mentions it in a condition).
const writesAttr = (attr) => (name, input) =>
  name === "UpdateCommand" &&
  Object.entries(input.ExpressionAttributeNames || {}).some(
    ([placeholder, real]) => real === attr && input.UpdateExpression.includes(`${placeholder} = `),
  );

test("a late download write cannot flip a refunded order back to CONFIRMED", async () => {
  const orderId = await placeDownloadableOrder();
  // The download reads CONFIRMED, but its write lands after the refund finished.
  db.delayWrites(writesAttr("downloaded"), 60);

  const [, r] = (await Promise.all([handler(download(orderId)), handler(refund(orderId))])).map(parse);

  assert.equal(r.status, 200);
  assert.equal(db.get("Orders", { orderId }).status, "REFUNDED");
  // An admin force-refund must not find a refundable order and pay a second time.
  await handler(refund(orderId, { admin: true, force: true }));
  assert.equal(payouts.calls, 1, "the buyer is refunded at most once");
});

test("a late shipping-address write cannot reopen a refunded order", async () => {
  db.put("Products", { ...PRODUCT, productId: "phys-1", fulfillmentType: "physical" });
  const placed = parse(await handler(order(evmProof("0xship"), { productId: "phys-1", userId: "user-1" })));
  const orderId = placed.body.order.orderId;
  db.delayWrites(writesAttr("shippingAddress"), 60);

  const [r] = (await Promise.all([
    handler(refund(orderId)),
    handler({
      rawPath: `/orders/${orderId}/update`,
      requestContext: { http: { method: "POST" } },
      pathParameters: { id: orderId },
      headers: {},
      body: JSON.stringify({ shippingAddress: "1 New St" }),
    }),
  ])).map(parse);

  assert.equal(r.status, 200);
  assert.equal(db.get("Orders", { orderId }).status, "REFUNDED");
  await handler(refund(orderId, { admin: true, force: true }));
  assert.equal(payouts.calls, 1, "the buyer is refunded at most once");
});

test("the public refund route never honors force on a downloaded order", async () => {
  const orderId = await placeConfirmedOrder();
  db.put("Orders", { ...db.get("Orders", { orderId }), downloaded: true });

  const res = parse(await handler({ ...refund(orderId), body: JSON.stringify({ force: true }) }));
  assert.equal(res.status, 409);
  assert.equal(payouts.calls, 0);
});
