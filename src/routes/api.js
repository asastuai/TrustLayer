import { Router } from "express";
import { scanSkill } from "../services/clawscan/scanner.js";
import { runTests } from "../services/qabot/tester.js";
import {
  registerService, getServiceSLA, getLeaderboard, getLiveStatus, pingAllServices,
} from "../services/sentinel/sentinel.js";
import {
  createEscrow, fundEscrow, deliverEscrow, acceptEscrow,
  disputeEscrow, getEscrow, getEscrowsByAddress, getEscrowStats,
} from "../services/escrow/escrow.js";
import {
  saveSkillScan, lookupSkill, saveQAReport, lookupQAReport,
  getGlobalStats, incrementEscrows,
} from "../data/registry.js";
import { attest, getPublicKey } from "../utils/poc.js";

const router = Router();

/**
 * Wrap a JSON response with a PoC attestation. The freshness type varies by
 * service: ClawScan → f_c, QABot → f_m, Sentinel → f_c, Escrow → f_s.
 * Consumers verify the operator's signature against the public key returned
 * by /api/v1/poc/public-key before treating the attestation as load-bearing.
 */
async function sendAttested(res, data, endpoint, freshnessType, freshnessHorizonSeconds) {
  const attested = await attest(data, { endpoint, freshnessType, freshnessHorizonSeconds });
  res.json(attested);
}

// ============================================
// MASTER INFO
// ============================================

router.get("/api/v1/info", (req, res) => {
  res.json({
    name: "TrustLayer",
    description: "The Trust Layer for the Agent Economy — 4 services in 1 API",
    version: "1.0.0",
    chain: "Base (eip155:8453)",
    payment: "x402 (USDC on Base)",
    services: {
      clawscan: {
        description: "Skill Auditor — scan skills for malware, prompt injection, credential theft",
        trust_model: "Automated static analysis. Pattern database from ClawHavoc campaign intelligence.",
      },
      qabot: {
        description: "Agent QA — test agents for accuracy, safety, and adversarial robustness",
        trust_model: "Automated HTTP testing against target URL. Tests availability, x402 compliance, safety, adversarial resilience.",
      },
      sentinel: {
        description: "SLA Monitor — track uptime, latency, and reliability of x402 services",
        trust_model: "Automated pinging every 60s. All data independently verifiable.",
      },
      clawvault: {
        description: "Payment Protection — escrow for agent-to-agent transactions",
        trust_model: "⚠️ CENTRALIZED BETA — TrustLayer operates as custodian during escrow. V2 will use on-chain smart contract. Use for small amounts only.",
        version: "v1-centralized-beta",
      },
    },
    free_endpoints: [
      "GET /api/v1/info", "GET /api/v1/health", "GET /api/v1/stats",
      "GET /api/v1/skill/lookup?name=X", "GET /api/v1/qa/lookup?url=X",
      "GET /api/v1/sla/live", "GET /api/v1/sla/leaderboard",
      "GET /api/v1/escrow/:id",
    ],
    paid_endpoints: [
      { path: "POST /api/v1/skill/scan", price: "$0.01 USDC", service: "clawscan" },
      { path: "POST /api/v1/skill/verify", price: "$2.00 USDC", service: "clawscan" },
      { path: "POST /api/v1/qa/test", price: "$0.05 USDC", service: "qabot" },
      { path: "POST /api/v1/qa/full", price: "$0.50 USDC", service: "qabot" },
      { path: "POST /api/v1/qa/adversarial", price: "$1.00 USDC", service: "qabot" },
      { path: "GET /api/v1/sla/report?url=X", price: "$0.01 USDC", service: "sentinel" },
      { path: "POST /api/v1/escrow/create", price: "$0.10 USDC", service: "clawvault (centralized beta)" },
      { path: "POST /api/v1/escrow/dispute", price: "$0.50 USDC", service: "clawvault (centralized beta)" },
    ],
  });
});

router.get("/api/v1/health", (req, res) => res.json({ status: "ok", timestamp: new Date().toISOString() }));

router.get("/api/v1/stats", (req, res) => {
  const global = getGlobalStats();
  const escrow = getEscrowStats();
  res.json({ ...global, escrow, timestamp: new Date().toISOString() });
});

// ============================================
// 🛡️ CLAWSCAN — Skill Auditor
// ============================================

router.get("/api/v1/skill/lookup", async (req, res) => {
  const { name } = req.query;
  if (!name) return res.status(400).json({ error: "Missing 'name' query param" });
  const result = lookupSkill(name);
  if (!result) return res.json({ skill: name, found: false, message: "No scan on record. Use POST /api/v1/skill/scan." });
  await sendAttested(res, { ...result, found: true }, "/api/v1/skill/lookup", "f_c", 86400);
});

router.post("/api/v1/skill/scan", async (req, res) => {
  try {
    const { content, skill_name, url } = req.body;
    let skillContent = content, name = skill_name;
    if (url && !content) {
      const resp = await fetch(url);
      if (!resp.ok) return res.status(400).json({ error: `Fetch failed: ${resp.status}` });
      skillContent = await resp.text();
      if (!name) name = url.split("/").pop()?.replace(".md", "") || "unknown";
    }
    if (!skillContent) return res.status(400).json({ error: "Provide 'content' or 'url'" });
    if (!name) name = "unknown-skill";
    const result = scanSkill(skillContent, name);
    saveSkillScan(name, result, "quick");
    await sendAttested(res, result, "/api/v1/skill/scan", "f_c", 3600);
  } catch (err) { res.status(500).json({ error: "Scan failed" }); }
});

router.post("/api/v1/skill/verify", async (req, res) => {
  try {
    const { content, skill_name, url } = req.body;
    let skillContent = content, name = skill_name;
    if (url && !content) {
      const resp = await fetch(url);
      if (!resp.ok) return res.status(400).json({ error: `Fetch failed: ${resp.status}` });
      skillContent = await resp.text();
      if (!name) name = url.split("/").pop()?.replace(".md", "") || "unknown";
    }
    if (!skillContent || !name) return res.status(400).json({ error: "Provide content + skill_name or url" });
    const result = scanSkill(skillContent, name, { isVerification: true });
    const verified = result.trust_score >= 70;
    saveSkillScan(name, result, "deep", verified);
    await sendAttested(
      res,
      {
        ...result,
        verified,
        badge: verified ? "✅ VERIFIED BY TRUSTLAYER" : null,
        message: verified ? "Skill passed deep verification." : "Did not pass. Fix findings and resubmit.",
      },
      "/api/v1/skill/verify",
      "f_c",
      86400 // verified skill state cached 24h
    );
  } catch (err) { res.status(500).json({ error: "Verification failed" }); }
});

// ============================================
// 🧪 QABOT — Agent Testing
// ============================================

router.get("/api/v1/qa/lookup", async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: "Missing 'url' query param" });
  const report = lookupQAReport(url);
  if (!report) return res.json({ target: url, found: false, message: "No test on record. Use POST /api/v1/qa/test." });
  await sendAttested(res, { ...report, found: true }, "/api/v1/qa/lookup", "f_m", 3600);
});

router.post("/api/v1/qa/test", async (req, res) => {
  try {
    const { target_url } = req.body;
    if (!target_url) return res.status(400).json({ error: "Provide 'target_url'" });
    const result = await runTests(target_url, "quick");
    saveQAReport(target_url, "quick", result);
    await sendAttested(res, result, "/api/v1/qa/test", "f_m", 3600);
  } catch (err) { res.status(500).json({ error: "Test failed: " + err.message }); }
});

router.post("/api/v1/qa/full", async (req, res) => {
  try {
    const { target_url, payment_header } = req.body;
    if (!target_url) return res.status(400).json({ error: "Provide 'target_url'" });
    const result = await runTests(target_url, "safety", { paymentHeader: payment_header });
    saveQAReport(target_url, "safety", result);
    await sendAttested(res, result, "/api/v1/qa/full", "f_m", 3600);
  } catch (err) { res.status(500).json({ error: "Test failed: " + err.message }); }
});

router.post("/api/v1/qa/adversarial", async (req, res) => {
  try {
    const { target_url, payment_header } = req.body;
    if (!target_url) return res.status(400).json({ error: "Provide 'target_url'" });
    const result = await runTests(target_url, "adversarial", { paymentHeader: payment_header });
    saveQAReport(target_url, "adversarial", result);
    await sendAttested(res, result, "/api/v1/qa/adversarial", "f_m", 3600);
  } catch (err) { res.status(500).json({ error: "Test failed: " + err.message }); }
});

// ============================================
// 📡 SENTINEL — SLA Monitor
// ============================================

router.get("/api/v1/sla/live", (req, res) => res.json(getLiveStatus()));

router.get("/api/v1/sla/leaderboard", (req, res) => res.json(getLeaderboard()));

router.get("/api/v1/sla/report", async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: "Missing 'url' query param" });
  const sla = getServiceSLA(url);
  if (!sla) return res.json({ url, found: false, message: "Service not monitored yet. Register via POST /api/v1/sla/register." });
  await sendAttested(res, sla, "/api/v1/sla/report", "f_c", 60);
});

router.post("/api/v1/sla/register", (req, res) => {
  const { url, name, description } = req.body;
  if (!url) return res.status(400).json({ error: "Provide 'url'" });
  const service = registerService(url, name, description);
  res.json({ registered: true, service, message: "Service will be monitored. First results in ~60 seconds." });
});

// ============================================
// 🔄 ESCROW — Payment Protection
// ============================================

router.get("/api/v1/escrow/:id", (req, res) => {
  const esc = getEscrow(req.params.id);
  if (!esc) return res.status(404).json({ error: "Escrow not found" });
  res.json(esc);
});

router.get("/api/v1/escrow/by/:address", (req, res) => {
  res.json(getEscrowsByAddress(req.params.address));
});

router.post("/api/v1/escrow/create", async (req, res) => {
  try {
    const { buyer_address, seller_address, amount_usdc, service_description, acceptance_criteria, deadline_hours } = req.body;
    if (!buyer_address || !seller_address || !amount_usdc || !service_description) {
      return res.status(400).json({ error: "Required: buyer_address, seller_address, amount_usdc, service_description" });
    }
    incrementEscrows();
    const result = createEscrow({
      buyerAddress: buyer_address, sellerAddress: seller_address,
      amountUsdc: amount_usdc, serviceDescription: service_description,
      acceptanceCriteria: acceptance_criteria, deadlineHours: deadline_hours || 24,
    });
    const horizonSeconds = (deadline_hours || 24) * 3600;
    await sendAttested(
      res,
      {
        ...result,
        trust_model: "⚠️ ClawVault v1 is a centralized beta. TrustLayer operates as custodian during escrow period. Use for small amounts only. V2 will use on-chain smart contract.",
      },
      "/api/v1/escrow/create",
      "f_s",
      horizonSeconds
    );
  } catch (err) { res.status(400).json({ error: err.message }); }
});

router.post("/api/v1/escrow/fund", (req, res) => {
  try {
    const { escrow_id, deposit_tx } = req.body;
    res.json(fundEscrow(escrow_id, deposit_tx));
  } catch (err) { res.status(400).json({ error: err.message }); }
});

router.post("/api/v1/escrow/deliver", (req, res) => {
  try {
    const { escrow_id, proof } = req.body;
    res.json(deliverEscrow(escrow_id, proof));
  } catch (err) { res.status(400).json({ error: err.message }); }
});

router.post("/api/v1/escrow/accept", (req, res) => {
  try {
    const { escrow_id } = req.body;
    res.json(acceptEscrow(escrow_id));
  } catch (err) { res.status(400).json({ error: err.message }); }
});

router.post("/api/v1/escrow/dispute", async (req, res) => {
  try {
    const { escrow_id, address, reason, evidence } = req.body;
    if (!escrow_id || !address || !reason) return res.status(400).json({ error: "Required: escrow_id, address, reason" });
    const result = disputeEscrow(escrow_id, address, reason, evidence);
    await sendAttested(res, result, "/api/v1/escrow/dispute", "f_s", 86400);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// ============================================
// 🔑 PROOF-OF-CONTEXT — operator public key
// ============================================

router.get("/api/v1/poc/public-key", async (req, res) => {
  const publicKey = await getPublicKey();
  res.json({
    public_key: publicKey,
    source_id: process.env.POC_SOURCE_ID || "trustlayer:default",
    primitive: "Proof-of-Context (Aletheia)",
    spec: "https://github.com/asastuai/proof-of-context",
    impl: "https://github.com/asastuai/proof-of-context-impl",
    freshness_types_emitted: ["f_c", "f_m", "f_s"],
    notes_per_service: {
      clawscan: "f_c — when scanned. Cached for 24h on verified, 1h on quick scan.",
      qabot: "f_m — model version + when tested. Cached 1h.",
      sentinel: "f_c — uptime sample timing. Horizon 60s.",
      escrow: "f_s — settlement window. Horizon = deadline_hours.",
    },
    note: publicKey === null
      ? "POC_SIGNING_KEY env var not set. Attestations will be unsigned (still informational)."
      : "Attestations are Ed25519-signed. Verify against this public key.",
  });
});

export default router;
