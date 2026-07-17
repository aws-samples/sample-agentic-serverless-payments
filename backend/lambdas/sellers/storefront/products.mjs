/**
 * Product / Inventory service — FREE, public, no payment.
 *   GET /products        → list active products (storefront catalog)
 *   GET /products/{id}   → single product detail
 *
 * The storefront frontend reads this live. Browsing is free; only checkout
 * (the Order service) requires an x402 payment.
 */
import { json, getProduct, listProducts } from "./shared.mjs";

export const handler = async (event) => {
  const method = event.requestContext?.http?.method || "GET";
  const productId = event.pathParameters?.id;

  if (method === "OPTIONS") return json({ message: "ok" });

  try {
    if (productId) {
      const product = await getProduct(productId);
      if (!product) return json({ error: "Product not found" }, 404);
      return json({ product });
    }
    const products = await listProducts();
    // Sort by price ascending for a tidy catalog.
    products.sort((a, b) => Number(a.priceUsd) - Number(b.priceUsd));
    return json({ products });
  } catch (err) {
    console.error("Products error:", err?.message);
    return json({ error: err.message }, 500);
  }
};
