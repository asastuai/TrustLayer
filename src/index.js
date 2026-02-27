import express from "express";
import cors from "cors";
import helmet from "helmet";
import { CronJob } from "cron";
import { paymentMiddleware } from "@x402/express";
import { x402ResourceServer, HTTPFacilitatorClient } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { config } from "./config.js";
import apiRoutes from "./routes/api.js";
import { pingAllServices } from "./services/sentinel/sentinel.js";
import { processExpiredEscrows } from "./services/escrow/escrow.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();

app.use(helmet());
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// Logging
app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    console.log(`${req.method} ${req.path} → ${res.statusCode} (${Date.now() - start}ms)`);
  });
  next();
});

// ============================================
// STATIC + FREE ENDPOINTS — before payment middleware
// ============================================
app.use(express.static(join(__dirname, "public")));
app.get("/", (req, res) => res.sendFile(join(__dirname, "public", "index.html")));
app.get("/api/v1/health", (req, res) =>
  res.json({ status: "ok", timestamp: new Date().toISOString() })
);

// ============================================
// x402 PAYMENT MIDDLEWARE — ALL 4 SERVICES
// ============================================
try {
  const FACILITATOR_URL = "https://facilitator.x402.org";
  const facilitatorClient = new HTTPFacilitatorClient({ url: FACILITATOR_URL });
  const resourceServer = new x402ResourceServer(facilitatorClient)
    .register(config.network, new ExactEvmScheme());

  const paymentConfig = (price, desc) => ({
    accepts: [{ scheme: "exact", price, network: config.network, payTo: config.payToAddress, asset: config.usdcAddress }],
    description: desc,
  });

  const routes = {
    "POST /api/v1/skill/scan":     paymentConfig(config.pricing.skillScan,    "Quick security scan of an AI agent skill"),
    "POST /api/v1/skill/verify":   paymentConfig(config.pricing.skillVerify,  "Deep verification + Verified badge"),
    "POST /api/v1/qa/test":        paymentConfig(config.pricing.qaQuick,      "Quick QA test suite for an agent"),
    "POST /api/v1/qa/full":        paymentConfig(config.pricing.qaFull,       "Full safety + accuracy test suite"),
    "POST /api/v1/qa/adversarial": paymentConfig(config.pricing.qaAdversarial,"Adversarial red-team testing"),
    "GET /api/v1/sla/report":      paymentConfig(config.pricing.slaReport,    "Detailed SLA report with uptime history"),
    "POST /api/v1/escrow/create":  paymentConfig(config.pricing.escrowCreate, "Create a ClawVault escrow (centralized beta)"),
    "POST /api/v1/escrow/dispute": paymentConfig(config.pricing.escrowDispute,"File a dispute on a ClawVault escrow"),
  };

  // syncFacilitatorOnStart = false → server never blocks on facilitator at startup
  app.use(paymentMiddleware(routes, resourceServer, undefined, undefined, false));
  console.log("✅ x402 payment middleware registered");
} catch (err) {
  console.error("⚠️  x402 middleware failed to load — paid endpoints disabled:", err.message);
  // Server continues running; free endpoints still work
}

// Routes
app.use(apiRoutes);

// 404
app.use((req, res) => res.status(404).json({ error: "Not found", hint: "GET /api/v1/info" }));

// ============================================
// BACKGROUND JOBS
// ============================================

// Sentinel: Ping all services every 60s
const sentinelJob = new CronJob("* * * * *", async () => {
  try {
    const results = await pingAllServices();
    const down = results.filter((r) => !r.isUp);
    if (down.length) console.log(`⚠️  Sentinel: ${down.length} service(s) down`);
  } catch (err) {
    console.error("Sentinel ping error:", err.message);
  }
});

// Escrow: Process expired escrows every 5 min
const escrowJob = new CronJob("*/5 * * * *", () => {
  try {
    const result = processExpiredEscrows();
    if (result.autoReleased || result.autoRefunded) {
      console.log(`🔄 Escrow: ${result.autoReleased} auto-released, ${result.autoRefunded} auto-refunded`);
    }
  } catch (err) {
    console.error("Escrow cron error:", err.message);
  }
});

// ============================================
// START
// ============================================

// Global error handler for x402/facilitator issues
app.use((err, req, res, next) => {
  if (err.message?.includes("facilitator") || err.message?.includes("x402") || err.message?.includes("payment")) {
    console.error("x402 payment error:", err.message);
    return res.status(503).json({
      error: "Payment service temporarily unavailable",
      retry_after: 30,
      hint: "The x402 facilitator may be initializing. Try again in 30 seconds.",
    });
  }
  console.error("Unhandled error:", err);
  res.status(500).json({ error: "Internal server error" });
});

app.listen(config.port, () => {
  sentinelJob.start();
  escrowJob.start();

  // Warm up x402 facilitator connection (non-blocking)
  setTimeout(async () => {
    try {
      await fetch(config.facilitatorUrl, { method: "HEAD", signal: AbortSignal.timeout(5000) });
      console.log("✅ x402 facilitator reachable");
    } catch (err) {
      console.warn("⚠️  x402 facilitator not reachable at startup:", err.message);
      console.warn("   Paid endpoints will retry on first request");
    }
  }, 2000);

  console.log(`
╔══════════════════════════════════════════════════════════════╗
║            🏗️  TRUSTLAYER v1.0.0                            ║
║     The Trust Layer for the Agent Economy                    ║
╠══════════════════════════════════════════════════════════════╣
║  Server:    http://localhost:${config.port}                           ║
║  Network:   Base Mainnet (8453)                              ║
║  Payment:   x402 (USDC)                                     ║
║  Wallet:    ${(config.payToAddress || "NOT SET").slice(0, 20)}...                      ║
╠══════════════════════════════════════════════════════════════╣
║                                                              ║
║  🛡️  CLAWSCAN — Skill Auditor                               ║
║      POST /api/v1/skill/scan       $0.01 USDC               ║
║      POST /api/v1/skill/verify     $2.00 USDC               ║
║      GET  /api/v1/skill/lookup     FREE                     ║
║                                                              ║
║  🧪 QABOT — Agent Testing                                   ║
║      POST /api/v1/qa/test          $0.05 USDC               ║
║      POST /api/v1/qa/full          $0.50 USDC               ║
║      POST /api/v1/qa/adversarial   $1.00 USDC               ║
║      GET  /api/v1/qa/lookup        FREE                     ║
║                                                              ║
║  📡 SENTINEL — SLA Monitor                                   ║
║      GET  /api/v1/sla/report       $0.01 USDC               ║
║      GET  /api/v1/sla/live         FREE                     ║
║      GET  /api/v1/sla/leaderboard  FREE                     ║
║      POST /api/v1/sla/register     FREE                     ║
║                                                              ║
║  🔐 CLAWVAULT — Payment Protection (Centralized Beta)     ║
║      POST /api/v1/escrow/create    $0.10 USDC               ║
║      POST /api/v1/escrow/dispute   $0.50 USDC               ║
║      GET  /api/v1/escrow/:id       FREE                     ║
║                                                              ║
║  ⏰ Sentinel pinging every 60s                                ║
║  ⏰ Escrow auto-processing every 5min                         ║
╚══════════════════════════════════════════════════════════════╝
  `);
});
