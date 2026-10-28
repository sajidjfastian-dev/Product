import assert from "node:assert/strict";
import test from "node:test";
import { makePasswordHash, validPassword, verifyPasswordHash } from "../src/security.js";

test("creates and verifies ASP.NET Core Identity-compatible password hashes", () => {
  const password = "Stockroom-Admin-2026!";
  const encoded = makePasswordHash(password);
  const payload = Buffer.from(encoded, "base64");

  assert.equal(payload[0], 1);
  assert.equal(payload.readUInt32BE(1), 2);
  assert.equal(payload.readUInt32BE(5), 100_000);
  assert.equal(verifyPasswordHash(password, encoded), true);
  assert.equal(verifyPasswordHash("incorrect password", encoded), false);
});

test("enforces the first-run password strength rules", () => {
  assert.equal(validPassword("Stockroom-Admin-2026!"), true);
  assert.equal(validPassword("short"), false);
  assert.equal(validPassword("lowercase-password-2026!"), false);
});
