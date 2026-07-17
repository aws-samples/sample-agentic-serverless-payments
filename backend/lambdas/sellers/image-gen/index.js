import { Hono } from "hono";
import { handle } from "hono/aws-lambda";
import { paymentMiddlewareFromHTTPServer, x402ResourceServer, x402HTTPResourceServer } from "@x402/hono";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { registerExactEvmScheme } from "@x402/evm/exact/server";
import { registerExactSvmScheme } from "@x402/svm/exact/server";
import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";

const REGION = process.env.AWS_REGION || "us-east-1";

const X402_CONFIG = {
  facilitatorUrl: process.env.X402_FACILITATOR_URL || "https://x402.org/facilitator",
  evmNetwork: "eip155:84532",
  solanaNetwork: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
  price: "$0.04",
};

// Seller payout wallet comes from the single AgentCore-provisioned seller
// identity created on the admin Seller Setup page (DynamoDB), the SAME wallet
// the storefront pays out from — not static deploy-time env addresses. This
// keeps one seller identity across the demo and means funding that wallet's
// Solana token account once (the Seller Setup page explains how) clears the
// first-payment ATA requirement for every paid endpoint at once.
const SELLER_CONFIG_TABLE = process.env.SELLER_CONFIG_TABLE || "";
const SELLER_CONFIG_PK = "SELLER#default";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

async function getSellerConfig() {
  if (!SELLER_CONFIG_TABLE) return null;
  const r = await ddb.send(new GetCommand({ TableName: SELLER_CONFIG_TABLE, Key: { pk: SELLER_CONFIG_PK } }));
  return r.Item || null;
}

// A Money string ("$0.04") per accept lets each scheme run its money conversion
// (resolves the canonical USDC asset and injects the required `extra`:
// name/version for EVM, feePayer for Solana). payTo is the provisioned wallet.
function buildAccepts(sellerConfig) {
  const accepts = [];
  if (sellerConfig?.evmPayToAddress) {
    accepts.push({ scheme: "exact", price: X402_CONFIG.price, network: X402_CONFIG.evmNetwork, payTo: sellerConfig.evmPayToAddress });
  }
  if (sellerConfig?.solPayToAddress) {
    accepts.push({ scheme: "exact", price: X402_CONFIG.price, network: X402_CONFIG.solanaNetwork, payTo: sellerConfig.solPayToAddress });
  }
  return accepts;
}

const app = new Hono();
const bedrock = new BedrockRuntimeClient({ region: REGION });

// Request logging
app.use("*", async (c, next) => {
  const start = Date.now();
  // Log only non-sensitive request metadata. Payment-signature presence/length
  // is intentionally omitted to avoid a side channel for tracking payment
  // attempts in production logs.
  console.log(JSON.stringify({
    event: "request_in", method: c.req.method, path: c.req.path,
  }));
  await next();
  console.log(JSON.stringify({
    event: "response_out", method: c.req.method, path: c.req.path,
    status: c.res.status, durationMs: Date.now() - start,
  }));
});

// ── x402 middleware, built lazily per container ──
// The payout addresses live in DynamoDB (written by Seller Setup), so the
// resource server is built on the first request after reading the seller
// config, then cached for the life of the container. The provisioned wallet is
// static per deploy, so capturing it once is safe — same reasoning as the
// storefront's cached resource server.
let _middlewarePromise = null;

async function getPaymentMiddleware() {
  if (!_middlewarePromise) {
    _middlewarePromise = (async () => {
      const sellerConfig = await getSellerConfig();
      const accepts = buildAccepts(sellerConfig);
      if (!accepts.length) {
        // No provisioned seller wallet yet → no payment middleware. The route
        // handler below returns a clear 503 so the caller knows to run Seller
        // Setup, rather than getting an opaque x402 error.
        return null;
      }
      const facilitatorClient = new HTTPFacilitatorClient({ url: X402_CONFIG.facilitatorUrl });
      const server = new x402ResourceServer(facilitatorClient);
      registerExactEvmScheme(server);
      registerExactSvmScheme(server);
      const httpServer = new x402HTTPResourceServer(server, { "POST /image-gen": { accepts } });
      await httpServer.initialize(); // fetch /supported (feePayer, supported kinds)
      return paymentMiddlewareFromHTTPServer(httpServer, undefined, undefined, false);
    })();
  }
  return _middlewarePromise;
}

app.use("/image-gen", async (c, next) => {
  if (c.req.method !== "POST") return next();
  const mw = await getPaymentMiddleware();
  if (!mw) {
    return c.json({
      x402_content: { type: "text", data: "Seller wallet is not configured yet. Run Seller Setup in the admin page to provision a payout wallet.", title: "Seller not configured", mime_type: "text/plain" },
      x402_meta: { seller: "ai-image-gen", version: "1.0" },
    }, 503);
  }
  return mw(c, next);
});

app.post("/image-gen", async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const { prompt } = body;

    if (!prompt || typeof prompt !== "string") {
      return c.json({
        x402_content: { type: "text", data: 'Missing required field: "prompt"', title: "Invalid request", mime_type: "text/plain" },
        x402_meta: { seller: "ai-image-gen", version: "1.0" },
      }, 400);
    }

    const command = new InvokeModelCommand({
      modelId: "amazon.nova-canvas-v1:0",
      contentType: "application/json",
      accept: "application/json",
      body: JSON.stringify({
        taskType: "TEXT_IMAGE",
        textToImageParams: { text: prompt.slice(0, 512) },
        imageGenerationConfig: { numberOfImages: 1, width: 1024, height: 1024, quality: "standard" },
      }),
    });

    const response = await bedrock.send(command);
    const result = JSON.parse(new TextDecoder().decode(response.body));
    const imageBase64 = result.images?.[0];

    if (!imageBase64) {
      return c.json({
        x402_content: { type: "text", data: "Nova Canvas returned no image", title: "Image generation failed", mime_type: "text/plain" },
        x402_meta: { seller: "ai-image-gen", version: "1.0" },
      }, 502);
    }

    const shortPrompt = prompt.length > 60 ? prompt.slice(0, 57) + "..." : prompt;

    return c.json({
      x402_content: { type: "image", data: imageBase64, title: `Generated: ${shortPrompt}`, mime_type: "image/png" },
      x402_meta: { seller: "ai-image-gen", version: "1.0", generated_at: new Date().toISOString() },
    });
  } catch (err) {
    // Log detail server-side; return a generic message to the client so raw
    // error detail (which may echo prompt/API internals) is not exposed.
    console.error("Image gen error:", err?.message);
    return c.json({
      x402_content: { type: "text", data: "Image generation failed. Please try again.", title: "Generation failed", mime_type: "text/plain" },
      x402_meta: { seller: "ai-image-gen", version: "1.0" },
    }, 500);
  }
});

app.get("/health", (c) => c.json({ status: "ok" }));

export const handler = handle(app);
