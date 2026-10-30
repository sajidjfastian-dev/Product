import assert from "node:assert/strict";
import test from "node:test";
import {
  catalogSearchTerms, parseAssistantResponse, validateRecommendedProduct,
} from "../src/customerAssistant.js";

test("extracts distinct product-search terms and ignores conversational stop words", () => {
  assert.deepEqual(catalogSearchTerms("Show me a webcam with USB-C, webcam please"), ["webcam", "usb"]);
});

test("bounds catalog search terms and ignores empty or generic queries", () => {
  assert.deepEqual(catalogSearchTerms("show me products in stock"), []);
  assert.deepEqual(catalogSearchTerms("alpha bravo charlie delta echo foxtrot golf hotel india"), [
    "alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel",
  ]);
});

test("accepts a supported customer route with nullable payload fields", () => {
  const parsed = parseAssistantResponse({
    customer_facing_message: "Here are the storage products.",
    routing_action: {
      target_page: "category_listing",
      payload: {
        search_query: null,
        product_id_or_slug: null,
        category_name: "Storage",
      },
    },
  });
  assert.equal(parsed.routing_action.target_page, "category_listing");
  assert.equal(parsed.routing_action.payload.category_name, "Storage");
});

test("only allows product-detail routes for a retrieved product", () => {
  const parsed = parseAssistantResponse({
    customer_facing_message: "Here is the webcam.",
    routing_action: {
      target_page: "product_detail",
      payload: {
        search_query: null,
        product_id_or_slug: "product-123",
        category_name: null,
      },
    },
  });
  assert.equal(validateRecommendedProduct(parsed, [
    { Id: "PRODUCT-123", Name: "Webcam" },
  ]), parsed);
  assert.throws(() => validateRecommendedProduct(parsed, []), /outside the retrieved catalog/);
});

test("rejects route names outside the application route allowlist", () => {
  assert.throws(() => parseAssistantResponse({
    customer_facing_message: "Opening an external site.",
    routing_action: {
      target_page: "https://example.com",
      payload: { search_query: null, product_id_or_slug: null, category_name: null },
    },
  }), /invalid route/);
});

test("rejects malformed or oversized routing payloads", () => {
  assert.throws(() => parseAssistantResponse({
    customer_facing_message: "Try this product.",
    routing_action: {
      target_page: "product_detail",
      payload: { search_query: "x".repeat(201), product_id_or_slug: null, category_name: null },
    },
  }), /invalid route payload/);
});

test("rejects extra fields even when the requested route is valid", () => {
  assert.throws(() => parseAssistantResponse({
    customer_facing_message: "Here are some products.",
    raw_json: "must not be forwarded",
    routing_action: {
      target_page: "stay_on_chat",
      payload: { search_query: null, product_id_or_slug: null, category_name: null },
    },
  }), /missing required fields/);
});

test("rejects empty shopper-facing messages", () => {
  assert.throws(() => parseAssistantResponse({
    customer_facing_message: " ",
    routing_action: {
      target_page: "stay_on_chat",
      payload: { search_query: null, product_id_or_slug: null, category_name: null },
    },
  }), /missing required fields/);
});
