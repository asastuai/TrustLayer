/**
 * Proof-of-Context (PoC) — minimal attestation wrapper for BaseOracle responses.
 *
 * Implements a viable subset of the Proof-of-Context primitive defined in
 * github.com/asastuai/proof-of-context (position paper v0.6) and the Rust
 * reference implementation in github.com/asastuai/proof-of-context-impl.
 *
 * What this provides
 * ------------------
 * - `f_i` (input freshness) attestation on every paid endpoint response.
 * - Ed25519 signature over (response_payload_hash, source_id, timestamp, freshness_horizon).
 * - Triple-anchor candidate (block height, drand round, server timestamp) — only the
 *   server timestamp is hard-attested in this stage; block_height and drand_round
 *   are emitted as informational best-effort context until Phase 5 (TEE chain).
 *
 * What this does NOT provide (yet)
 * --------------------------------
 * - TEE attestation chain (TDX + H100). Stub field present.
 * - On-chain anchoring of the commitment Merkle root. Local-only signature.
 * - Cross-chain verification.
 *
 * Honest framing for consumers
 * ----------------------------
 * The signature proves the BaseOracle operator vouches for the freshness of the
 * data at the timestamp of signing. It does NOT prove the upstream data source
 * (DexScreener, Basescan) was honest. That layer is upstream and outside this
 * primitive's scope.
 */

import { signAsync, getPublicKeyAsync, verifyAsync, etc } from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha2";
import { createHash } from "node:crypto";
import { buildAnchors } from "./poc-anchors.js";

// noble/ed25519 v2.x: wire sha512 implementation via the etc namespace.
// Used internally by async signing / verification primitives.
etc.sha512Async = async (...m) => sha512(etc.concatBytes(...m));

/**
 * Configuration loaded from env at module init.
 * - POC_SIGNING_KEY: hex-encoded 32-byte Ed25519 private key. Required.
 * - POC_SOURCE_ID: short string identifying this TrustLayer instance.
 * - POC_FRESHNESS_HORIZON_SECONDS: max age (seconds) at which the consumer
 *   should treat the response as fresh. Defaults to per-endpoint cache TTL.
 */
const POC_SIGNING_KEY_HEX = process.env.POC_SIGNING_KEY;
const POC_SOURCE_ID = process.env.POC_SOURCE_ID || "trustlayer:default";

let _publicKeyHex = null;
let _privateKeyBytes = null;

if (POC_SIGNING_KEY_HEX && POC_SIGNING_KEY_HEX.length === 64) {
  _privateKeyBytes = Uint8Array.from(
    POC_SIGNING_KEY_HEX.match(/.{1,2}/g).map((b) => parseInt(b, 16))
  );
  // public key derivation deferred to first attestation call (async) for cold-start speed
}

/**
 * Hex-encode a Uint8Array.
 */
function toHex(bytes) {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * SHA-256 of canonical JSON (sorted keys, no whitespace, RFC 8259).
 *
 * Exported because it is the canonical-hash construction tested by the
 * cross-language test vectors at github.com/asastuai/proof-of-context.
 */
export function canonicalHash(payload) {
  const ordered = sortKeys(payload);
  const json = JSON.stringify(ordered);
  return createHash("sha256").update(json).digest("hex");
}

/**
 * Recursively sort object keys for canonical JSON serialization.
 */
function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.keys(value)
      .sort()
      .reduce((acc, k) => {
        acc[k] = sortKeys(value[k]);
        return acc;
      }, {});
  }
  return value;
}

/**
 * Get (and lazily compute) the public key derived from POC_SIGNING_KEY.
 */
export async function getPublicKey() {
  if (!_privateKeyBytes) return null;
  if (_publicKeyHex) return _publicKeyHex;
  const pk = await getPublicKeyAsync(_privateKeyBytes);
  _publicKeyHex = toHex(pk);
  return _publicKeyHex;
}

/**
 * Wrap a data payload with a PoC attestation.
 *
 * @param {object} payload         - The response data to attest over.
 * @param {object} opts
 * @param {string} opts.endpoint   - The endpoint path that produced the data.
 * @param {number} opts.freshnessHorizonSeconds - Max age at which consumer should
 *                                                trust the data as fresh.
 * @param {string} opts.freshnessType - One of "f_c", "f_m", "f_i", "f_s". Defaults to "f_i".
 * @returns {Promise<object>} payload extended with `_poc` attestation block.
 */
export async function attest(payload, opts = {}) {
  const timestamp = new Date().toISOString();
  const freshnessHorizonSeconds = opts.freshnessHorizonSeconds ?? 60;
  const endpoint = opts.endpoint ?? "unknown";
  const freshnessType = opts.freshnessType ?? "f_i";

  const payloadHash = canonicalHash(payload);

  // The signing surface: every field a consumer needs to verify.
  const signingMessage = JSON.stringify({
    payload_hash: payloadHash,
    source_id: POC_SOURCE_ID,
    endpoint,
    timestamp,
    freshness_horizon_seconds: freshnessHorizonSeconds,
    freshness_type: freshnessType,
  });

  let signatureHex = null;
  let publicKeyHex = null;

  if (_privateKeyBytes) {
    const messageBytes = new TextEncoder().encode(signingMessage);
    const sig = await signAsync(messageBytes, _privateKeyBytes);
    signatureHex = toHex(sig);
    publicKeyHex = await getPublicKey();
  }

  // Triple-anchor: best-effort fetch of block_height + drand_round when
  // POC_ENABLE_TRIPLE_ANCHOR is set. Otherwise null. See poc-anchors.js.
  const anchors = await buildAnchors();
  anchors.server_timestamp = timestamp;

  return {
    ...payload,
    _poc: {
      version: "0.1",
      freshness_type: freshnessType,
      source_id: POC_SOURCE_ID,
      endpoint,
      timestamp,
      freshness_horizon_seconds: freshnessHorizonSeconds,
      payload_hash: payloadHash,
      signature: signatureHex, // null if no signing key configured
      public_key: publicKeyHex,
      anchors,
      // What this attestation does NOT prove. Stated explicitly per the
      // honesty principle of the Aletheia stack.
      scope_disclaimer:
        "Operator vouches for freshness at timestamp of signing. Upstream source honesty is not attested.",
    },
  };
}

/**
 * Verify a PoC attestation. Returns { valid, reason }.
 *
 * Verification checks:
 * 1. Signature is well-formed.
 * 2. Public key matches the expected operator.
 * 3. Re-computed payload hash matches the attested hash.
 * 4. Age (now - timestamp) <= freshness_horizon_seconds.
 *
 * @param {object} attestedPayload - Object returned by attest().
 * @param {object} opts
 * @param {string} opts.expectedPublicKey - Hex-encoded operator public key.
 * @returns {Promise<{valid: boolean, reason: string}>}
 */
export async function verify(attestedPayload, opts = {}) {
  if (!attestedPayload || !attestedPayload._poc) {
    return { valid: false, reason: "missing_poc_block" };
  }

  const poc = attestedPayload._poc;

  if (!poc.signature) {
    return { valid: false, reason: "no_signature" };
  }

  const ageSeconds =
    (Date.now() - new Date(poc.timestamp).getTime()) / 1000;
  if (ageSeconds > poc.freshness_horizon_seconds) {
    return {
      valid: false,
      reason: `stale: age=${ageSeconds.toFixed(1)}s, horizon=${poc.freshness_horizon_seconds}s`,
    };
  }

  // Re-compute payload hash (excluding the _poc block itself).
  const { _poc, ...rawPayload } = attestedPayload;
  const recomputed = canonicalHash(rawPayload);
  if (recomputed !== poc.payload_hash) {
    return { valid: false, reason: "payload_hash_mismatch" };
  }

  // Verify signature.
  const signingMessage = JSON.stringify({
    payload_hash: poc.payload_hash,
    source_id: poc.source_id,
    endpoint: poc.endpoint,
    timestamp: poc.timestamp,
    freshness_horizon_seconds: poc.freshness_horizon_seconds,
    freshness_type: poc.freshness_type,
  });
  const messageBytes = new TextEncoder().encode(signingMessage);
  const sigBytes = Uint8Array.from(
    poc.signature.match(/.{1,2}/g).map((b) => parseInt(b, 16))
  );
  const pubBytes = Uint8Array.from(
    poc.public_key.match(/.{1,2}/g).map((b) => parseInt(b, 16))
  );

  try {
    const ok = await verifyAsync(sigBytes, messageBytes, pubBytes);
    if (!ok) return { valid: false, reason: "signature_invalid" };
  } catch (e) {
    return { valid: false, reason: `signature_check_failed: ${e.message}` };
  }

  if (opts.expectedPublicKey && poc.public_key !== opts.expectedPublicKey) {
    return { valid: false, reason: "operator_mismatch" };
  }

  return { valid: true, reason: "ok" };
}
