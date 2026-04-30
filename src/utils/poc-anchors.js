/**
 * Real-anchor fetchers for Proof-of-Context attestations.
 *
 * Mirrors the `proof-of-context-impl` Rust crate's `clients` module:
 *   - Drand mainnet round from a public mirror (Cloudflare default).
 *   - EVM block height from a JSON-RPC endpoint (`eth_blockNumber`).
 *
 * Fetches are cached in-memory with TTLs aligned to each clock's cadence:
 *   - Drand: 30s period → 25s cache.
 *   - Base block: 2s target → 1.5s cache.
 *
 * Opt-in via env: set `POC_ENABLE_TRIPLE_ANCHOR=1` to populate
 * `anchors.block_height` and `anchors.drand_round` on every attestation.
 * Without it (default), those fields remain null and the attestation falls
 * back to the server timestamp as the only binding clock.
 *
 * Configurable via:
 *   - POC_DRAND_URL (default https://drand.cloudflare.com)
 *   - POC_BASE_RPC_URL (default https://mainnet.base.org)
 */

const DRAND_URL = process.env.POC_DRAND_URL || "https://drand.cloudflare.com";
const BASE_RPC_URL =
  process.env.POC_BASE_RPC_URL || "https://mainnet.base.org";

const TRIPLE_ANCHOR_ENABLED =
  process.env.POC_ENABLE_TRIPLE_ANCHOR === "1" ||
  process.env.POC_ENABLE_TRIPLE_ANCHOR === "true";

const DRAND_CACHE_MS = 25_000; // Drand emits every 30s.
const BLOCK_CACHE_MS = 1_500; // Base targets 2s.

let _drandCache = { value: null, expiresAt: 0 };
let _blockCache = { value: null, expiresAt: 0 };

/**
 * Fetch the latest Drand round from the configured mirror.
 * Returns the round number (integer) or null on failure.
 */
async function fetchDrandRound() {
  const now = Date.now();
  if (_drandCache.value !== null && now < _drandCache.expiresAt) {
    return _drandCache.value;
  }

  try {
    const resp = await fetch(`${DRAND_URL}/public/latest`, {
      headers: { Accept: "application/json" },
    });
    if (!resp.ok) return null;
    const body = await resp.json();
    if (typeof body.round !== "number") return null;
    _drandCache = { value: body.round, expiresAt: now + DRAND_CACHE_MS };
    return body.round;
  } catch {
    // Silent fail — anchors are best-effort; null is honest.
    return null;
  }
}

/**
 * Fetch the latest block height from the configured EVM RPC endpoint.
 * Returns the block number (integer) or null on failure.
 */
async function fetchBlockHeight() {
  const now = Date.now();
  if (_blockCache.value !== null && now < _blockCache.expiresAt) {
    return _blockCache.value;
  }

  try {
    const resp = await fetch(BASE_RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_blockNumber",
        params: [],
      }),
    });
    if (!resp.ok) return null;
    const body = await resp.json();
    if (typeof body.result !== "string") return null;
    const trimmed = body.result.startsWith("0x")
      ? body.result.slice(2)
      : body.result;
    const height = parseInt(trimmed, 16);
    if (Number.isNaN(height)) return null;
    _blockCache = { value: height, expiresAt: now + BLOCK_CACHE_MS };
    return height;
  } catch {
    return null;
  }
}

/**
 * Build the `anchors` block for a PoC commitment. Returns an object with
 * server_timestamp (always), and block_height + drand_round (when
 * `POC_ENABLE_TRIPLE_ANCHOR` is set and fetches succeed).
 *
 * Honest contract: when triple-anchor is disabled or any fetch fails, the
 * corresponding field is null. Consumers verifying the attestation should
 * treat null as "no claim made about this clock", not "this clock said zero".
 */
export async function buildAnchors() {
  const serverTimestamp = new Date().toISOString();

  if (!TRIPLE_ANCHOR_ENABLED) {
    return {
      server_timestamp: serverTimestamp,
      block_height: null,
      drand_round: null,
    };
  }

  const [drandRound, blockHeight] = await Promise.all([
    fetchDrandRound(),
    fetchBlockHeight(),
  ]);

  return {
    server_timestamp: serverTimestamp,
    block_height: blockHeight,
    drand_round: drandRound,
  };
}

/** Internal caches exposed for tests. */
export const _internals = {
  resetCaches: () => {
    _drandCache = { value: null, expiresAt: 0 };
    _blockCache = { value: null, expiresAt: 0 };
  },
  isEnabled: () => TRIPLE_ANCHOR_ENABLED,
};
