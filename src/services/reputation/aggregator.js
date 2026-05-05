/**
 * Reputation Aggregator — meta-service that queries multiple agent reputation
 * oracles in parallel and returns a normalized aggregate plus the individual
 * scores, wrapped in a Proof-of-Context f_i attestation.
 *
 * Per-upstream adapters know each upstream's actual schema. Where an upstream
 * requires outbound x402 payment we currently skip and report explicitly,
 * pending an outbound-payment capability on the TrustLayer service.
 *
 * Upstreams currently implemented:
 *   - trustlayer-internal  : own ClawScan + Sentinel registry (no network)
 *   - 8k4protocol           : queries /agents/top free endpoint, looks up by wallet
 *   - agentcrush            : free MCP-style /api/agent/{handle}/trust-summary
 *                             (requires handle param; skipped if address-only)
 *   - thetrustlayer         : env-configurable URL, generic GET /{address}
 *   - mako                  : env-configurable URL, generic GET /{address}
 */

const TIMEOUT_MS = 3000;
const OWN_WEIGHT = 0.30;

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function tierFromScore(score) {
  if (score == null) return null;
  if (score >= 800) return "verified";
  if (score >= 600) return "trusted";
  if (score >= 400) return "established";
  if (score >= 200) return "new";
  return "unverified";
}

/**
 * Internal TrustLayer adapter. Combines ClawScan + Sentinel local data.
 * Returns null score if no record exists for the address.
 */
async function fetchInternal(address, registry) {
  try {
    const internalRecord = registry?.lookupByAddress?.(address);
    if (!internalRecord) {
      return {
        source: "trustlayer-internal",
        source_url: "self",
        score: null,
        tier: null,
        raw: null,
        error: "no internal record for this address (ClawScan + Sentinel registry empty for it)",
      };
    }
    const score = Math.round(internalRecord.score * 10);
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
 * 8k4protocol adapter. Uses the free /agents/top endpoint to scan for the
 * target wallet. The paid /wallet/{wallet}/score endpoint requires outbound
 * x402 payment which is not yet wired on the TrustLayer service.
 */
async function fetch8k4(address) {
  const baseUrl = process.env.EIGHTK4_URL || "https://api.8k4protocol.com";
  const url = `${baseUrl.replace(/\/$/, "")}/agents/top?limit=200&chain=eip155:8453`;
  try {
    const res = await fetchWithTimeout(url, {
      headers: { Accept: "application/json", "User-Agent": "TrustLayer-Aggregator/1.0" },
    });
    if (!res.ok) {
      return {
        source: "8k4protocol",
        source_url: url,
        score: null,
        tier: null,
        error: `upstream ${res.status}`,
      };
    }
    const list = await res.json();
    const items = Array.isArray(list) ? list : list?.results || list?.agents || [];
    const lower = address.toLowerCase();
    const match = items.find(
      (item) =>
        (item.agent_id || "").toLowerCase().includes(lower) ||
        (item.global_id || "").toLowerCase().includes(lower) ||
        (item.wallet || "").toLowerCase() === lower
    );
    if (!match) {
      return {
        source: "8k4protocol",
        source_url: url,
        score: null,
        tier: null,
        error: "address not in top-200 agents (paid /wallet/{wallet}/score endpoint requires outbound x402 payment, not yet wired)",
      };
    }
    let score = typeof match.score === "number" ? match.score : null;
    if (score != null && score <= 100 && score >= 0) score = Math.round(score * 10);
    return {
      source: "8k4protocol",
      source_url: url,
      score,
      tier: match.score_tier || tierFromScore(score),
      raw: match,
    };
  } catch (err) {
    return {
      source: "8k4protocol",
      source_url: url,
      score: null,
      tier: null,
      error: err.name === "AbortError" ? "timeout" : err.message,
    };
  }
}

/**
 * AgentCrush adapter. Endpoint queries by HANDLE, not address. Caller must
 * supply ?handle=X for AgentCrush data to be queryable. The free MCP path
 * is `lookup_agent`; the paid REST endpoint is /api/agent/{handle}/trust-summary
 * at $0.02 (requires outbound x402 payment).
 */
async function fetchAgentCrush(handle) {
  if (!handle) {
    return {
      source: "agentcrush",
      source_url: null,
      score: null,
      tier: null,
      error: "agentcrush requires a `handle` query parameter (not an address). Pass &handle=NAME to enable this provider.",
    };
  }
  const baseUrl = process.env.AGENTCRUSH_URL || "https://www.agentcrush.xyz";
  const url = `${baseUrl.replace(/\/$/, "")}/api/agent/${encodeURIComponent(handle)}/trust-summary`;
  try {
    const res = await fetchWithTimeout(url, {
      headers: { Accept: "application/json", "User-Agent": "TrustLayer-Aggregator/1.0" },
    });
    if (res.status === 402) {
      return {
        source: "agentcrush",
        source_url: url,
        score: null,
        tier: null,
        error: "agentcrush /trust-summary returned 402 — outbound x402 payment ($0.02) required, not yet wired",
      };
    }
    if (!res.ok) {
      return {
        source: "agentcrush",
        source_url: url,
        score: null,
        tier: null,
        error: `upstream ${res.status}`,
      };
    }
    const json = await res.json();
    let score = typeof json.score === "number" ? json.score : null;
    if (score != null && score <= 100 && score >= 0) score = Math.round(score * 10);
    return {
      source: "agentcrush",
      source_url: url,
      score,
      tier: json.tier || tierFromScore(score),
      raw: json,
    };
  } catch (err) {
    return {
      source: "agentcrush",
      source_url: url,
      score: null,
      tier: null,
      error: err.name === "AbortError" ? "timeout" : err.message,
    };
  }
}

/**
 * Generic env-configured upstream adapter (used for thetrustlayer + mako).
 */
async function fetchGeneric(name, urlEnvVar, address) {
  const baseUrl = process.env[urlEnvVar];
  if (!baseUrl) {
    return {
      source: name,
      source_url: null,
      score: null,
      tier: null,
      error: `${urlEnvVar} not configured (set the env var to enable this provider)`,
    };
  }
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
    let score = null;
    if (typeof json.score === "number") score = json.score;
    else if (typeof json.reputation === "number") score = json.reputation;
    else if (typeof json.trust_score === "number") score = json.trust_score;
    else if (typeof json.rating === "number") score = json.rating;
    if (score != null && score <= 100 && score >= 0) score = Math.round(score * 10);
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

function consensusSummary(providers) {
  const total = providers.length;
  const valid = providers.filter((p) => typeof p.score === "number").length;
  const errors = providers.filter((p) => p.error).length;
  if (valid === 0) return "no providers returned a score (all unconfigured, errored, or skipped)";
  if (valid === total) return `${valid} of ${total} providers responded`;
  return `${valid} of ${total} providers responded (${errors} errors / skipped)`;
}

export async function aggregateReputation(address, registry, options = {}) {
  if (!address || typeof address !== "string" || !address.startsWith("0x")) {
    return { error: "address must be a 0x-prefixed hex string", address };
  }

  const fetches = await Promise.all([
    fetchInternal(address, registry),
    fetchGeneric("thetrustlayer", "THETRUSTLAYER_URL", address),
    fetch8k4(address),
    fetchAgentCrush(options.handle),
    fetchGeneric("mako", "MAKO_URL", address),
  ]);

  const aggregate_score = aggregateScores(fetches);
  const tier = tierFromScore(aggregate_score);

  return {
    address,
    handle: options.handle || null,
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
      provider_status: {
        "trustlayer-internal": "self-hosted ClawScan + Sentinel registry",
        thetrustlayer: "env-configured (THETRUSTLAYER_URL); skipped if unset",
        "8k4protocol": "free /agents/top endpoint scan; paid /wallet/{wallet}/score not wired",
        agentcrush: "requires &handle= query; paid /trust-summary not wired",
        mako: "env-configured (MAKO_URL); skipped if unset",
      },
    },
  };
}
