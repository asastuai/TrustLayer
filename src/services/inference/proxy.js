/**
 * Inference proxy — forwards prompts to a configured upstream LLM provider
 * (Anthropic, OpenAI, or Google Gemini) and returns the response wrapped with
 * a Proof-of-Context f_m attestation. The attestation binds the model
 * identity, prompt hash, response bytes, and token counts so a downstream
 * consumer can verify provenance.
 *
 * Differentiator: zero of 605 services on agentic.market today ship signed
 * inference responses. This is the natural extension of the Aletheia stack
 * into the largest single category on the marketplace.
 */

import { sha256 } from "@noble/hashes/sha2";

const SUPPORTED_PROVIDERS = ["anthropic", "openai", "gemini"];
const DEFAULT_MODELS = {
  anthropic: "claude-sonnet-4-6-20251022",
  openai: "gpt-5",
  gemini: "gemini-2.5-pro",
};

const MODEL_CUTOFFS = {
  "claude-sonnet-4-6-20251022": "2025-10",
  "claude-opus-4-7": "2026-01",
  "gpt-5": "2025-08",
  "gpt-4o": "2024-10",
  "gemini-2.5-pro": "2025-09",
};

const TIMEOUT_MS = 60000; // 60s — LLM responses can be slow
const MAX_OUTPUT_TOKENS_DEFAULT = 1024;
const MAX_OUTPUT_TOKENS_HARD_CAP = 4096;

/**
 * Hex encoding helper for hash bytes.
 */
function toHex(bytes) {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * SHA-256 of UTF-8 prompt text. Used as the prompt_hash in the PoC block so
 * downstream consumers can verify that the reported prompt matches what was
 * actually sent to the upstream model.
 */
function hashPrompt(prompt) {
  const bytes = new TextEncoder().encode(prompt);
  return toHex(sha256(bytes));
}

/**
 * Generic fetch with timeout for upstream calls.
 */
async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Provider adapter — Anthropic Claude.
 */
async function callAnthropic(model, prompt, maxTokens) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY not configured on this TrustLayer instance");
  }
  const res = await fetchWithTimeout("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "(unable to read error body)");
    throw new Error(`Anthropic ${res.status}: ${errText.slice(0, 200)}`);
  }
  const data = await res.json();
  return {
    text: data.content?.[0]?.text || "",
    input_tokens: data.usage?.input_tokens ?? null,
    output_tokens: data.usage?.output_tokens ?? null,
    model_returned: data.model || model,
    raw_id: data.id || null,
  };
}

/**
 * Provider adapter — OpenAI GPT.
 */
async function callOpenAI(model, prompt, maxTokens) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY not configured on this TrustLayer instance");
  }
  const res = await fetchWithTimeout("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_completion_tokens: maxTokens,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "(unable to read error body)");
    throw new Error(`OpenAI ${res.status}: ${errText.slice(0, 200)}`);
  }
  const data = await res.json();
  return {
    text: data.choices?.[0]?.message?.content || "",
    input_tokens: data.usage?.prompt_tokens ?? null,
    output_tokens: data.usage?.completion_tokens ?? null,
    model_returned: data.model || model,
    raw_id: data.id || null,
  };
}

/**
 * Provider adapter — Google Gemini (v1beta endpoint).
 */
async function callGemini(model, prompt, maxTokens) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY not configured on this TrustLayer instance");
  }
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const res = await fetchWithTimeout(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: maxTokens },
    }),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "(unable to read error body)");
    throw new Error(`Gemini ${res.status}: ${errText.slice(0, 200)}`);
  }
  const data = await res.json();
  return {
    text: data.candidates?.[0]?.content?.parts?.[0]?.text || "",
    input_tokens: data.usageMetadata?.promptTokenCount ?? null,
    output_tokens: data.usageMetadata?.candidatesTokenCount ?? null,
    model_returned: model,
    raw_id: null,
  };
}

const PROVIDER_DISPATCH = {
  anthropic: callAnthropic,
  openai: callOpenAI,
  gemini: callGemini,
};

/**
 * Public entry — orchestrates the call and returns a structured response.
 * The route handler then wraps the result with sendAttested().
 */
export async function runInference({ provider, model, prompt, max_tokens }) {
  if (!provider || !SUPPORTED_PROVIDERS.includes(provider)) {
    return {
      error: `provider must be one of: ${SUPPORTED_PROVIDERS.join(", ")}`,
      providers_supported: SUPPORTED_PROVIDERS,
    };
  }
  if (!prompt || typeof prompt !== "string") {
    return { error: "prompt is required and must be a string" };
  }
  if (prompt.length > 32_000) {
    return { error: "prompt too long (max 32,000 characters in this version)" };
  }

  const resolvedModel = model || DEFAULT_MODELS[provider];
  const resolvedMaxTokens = Math.min(
    typeof max_tokens === "number" ? max_tokens : MAX_OUTPUT_TOKENS_DEFAULT,
    MAX_OUTPUT_TOKENS_HARD_CAP
  );

  const promptHash = hashPrompt(prompt);
  const startedAt = new Date().toISOString();

  let upstream;
  try {
    upstream = await PROVIDER_DISPATCH[provider](resolvedModel, prompt, resolvedMaxTokens);
  } catch (err) {
    return {
      error: `inference failed: ${err.message}`,
      provider,
      model: resolvedModel,
      prompt_hash: promptHash,
      started_at: startedAt,
    };
  }

  const completedAt = new Date().toISOString();
  const responseHash = toHex(
    sha256(new TextEncoder().encode(upstream.text))
  );

  return {
    provider,
    model_requested: resolvedModel,
    model_returned: upstream.model_returned,
    model_cutoff: MODEL_CUTOFFS[upstream.model_returned] || MODEL_CUTOFFS[resolvedModel] || "unknown",
    prompt_hash: promptHash,
    response: upstream.text,
    response_hash: responseHash,
    tokens: {
      input: upstream.input_tokens,
      output: upstream.output_tokens,
      max_requested: resolvedMaxTokens,
    },
    timing: {
      started_at: startedAt,
      completed_at: completedAt,
    },
    upstream_id: upstream.raw_id,
  };
}
