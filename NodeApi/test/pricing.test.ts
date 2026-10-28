import assert from "node:assert/strict";
import test from "node:test";
import { calculateSaleTotals, roundCurrency } from "../src/pricing.js";

test("calculates line and order discounts after rounding each line", () => {
  const totals = calculateSaleTotals([
    { unitPrice: 12.99, quantity: 2, discountPercent: 10 },
    { unitPrice: 4.5, quantity: 1, discountPercent: 0 },
  ], 5);

  assert.deepEqual(totals, {
    subtotal: 27.88,
    lineDiscount: 2.6,
    orderDiscount: 1.39,
    total: 26.49,
  });
});

test("full discounts produce a zero total without negative currency", () => {
  const totals = calculateSaleTotals([
    { unitPrice: 5, quantity: 3, discountPercent: 100 },
  ], 100);

  assert.equal(totals.subtotal, 0);
  assert.equal(totals.total, 0);
  assert.equal(roundCurrency(0.1 + 0.2), 0.3);
});
