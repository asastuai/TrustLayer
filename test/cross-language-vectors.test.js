/**
 * Cross-language test vectors for the Proof-of-Context wire format v0.1.
 *
 * Source of truth:
 *   github.com/asastuai/proof-of-context/blob/main/test-vectors/v0.1.json
 *
 * If any of these tests fail, TrustLayer's canonical-hash construction has
 * drifted from the spec. The cross-implementation verification chain
 * across TrustLayer, TrustLayer, Vigil, PayClaw, and proof-of-context-impl
 * depends on every implementation producing these exact hashes for these
 * exact payloads.
 *
 * The vectors are inlined here so the test does not require network access
 * or a sibling-repo file path. The authoritative copies live in the spec
 * repository.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalHash } from "../src/utils/poc.js";

const VECTORS = [
  {
    id: "v1-simple-flat",
    payload: { token: "ETH", price_usd: 2500 },
    expected_canonical_json: '{"price_usd":2500,"token":"ETH"}',
    expected_sha256_hex:
      "5525810608ca0d5ec814d45159e4f11e09a533061f04f4193850b3ca2fc5c453",
  },
  {
    id: "v2-nested-with-array",
    payload: {
      feed: "ETH/USD",
      status: "healthy",
      metrics: { staleness_seconds: 12, deviation_pct: 0.014 },
      sources: ["chainlink", "pyth"],
    },
    expected_canonical_json:
      '{"feed":"ETH/USD","metrics":{"deviation_pct":0.014,"staleness_seconds":12},"sources":["chainlink","pyth"],"status":"healthy"}',
    expected_sha256_hex:
      "e37d05d4f5f4f3b18ecea8d7e0253aca799ad7e06d3f2c20b6b5cab39769443d",
  },
  {
    id: "v3-empty-object",
    payload: {},
    expected_canonical_json: "{}",
    expected_sha256_hex:
      "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
  },
];

for (const v of VECTORS) {
  test(`vector ${v.id} produces the expected SHA-256 hash`, () => {
    const got = canonicalHash(v.payload);
    assert.equal(
      got,
      v.expected_sha256_hex,
      `TrustLayer canonical-hash drift detected on ${v.id}.\n` +
        `  expected: ${v.expected_sha256_hex}\n` +
        `  got:      ${got}\n` +
        `  payload:  ${JSON.stringify(v.payload)}`
    );
  });
}
