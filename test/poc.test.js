/**
 * Tests for the TrustLayer PoC attestation primitive.
 *
 * TrustLayer is a multi-service producer (ClawScan, QABot, Sentinel, Escrow),
 * so the same primitive must support all four freshness types: f_c, f_m, f_s.
 *
 * Run with: npm test
 */

import { test } from "node:test";
import assert from "node:assert/strict";

process.env.POC_SIGNING_KEY =
  "3333333333333333333333333333333333333333333333333333333333333333";
process.env.POC_SOURCE_ID = "trustlayer:test";

const { attest, verify, getPublicKey } = await import("../src/utils/poc.js");

test("attest emits f_c attestation for ClawScan-like response", async () => {
  const payload = { skill: "example", trust_score: 85 };
  const result = await attest(payload, {
    endpoint: "/api/v1/skill/scan",
    freshnessType: "f_c",
    freshnessHorizonSeconds: 3600,
  });
  assert.equal(result._poc.freshness_type, "f_c");
  assert.equal(result._poc.endpoint, "/api/v1/skill/scan");
  assert.equal(result._poc.freshness_horizon_seconds, 3600);
});

test("attest emits f_m attestation for QABot-like response", async () => {
  const payload = { target: "https://x", passed: 12, failed: 1 };
  const result = await attest(payload, {
    endpoint: "/api/v1/qa/test",
    freshnessType: "f_m",
    freshnessHorizonSeconds: 3600,
  });
  assert.equal(result._poc.freshness_type, "f_m");
});

test("attest emits f_s attestation for Escrow-like response", async () => {
  const payload = { escrow_id: "esc_xyz", state: "FUNDED" };
  const result = await attest(payload, {
    endpoint: "/api/v1/escrow/create",
    freshnessType: "f_s",
    freshnessHorizonSeconds: 86400,
  });
  assert.equal(result._poc.freshness_type, "f_s");
  assert.equal(result._poc.freshness_horizon_seconds, 86400);
});

test("verify accepts a fresh, well-signed attestation", async () => {
  const attested = await attest({ x: 1 }, {
    endpoint: "/api/v1/sla/report",
    freshnessType: "f_c",
    freshnessHorizonSeconds: 60,
  });
  const result = await verify(attested);
  assert.equal(result.valid, true, `expected valid, got: ${result.reason}`);
});

test("verify rejects when payload is mutated", async () => {
  const attested = await attest({ score: 90 }, {
    endpoint: "/api/v1/skill/lookup",
    freshnessType: "f_c",
    freshnessHorizonSeconds: 60,
  });
  attested.score = 0;
  const result = await verify(attested);
  assert.equal(result.valid, false);
  assert.equal(result.reason, "payload_hash_mismatch");
});

test("verify rejects when past horizon", async () => {
  const attested = await attest({ x: 1 }, {
    endpoint: "/api/v1/sla/report",
    freshnessType: "f_c",
    freshnessHorizonSeconds: 1,
  });
  await new Promise((r) => setTimeout(r, 1500));
  const result = await verify(attested);
  assert.equal(result.valid, false);
  assert.match(result.reason, /^stale:/);
});

test("getPublicKey returns hex when signing key is configured", async () => {
  const pk = await getPublicKey();
  assert.ok(pk);
  assert.equal(pk.length, 64);
});

test("attest defaults freshness_type to f_i if not provided", async () => {
  const result = await attest({ x: 1 }, {
    endpoint: "/api/v1/info",
    freshnessHorizonSeconds: 60,
  });
  assert.equal(result._poc.freshness_type, "f_i");
});
