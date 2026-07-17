/**
 * Product seed — CloudFormation custom resource handler.
 * On Create/Update, reconciles seed-products.json into the Products table:
 *   - upserts every product in the seed file (idempotent PutCommand)
 *   - removes any product previously seeded but no longer in the file, so the
 *     catalog always matches the seed exactly (stale items don't linger).
 * On Delete, no-op (table is destroyed with the stack).
 */
import { readFile } from "node:fs/promises";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, ScanCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";

const REGION = process.env.AWS_REGION || "us-east-1";
const PRODUCTS_TABLE = process.env.PRODUCTS_TABLE || "";
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

export const handler = async (event) => {
  const type = event.RequestType;
  if (type === "Delete") {
    return { PhysicalResourceId: "product-seed", Data: { seeded: 0 } };
  }

  const raw = await readFile(new URL("./seed-products.json", import.meta.url), "utf-8");
  const products = JSON.parse(raw);
  const seedIds = new Set(products.map((p) => p.productId));

  let seeded = 0;
  for (const p of products) {
    // Storefront images are served from the static site (/images/<file>),
    // so the catalog references a relative path.
    const item = {
      productId: p.productId,
      name: p.name,
      description: p.description,
      priceUsd: p.priceUsd,
      inventory: p.inventory,
      category: p.category || "General",
      imageUrl: `images/${p.imageFile}`,
      // Fulfillment metadata read by the order service after settle:
      //   digital + file    → presigned S3 download of `assetKey`
      //   digital + license → generated signed redeem token
      //   physical          → SES confirmation email + mock change flow
      fulfillmentType: p.fulfillmentType || "digital",
      deliveryKind: p.deliveryKind || (p.fulfillmentType === "physical" ? "shipment" : "file"),
      assetKey: p.assetKey || "",
      requiresShipping: p.requiresShipping === true,
      active: p.active !== false,
    };
    await ddb.send(new PutCommand({ TableName: PRODUCTS_TABLE, Item: item }));
    seeded += 1;
  }

  // Reconcile: delete any product that was seeded before but is no longer in
  // the seed file (so removing/renaming products takes effect on re-deploy).
  let removed = 0;
  try {
    const existing = await ddb.send(new ScanCommand({
      TableName: PRODUCTS_TABLE,
      ProjectionExpression: "productId",
    }));
    for (const it of existing.Items || []) {
      if (!seedIds.has(it.productId)) {
        await ddb.send(new DeleteCommand({ TableName: PRODUCTS_TABLE, Key: { productId: it.productId } }));
        removed += 1;
      }
    }
  } catch (e) {
    console.error("Seed reconcile (delete stale) failed:", e?.message);
  }

  return { PhysicalResourceId: "product-seed", Data: { seeded, removed } };
};
