// Storefront order idempotency: one x402 payment can create at most one order.
//
// Runs the real order service (orders.mjs, shared.mjs, x402.mjs and the
// @x402/* resource server) against DynamoDB Local, with a small in-process x402
// facilitator standing in for the network one. Nothing in the order path is
// mocked, so the conditional writes are checked against real DynamoDB semantics.
//
//   docker run --rm -p 8000:8000 amazon/dynamodb-local
//   cd backend/lambdas/sellers/storefront && npm ci && cd -
//   AWS_ENDPOINT_URL_DYNAMODB=http://localhost:8000 npm run test:storefront
//
// Without AWS_ENDPOINT_URL_DYNAMODB the DynamoDB-backed tests are skipped; the
// pure idempotency-key tests always run.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import crypto from "node:crypto";
import { createRequire } from "node:module";

const STOREFRONT = new URL("../../lambdas/sellers/storefront/", import.meta.url);
const requireFromStorefront = createRequire(new URL("package.json", STOREFRONT));
const ddbEndpoint = process.env.AWS_ENDPOINT_URL_DYNAMODB;

// ── Test configuration (must be set before the order service is imported) ──
const suffix = crypto.randomBytes(4).toString("hex");
const TABLES = {
  PRODUCTS_TABLE: `products-${suffix}`,
  ORDERS_TABLE: `orders-${suffix}`,
  SELLER_CONFIG_TABLE: `seller-config-${suffix}`,
  IDEMPOTENCY_TABLE: `idempotency-${suffix}`,
};
Object.assign(process.env, TABLES, {
  AWS_REGION: process.env.AWS_REGION || "us-east-1",
  AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID || "local",
  AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY || "local",
  LICENSE_SIGNING_SECRET: "test-secret",
});

const SELLER_EVM = "0x1111111111111111111111111111111111111111";
const BUYER_A = "0xAaAaaAAaAaAAaaaAaAAAaaaaAaaaaAaAAAAaaaa1";
const BUYER_B = "0xbBbbBbBbbBbBbbbBBBbBbBbBbbbbbBbbBbbbbbB2";
const PRODUCT_ID = "license-1";

// ── In-process x402 facilitator ──
// Implements /supported, /verify and /settle. Like the reference facilitator it
// rejects an authorization whose nonce was already settled, unless `lenient`
// is set to model a facilitator that does not check on-chain nonce state.
const facilitator = {
  settled: new Set(),
  settleCalls: 0,
  failNextSettle: false,
  lenient: false,
  reset() {
    this.settled.clear();
    this.settleCalls = 0;
    this.failNextSettle = false;
    this.lenient = false;
  },
};
const nonceId = (payload) => {
  const a = payload?.payload?.authorization || {};
  return `${a.from}:${a.nonce}`.toLowerCase();
};
const facilitatorServer = http.createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const body = raw ? JSON.parse(raw) : {};
  const reply = (obj) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(obj));
  };
  const network = body.paymentRequirements?.network;
  const payer = body.paymentPayload?.payload?.authorization?.from;
  if (req.url.endsWith("/supported")) {
    return reply({ kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:84532" }], extensions: [], signers: {} });
  }
  const used = !facilitator.lenient && facilitator.settled.has(nonceId(body.paymentPayload));
  if (req.url.endsWith("/verify")) {
    return reply(used
      ? { isValid: false, invalidReason: "invalid_exact_evm_nonce_already_used", payer }
      : { isValid: true, payer });
  }
  if (req.url.endsWith("/settle")) {
    facilitator.settleCalls++;
    await new Promise((r) => setTimeout(r, 20)); // widen the race window
    const alreadySettled = facilitator.settled.has(nonceId(body.paymentPayload));
    if (facilitator.failNextSettle || alreadySettled) {
      facilitator.failNextSettle = false;
      return reply({ success: false, errorReason: "settlement_failed", transaction: "", network, payer });
    }
    facilitator.settled.add(nonceId(body.paymentPayload));
    return reply({ success: true, transaction: `0x${crypto.randomBytes(32).toString("hex")}`, network, payer });
  }
  res.writeHead(404).end();
});

await new Promise((r) => facilitatorServer.listen(0, "127.0.0.1", r));
process.env.X402_FACILITATOR_URL = `http://127.0.0.1:${facilitatorServer.address().port}`;
after(() => facilitatorServer.close());

// The order service reads its configuration at import time, so import it last.
const { paymentIdempotencyKey } = await import(new URL("x402.mjs", STOREFRONT));
const { handler } = await import(new URL("orders.mjs", STOREFRONT));

// ── Helpers ──
let doc, ddb;

const BUYER_USER_ID = "buyer-user";
const orderEvent = (paymentHeader, userId) => ({
  requestContext: { http: { method: "POST" } },
  rawPath: "/orders",
  headers: { "content-type": "application/json", ...(paymentHeader ? { "payment-signature": paymentHeader } : {}) },
  body: JSON.stringify({ productId: PRODUCT_ID, userId, email: "buyer@example.com" }),
});

const call = async (paymentHeader, userId = BUYER_USER_ID) => {
  const res = await handler(orderEvent(paymentHeader, userId));
  return { status: res.statusCode, headers: res.headers, body: JSON.parse(res.body || "{}") };
};

// Fetch the 402 from the real resource server and sign (structurally) an
// EIP-3009 authorization against the advertised requirements.
async function makeProof({ from = BUYER_A, nonce = `0x${crypto.randomBytes(32).toString("hex")}` } = {}) {
  const challenge = await call();
  assert.equal(challenge.status, 402);
  const required = JSON.parse(Buffer.from(challenge.headers["PAYMENT-REQUIRED"], "base64").toString());
  const accepted = required.accepts.find((a) => a.network === "eip155:84532");
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    x402Version: 2,
    resource: required.resource,
    accepted,
    payload: {
      signature: `0x${"11".repeat(65)}`,
      authorization: { from, to: accepted.payTo, value: accepted.amount, validAfter: String(now - 600), validBefore: String(now + 300), nonce },
    },
  };
  return Buffer.from(JSON.stringify(payload)).toString("base64");
}

async function setInventory(n) {
  await doc.send(new doc.UpdateCommand({
    TableName: TABLES.PRODUCTS_TABLE,
    Key: { productId: PRODUCT_ID },
    UpdateExpression: "SET inventory = :n",
    ExpressionAttributeValues: { ":n": n },
  }));
}
const inventory = async () =>
  (await doc.send(new doc.GetCommand({ TableName: TABLES.PRODUCTS_TABLE, Key: { productId: PRODUCT_ID } }))).Item.inventory;
const orders = async () =>
  (await doc.send(new doc.ScanCommand({ TableName: TABLES.ORDERS_TABLE }))).Items;

// ── Pure key derivation (no DynamoDB needed) ──
describe("paymentIdempotencyKey", () => {
  const reqs = { network: "eip155:84532", asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" };
  const evm = (from, nonce) => ({ payload: { authorization: { from, nonce } } });

  test("is stable for the same payment and ignores EVM hex casing", () => {
    const k = paymentIdempotencyKey(evm(BUYER_A, "0xABCD"), reqs);
    assert.equal(k, paymentIdempotencyKey(evm(BUYER_A.toLowerCase(), "0xabcd"), reqs));
    assert.match(k, /^[0-9a-f]{64}$/);
  });

  test("binds the payer: another wallet reusing a public nonce gets a different key", () => {
    assert.notEqual(paymentIdempotencyKey(evm(BUYER_A, "0x01"), reqs), paymentIdempotencyKey(evm(BUYER_B, "0x01"), reqs));
  });

  test("is scoped to network and asset", () => {
    const p = evm(BUYER_A, "0x01");
    const k = paymentIdempotencyKey(p, reqs);
    assert.notEqual(k, paymentIdempotencyKey(p, { ...reqs, network: "eip155:8453" }));
    assert.notEqual(k, paymentIdempotencyKey(p, { ...reqs, asset: "0x0000000000000000000000000000000000000001" }));
  });

  test("keys Permit2 proofs on (owner, nonce)", () => {
    const permit2 = (from, nonce) => ({ payload: { permit2Authorization: { from, nonce } } });
    assert.equal(paymentIdempotencyKey(permit2(BUYER_A, "7"), reqs), paymentIdempotencyKey(permit2(BUYER_A.toLowerCase(), "7"), reqs));
    assert.notEqual(paymentIdempotencyKey(permit2(BUYER_A, "7"), reqs), paymentIdempotencyKey(permit2(BUYER_B, "7"), reqs));
  });

  // Minimal legacy Solana transaction: 1 signature, then a message with header
  // [1 signer, 0, 0], one account key, a recent blockhash and no instructions.
  const sol = { network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", asset: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU" };
  const solTx = ({ sigByte = 1, blockhashByte = 3 } = {}) => Buffer.concat([
    Buffer.from([1]), Buffer.alloc(64, sigByte),
    Buffer.from([1, 0, 0, 1]), Buffer.alloc(32, 2), Buffer.alloc(32, blockhashByte), Buffer.from([0]),
  ]).toString("base64");
  const solKey = (b64) => paymentIdempotencyKey({ payload: { transaction: b64 } }, sol);

  test("keys a Solana proof on its message, not on how the transaction is spelled", () => {
    const canonical = solTx();
    assert.match(canonical, /=$/, "fixture must need padding");
    const unpadded = canonical.replace(/=+$/, "");
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const spareBitFlipped = unpadded.slice(0, -1) + alphabet[alphabet.indexOf(unpadded.at(-1)) ^ 1];
    const resigned = solTx({ sigByte: 9 });

    for (const variant of [unpadded, spareBitFlipped, resigned]) {
      assert.equal(solKey(variant), solKey(canonical));
    }
  });

  test("distinct Solana payments get distinct keys even when their base64 shares a long prefix", () => {
    const a = solTx({ blockhashByte: 3 });
    const b = solTx({ blockhashByte: 4 });
    assert.equal(a.slice(0, 120), b.slice(0, 120));
    assert.notEqual(solKey(a), solKey(b));
  });
});

// ── Order flow against DynamoDB Local ──
describe("POST /orders idempotency (DynamoDB Local)", { skip: !ddbEndpoint && "set AWS_ENDPOINT_URL_DYNAMODB to run" }, () => {
  before(async () => {
    const { DynamoDBClient, CreateTableCommand } = requireFromStorefront("@aws-sdk/client-dynamodb");
    const lib = requireFromStorefront("@aws-sdk/lib-dynamodb");
    ddb = new DynamoDBClient({ region: process.env.AWS_REGION });
    doc = Object.assign(lib.DynamoDBDocumentClient.from(ddb), lib);
    const keys = { PRODUCTS_TABLE: "productId", ORDERS_TABLE: "orderId", SELLER_CONFIG_TABLE: "pk", IDEMPOTENCY_TABLE: "idempotencyKey" };
    for (const [env, key] of Object.entries(keys)) {
      await ddb.send(new CreateTableCommand({
        TableName: TABLES[env],
        AttributeDefinitions: [{ AttributeName: key, AttributeType: "S" }],
        KeySchema: [{ AttributeName: key, KeyType: "HASH" }],
        BillingMode: "PAY_PER_REQUEST",
      }));
    }
    await doc.send(new doc.PutCommand({
      TableName: TABLES.SELLER_CONFIG_TABLE,
      Item: { pk: "SELLER#default", status: "READY", evmPayToAddress: SELLER_EVM },
    }));
    await doc.send(new doc.PutCommand({
      TableName: TABLES.PRODUCTS_TABLE,
      Item: { productId: PRODUCT_ID, name: "Dataset license", priceUsd: 1, inventory: 10, active: true, fulfillmentType: "digital", deliveryKind: "license" },
    }));
  });

  after(async () => {
    if (!ddb) return;
    const { DeleteTableCommand } = requireFromStorefront("@aws-sdk/client-dynamodb");
    for (const name of Object.values(TABLES)) await ddb.send(new DeleteTableCommand({ TableName: name })).catch(() => {});
  });

  test("concurrent submissions of one proof create one order and settle once", async () => {
    facilitator.reset();
    await setInventory(10);
    const before = (await orders()).length;
    const proof = await makeProof();

    const results = await Promise.all(Array.from({ length: 5 }, () => call(proof)));
    const statuses = results.map((r) => r.status).sort();

    assert.deepEqual(statuses, [201, 409, 409, 409, 409]);
    assert.equal(facilitator.settleCalls, 1);
    assert.equal(await inventory(), 9);
    const created = (await orders()).slice(before);
    assert.equal(created.length, 1);
    assert.equal(created[0].status, "CONFIRMED");
    for (const dup of results.filter((r) => r.status === 409)) {
      assert.equal(dup.body.order, undefined, "a duplicate must not receive order data");
      assert.equal(dup.headers["Retry-After"], "5");
    }
  });

  test("a settled proof replayed to a facilitator that skips nonce checks never reaches settlement", async () => {
    facilitator.reset();
    await setInventory(10);
    const proof = await makeProof();
    const first = await call(proof);
    assert.equal(first.status, 201);

    facilitator.lenient = true;

    // The buyer retrying gets their original order back as a summary.
    const retry = await call(proof);
    assert.equal(retry.status, 200);
    assert.equal(retry.body.note, "idempotent replay");
    assert.equal(retry.body.order.orderId, first.body.order.orderId);
    for (const field of ["licenseToken", "buyerEmail", "buyerWalletAddress", "shippingAddress"]) {
      assert.equal(retry.body.order[field], undefined, `summary must not include ${field}`);
    }

    // Anyone else replaying the (now public) proof learns only that it was used.
    for (const userId of ["someone-else", null]) {
      const replay = await call(proof, userId);
      assert.equal(replay.status, 409);
      assert.equal(replay.body.order, undefined);
      assert.doesNotMatch(JSON.stringify(replay.body), /order-/);
    }

    assert.equal(facilitator.settleCalls, 1, "replays must not reach settlement");
    assert.equal(await inventory(), 9);
  });

  test("a failed settlement releases the claim so the same proof can be retried", async () => {
    facilitator.reset();
    await setInventory(10);
    const proof = await makeProof();

    facilitator.failNextSettle = true;
    const first = await call(proof);
    assert.equal(first.status, 402);
    assert.equal(await inventory(), 10, "stock is returned after a failed settlement");

    const retry = await call(proof);
    assert.equal(retry.status, 201);
    assert.equal(retry.body.order.status, "CONFIRMED");
    assert.equal(await inventory(), 9);
  });

  test("running out of stock releases the claim", async () => {
    facilitator.reset();
    await setInventory(0);
    const proof = await makeProof();
    assert.equal((await call(proof)).status, 409);
    assert.equal(facilitator.settleCalls, 0);

    await setInventory(1);
    assert.equal((await call(proof)).status, 201);
  });

  test("a different wallet reusing the same nonce is an independent payment", async () => {
    facilitator.reset();
    await setInventory(10);
    const nonce = `0x${crypto.randomBytes(32).toString("hex")}`;
    const a = await call(await makeProof({ from: BUYER_A, nonce }));
    const b = await call(await makeProof({ from: BUYER_B, nonce }));

    assert.equal(a.status, 201);
    assert.equal(b.status, 201);
    assert.notEqual(a.body.order.orderId, b.body.order.orderId);
    assert.equal(b.body.order.buyerWalletAddress, BUYER_B);
  });

  test("order ids stay random and are not derived from the payment", async () => {
    facilitator.reset();
    await setInventory(10);
    const res = await call(await makeProof());
    assert.match(res.body.order.orderId, /^order-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  const keyFor = (proof) => {
    const p = JSON.parse(Buffer.from(proof, "base64").toString());
    return paymentIdempotencyKey(p, p.accepted);
  };
  const putRecord = (proof, item) => doc.send(new doc.PutCommand({
    TableName: TABLES.IDEMPOTENCY_TABLE,
    Item: { idempotencyKey: keyFor(proof), ...item },
  }));
  const nowSec = () => Math.floor(Date.now() / 1000);

  test("a claim whose lease lapsed (crashed invocation) is taken over; a live one is not", async () => {
    facilitator.reset();
    await setInventory(10);

    const live = await makeProof();
    await putRecord(live, { status: "IN_PROGRESS", leaseExpiresAt: nowSec() + 120, expiresAt: nowSec() + 86400 });
    const blocked = await call(live);
    assert.equal(blocked.status, 409);
    assert.equal(blocked.headers["Retry-After"], "5");

    const crashed = await makeProof();
    await putRecord(crashed, { status: "IN_PROGRESS", leaseExpiresAt: nowSec() - 1, expiresAt: nowSec() + 86400 });
    assert.equal((await call(crashed)).status, 201);
  });

  test("a record past its TTL counts as free even before DynamoDB deletes it", async () => {
    facilitator.reset();
    await setInventory(10);
    const proof = await makeProof();
    await putRecord(proof, { status: "COMPLETED", orderId: "order-expired", expiresAt: nowSec() - 1 });
    assert.equal((await call(proof)).status, 201);
  });
});
