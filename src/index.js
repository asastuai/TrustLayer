import express from "express";
import cors from "cors";
import helmet from "helmet";
import { CronJob } from "cron";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { config } from "./config.js";
import apiRoutes from "./routes/api.js";
import { pingAllServices } from "./services/sentinel/sentinel.js";
import { processExpiredEscrows } from "./services/escrow/escrow.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();

// Helmet permisivo — x402 clients necesitan parsear JSON libremente
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
}));
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
// STATIC + FREE PAGES — before payment middleware
// ============================================
app.use(express.static(join(__dirname, "public")));
app.get("/", (req, res) => res.sendFile(join(__dirname, "public", "index.html")));
app.get("/docs", (req, res) => res.sendFile(join(__dirname, "public", "docs.html")));
app.get("/status", (req, res) => res.sendFile(join(__dirname, "public", "status.html")));

// ============================================
// x402 PAYMENT MIDDLEWARE — CUSTOM LAZY IMPLEMENTATION
// ============================================
//
// WHY NOT @x402/express paymentMiddleware?
//
// The official middleware does facilitator.sync() on startup or on first
// request, which crashes the Node process if the facilitator is unreachable
// (Railway cold starts, DNS issues, facilitator downtime).
//
// Our implementation is LAZY — it only contacts the facilitator when a
// paid request arrives WITH a payment header. Without payment, it returns
// a proper 402 with PaymentRequired (no facilitator needed for that).
//
// This means:
// - Server starts instantly (no sync delay)
// - Free endpoints always work
// - 402 responses always work
// - Only verify/settle need the facilitator (and we handle errors gracefully)
// ============================================

const PAID_ROUTES = {
  "POST /api/v1/skill/scan":       { price: config.pricing.skillScan,    desc: "Quick security scan of an AI agent skill" },
  "POST /api/v1/skill/verify":     { price: config.pricing.skillVerify,  desc: "Deep verification + Verified badge" },
  "POST /api/v1/qa/test":          { price: config.pricing.qaQuick,      desc: "Quick QA test suite for an agent" },
  "POST /api/v1/qa/full":          { price: config.pricing.qaFull,       desc: "Full safety + accuracy test suite" },
  "POST /api/v1/qa/adversarial":   { price: config.pricing.qaAdversarial,"desc": "Adversarial red-team testing" },
  "GET /api/v1/sla/report":        { price: config.pricing.slaReport,    desc: "Detailed SLA report with uptime history" },
  "POST /api/v1/escrow/create":    { price: config.pricing.escrowCreate, desc: "Create a ClawVault escrow agreement" },
  "POST /api/v1/escrow/dispute":   { price: config.pricing.escrowDispute,desc: "File a dispute on a ClawVault escrow" },
};

function priceToAmount(priceStr) {
  const num = parseFloat(priceStr.replace("$", ""));
  return Math.round(num * 1_000_000).toString();
}

function buildPaymentRequired(routeConfig, requestUrl) {
  return {
    x402Version: 2,
    resource: {
      url: requestUrl,
      description: routeConfig.desc,
      mimeType: "application/json",
    },
    accepts: [
      {
        scheme: "exact",
        network: config.network,
        amount: priceToAmount(routeConfig.price),
        asset: config.usdcAddress,
        payTo: config.payToAddress,
        maxTimeoutSeconds: 60,
        extra: { name: "USDC", version: "2" },
      },
    ],
  };
}

async function verifyPayment(paymentHeader, paymentRequired) {
  try {
    const verifyUrl = config.facilitatorUrl.replace(/\/$/, "") + "/verify";
    const res = await fetch(verifyUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        payload: paymentHeader,
        paymentRequirements: paymentRequired.accepts[0],
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "unknown");
      return { valid: false, error: `Facilitator ${res.status}: ${errText}` };
    }
    const result = await res.json();
    return { valid: result.valid !== false, result };
  } catch (err) {
    return { valid: false, error: `Facilitator unreachable: ${err.message}` };
  }
}

async function settlePayment(paymentHeader, paymentRequired) {
  try {
    const settleUrl = config.facilitatorUrl.replace(/\/$/, "") + "/settle";
    const res = await fetch(settleUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        payload: paymentHeader,
        paymentRequirements: paymentRequired.accepts[0],
      }),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "unknown");
      return { settled: false, error: `Settlement ${res.status}: ${errText}` };
    }
    const result = await res.json();
    return { settled: true, result };
  } catch (err) {
    return { settled: false, error: `Settlement error: ${err.message}` };
  }
}

// The actual middleware
app.use(async (req, res, next) => {
  const routeKey = `${req.method} ${req.path}`;
  const routeConfig = PAID_ROUTES[routeKey];

  // Not a paid route → pass through immediately
  if (!routeConfig) return next();

  // Check for payment header (x402 spec: X-PAYMENT or PAYMENT-SIGNATURE)
  const paymentHeader = req.headers["x-payment"] || req.headers["payment-signature"];

  if (!paymentHeader) {
    // No payment → return 402 Payment Required (no facilitator needed!)
    const paymentRequired = buildPaymentRequired(routeConfig, req.originalUrl);
    const b64 = Buffer.from(JSON.stringify(paymentRequired)).toString("base64");
    res.setHeader("PAYMENT-REQUIRED", b64);
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "no-store");
    return res.status(402).json(paymentRequired);
  }

  // Has payment → verify and settle with facilitator
  try {
    const paymentRequired = buildPaymentRequired(routeConfig, req.originalUrl);

    const verification = await verifyPayment(paymentHeader, paymentRequired);
    if (!verification.valid) {
      return res.status(402).json({
        error: "Payment verification failed",
        detail: verification.error,
      });
    }

    const settlement = await settlePayment(paymentHeader, paymentRequired);
    if (!settlement.settled) {
      return res.status(402).json({
        error: "Payment settlement failed",
        detail: settlement.error,
        hint: "Your payment signature may be invalid or expired. Try again.",
      });
    }

    // Attach payment info to request for route handlers
    req.x402 = { payment: verification.result, settlement: settlement.result };
    next();
  } catch (err) {
    console.error("x402 payment error:", err);
    return res.status(503).json({
      error: "Payment service temporarily unavailable",
      retry_after: 30,
    });
  }
});

// Routes
app.use(apiRoutes);

// 404
app.use((req, res) => res.status(404).json({ error: "Not found", hint: "GET /api/v1/info" }));

// Global error handler
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ error: "Internal server error" });
});

// ============================================
// BACKGROUND JOBS
// ============================================

const sentinelJob = new CronJob("* * * * *", async () => {
  try {
    const results = await pingAllServices();
    const down = results.filter((r) => !r.isUp);
    if (down.length) console.log(`⚠️  Sentinel: ${down.length} service(s) down`);
  } catch (err) { console.error("Sentinel error:", err.message); }
});

const escrowJob = new CronJob("*/5 * * * *", () => {
  try {
    const result = processExpiredEscrows();
    if (result.autoReleased || result.autoRefunded) {
      console.log(`🔄 Escrow: ${result.autoReleased} released, ${result.autoRefunded} refunded`);
    }
  } catch (err) { console.error("Escrow error:", err.message); }
});

// ============================================
// START — bind to 0.0.0.0 for Railway
// ============================================

const HOST = "0.0.0.0";

app.listen(config.port, HOST, () => {
  sentinelJob.start();
  escrowJob.start();

  // Non-blocking facilitator warmup check
  setTimeout(async () => {
    try {
      const res = await fetch(config.facilitatorUrl, {
        method: "GET",
        signal: AbortSignal.timeout(5000),
      });
      console.log(`✅ Facilitator reachable (${res.status})`);
    } catch (err) {
      console.warn(`⚠️  Facilitator not reachable: ${err.message}`);
      console.warn("   402 responses work without facilitator. Payments settle on first use.");
    }
  }, 2000);

  console.log(`
╔══════════════════════════════════════════════════════════════╗
║            🏗️  TRUSTLAYER v1.0.1                            ║
║     The Trust Layer for the Agent Economy                    ║
╠══════════════════════════════════════════════════════════════╣
║  Server:    ${HOST}:${config.port}                                    ║
║  Network:   Base Mainnet (8453)                              ║
║  Payment:   x402 custom middleware (no startup sync)         ║
║  Wallet:    ${(config.payToAddress || "NOT SET").slice(0, 20)}...                      ║
╚══════════════════════════════════════════════════════════════╝
  `);
});
