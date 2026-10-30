import assert from "node:assert/strict";
import test from "node:test";
import { productDocument, retrieveProductMatches } from "../src/productKnowledge.js";

test("builds product knowledge from descriptive fields without volatile inventory facts", () => {
  const document = productDocument({
    Name: "Wireless Headphones",
    Category: "Audio",
    Brand: "Example",
    Sku: "AUD-1",
    Barcode: "12345",
    Location: "Aisle 2",
    Description: "Noise cancelling over-ear headphones.",
  });
  assert.match(document, /Wireless Headphones/);
  assert.match(document, /Noise cancelling/);
  assert.doesNotMatch(document, /price|stock/i);
});

test("returns no products for queries without searchable terms", async () => {
  assert.deepEqual(await retrieveProductMatches("show me products in stock", []), []);
});
