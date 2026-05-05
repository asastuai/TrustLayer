/**
 * Reputation Aggregator — meta-service that queries multiple agent reputation
 * oracles in parallel and returns a normalized aggregate plus the individual
 * scores, wrapped in a Proof-of-Context f_i attestation.
 *
 * Adapters are pluggable. Each adapter implements:
 *   async fetch(address) → { score, tier, raw, source_url, error? }
 *
 * URLs are configured via env vars so individual upstream integrations can be
 * tuned per deployment without code changes.
 */

const TIMEOUT_MS = 3000;

// Score normalization — every adapter must return a 0..1000 score.
// Aggregate weighting: our own internal score has weight 0.30, each external
// has weight equal share of the remaining 0.70.
const OWN_WEIGHT = 0.30;

/**
 * Generic timeout wrapper for fetch with abort control.
 */
async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Tier label from numeric score, 0..1000 scale.
 */
function tierFromScore(score) {
  if (score == null) return null;
  if (score >= 800) return "verified";
  if (score >= 600) return "trusted";
  if (score >= 400) return "established";
  if (score >= 200) return "new";
  return "unverified";
}

/**
 * Internal TrustLayer adapter.
 * Combines the latest ClawScan trust_score (if scanned) and the latest
 * Sentinel SLA reliability score (if monitored), into a single 0..1000 score.
 *
 * If we have neither, returns score = null with reason "no record".
 */
async function fetchInternal(address, registry) {
  try {
    // Lookup the address in our own ClawScan registry by skill association.
    // For now: if no record, return null. Future: link ClawScan results to
    // address via on-chain agent registration.
    const internalRecord = registry?.lookupByAddress?.(address);
    if (!internalRecord) {
      return {
        source: "trustlayer-internal",
        source_url: "self",
        score: null,
        tier: null,
        raw: null,
        error: "no internal record for this address",
      };
    }
    const score = Math.round(internalRecord.score * 10); // assume 0..100 → 0..1000
    return {
      source: "trustlayer-internal",
      source_url: "self",
      score,
      tier: tierFromScore(score),
      raw: internalRecord,
    };
  } catch (err) {
    return {
      source: "trustlayer-internal",
      source_url: "self",
      score: null,
      tier: null,
      error: `internal lookup failed: ${err.message}`,
    };
  }
}

/**
 * External upstream adapter — generic JSON GET with score normalization
 * heuristic.
 *
 * If the configured URL env var is missing, returns "not configured" so the
 * endpoint stays functional during phased integration.
 */
async function fetchExternal(name, urlEnvVar, address) {
  const baseUrl = process.env[urlEnvVar];
  if (!baseUrl) {
    return {
      source: name,
      source_url: null,
      score: null,
      tier: null,
      error: `${urlEnvVar} not configured`,
    };
  }
  // Best-effort URL pattern: append the address as path segment.
  // Each upstream may use a different shape; production-ready integration
  // requires per-adapter URL templating once the actual API is known.
  const url = `${baseUrl.replace(/\/$/, "")}/${address}`;
  try {
    const res = await fetchWithTimeout(url, {
      headers: { Accept: "application/json", "User-Agent": "TrustLayer-Aggregator/1.0" },
    });
    if (!res.ok) {
      return {
        source: name,
        source_url: url,
        score: null,
        tier: null,
        error: `upstream ${res.status}`,
      };
    }
    const json = await res.json();
    // Heuristic score extraction: try common field names.
    let score = null;
    if (typeof json.score === "number") score = json.score;
    else if (typeof json.reputation === "number") score = json.reputation;
    else if (typeof json.trust_score === "number") score = json.trust_score;
    else if (typeof json.rating === "number") score = json.rating;

    // Heuristic normalization: if score appears to be 0..100, scale to 0..1000.
    if (score != null && score <= 100 && score >= 0) {
      score = Math.round(score * 10);
    }

    return {
      source: name,
      source_url: url,
      score,
      tier: tierFromScore(score),
      raw: json,
    };
  } catch (err) {
    return {
      source: name,
      source_url: url,
      score: null,
      tier: null,
      error: err.name === "AbortError" ? "timeout" : err.message,
    };
  }
}

/**
 * Aggregate scores from all providers using weighted average.
 * Providers with score = null are excluded from the aggregate.
 */
function aggregateScores(providers) {
  const ownProvider = providers.find((p) => p.source === "trustlayer-internal");
  const externals = providers.filter((p) => p.source !== "trustlayer-internal");
  const validExternals = externals.filter((p) => typeof p.score === "number");

  let weightedSum = 0;
  let totalWeight = 0;

  if (ownProvider && typeof ownProvider.score === "number") {
    weightedSum += ownProvider.score * OWN_WEIGHT;
    totalWeight += OWN_WEIGHT;
  }

  if (validExternals.length > 0) {
    const externalWeightShare = (1 - OWN_WEIGHT) / validExternals.length;
    for (const p of validExternals) {
      weightedSum += p.score * externalWeightShare;
      totalWeight += externalWeightShare;
    }
  }

  if (totalWeight === 0) return null;
  return Math.round(weightedSum / totalWeight);
}

/**
 * Build a consensus-summary string for human / agent readability.
 */
function consensusSummary(providers) {
  const total = providers.length;
  const valid = providers.filter((p) => typeof p.score === "number").length;
  const errors = providers.filter((p) => p.error).length;
  if (valid === 0) return "no providers returned a score";
  if (valid === total) return `${valid} of ${total} providers responded`;
  return `${valid} of ${total} providers responded (${errors} timeouts or errors)`;
}

/**
 * Public entry point. Returns a structured aggregate response — the route
 * handler then wraps it with a PoC f_i attestation via sendAttested().
 */
export async function aggregateReputation(address, registry) {
  if (!address || typeof address !== "string" || !address.startsWith("0x")) {
    return {
      error: "address must be a 0x-prefixed hex string",
      address,
    };
  }

  const fetches = await Promise.all([
    fetchInternal(address, registry),
    fetchExternal("thetrustlayer", "THETRUSTLAYER_URL", address),
    fetchExternal("8k4protocol", "EIGHTK4_URL", address),
    fetchExternal("agentcrush", "AGENTCRUSH_URL", address),
    fetchExternal("mako", "MAKO_URL", address),
  ]);

  const aggregate_score = aggregateScores(fetches);
  const tier = tierFromScore(aggregate_score);

  return {
    address,
    aggregate_score,
    tier,
    consensus: consensusSummary(fetches),
    providers: fetches,
    methodology: {
      score_scale: "0..1000",
      weighting: `internal=${OWN_WEIGHT}, externals share remaining ${1 - OWN_WEIGHT} equally`,
      timeout_ms_per_upstream: TIMEOUT_MS,
      tier_thresholds: {
        verified: ">= 800",
        trusted: "600-799",
        established: "400-599",
        new: "200-399",
        unverified: "0-199",
      },
    },
  };
}
