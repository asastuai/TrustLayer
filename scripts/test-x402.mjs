#!/usr/bin/env node
/**
 * Test x402 flow on TrustLayer
 * 
 * Usage:
 *   node test-x402.mjs
 *   TRUSTLAYER_URL=https://your-app.railway.app node test-x402.mjs
 */

const BASE_URL = process.env.TRUSTLAYER_URL || "http://localhost:3000";
const FACILITATOR_URL = process.env.FACILITATOR_URL || "https://api.cdp.coinbase.com/platform/v2/x402";

let passed = 0, failed = 0;

async function test(name, fn) {
  try {
    const result = await fn();
    console.log(`  ✅ ${name}: ${result}`);
    passed++;
  } catch (err) {
    console.log(`  ❌ ${name}: ${err.message}`);
    failed++;
  }
}

async function main() {
  console.log(`\n🧪 TrustLayer x402 Test Suite`);
  console.log(`   Server:      ${BASE_URL}`);
  console.log(`   Facilitator: ${FACILITATOR_URL}\n`);

  // === FREE ENDPOINTS ===
  console.log("── Free Endpoints ──");

  await test("GET /api/v1/info → 200", async () => {
    const res = await fetch(`${BASE_URL}/api/v1/info`);
    if (res.status !== 200) throw new Error(`Got ${res.status}`);
    const data = await res.json();
    return `${Object.keys(data.services).length} services`;
  });

  await test("GET /api/v1/health → 200", async () => {
    const res = await fetch(`${BASE_URL}/api/v1/health`);
    if (res.status !== 200) throw new Error(`Got ${res.status}`);
    return "OK";
  });

  await test("GET /api/v1/sla/live → 200", async () => {
    const res = await fetch(`${BASE_URL}/api/v1/sla/live`);
    if (res.status !== 200) throw new Error(`Got ${res.status}`);
    return "OK";
  });

  // === PAID ENDPOINTS (should return 402, NOT 502) ===
  console.log("\n── Paid Endpoints (expect 402) ──");

  const paidEndpoints = [
    ["POST", "/api/v1/skill/scan", { content: "test", skill_name: "test" }],
    ["POST", "/api/v1/skill/verify", { content: "test", skill_name: "test" }],
    ["POST", "/api/v1/qa/test", { target_url: "https://test.example.com" }],
    ["POST", "/api/v1/qa/full", { target_url: "https://test.example.com" }],
    ["POST", "/api/v1/qa/adversarial", { target_url: "https://test.example.com" }],
    ["GET", "/api/v1/sla/report?url=https://test.example.com", null],
    ["POST", "/api/v1/escrow/create", { seller_address: "0x0", amount_usdc: "1", service_description: "test" }],
    ["POST", "/api/v1/escrow/dispute", { escrow_id: "0", reason: "test" }],
  ];

  for (const [method, path, body] of paidEndpoints) {
    await test(`${method} ${path.split("?")[0]} → 402`, async () => {
      const opts = { method, headers: { "Content-Type": "application/json" } };
      if (body) opts.body = JSON.stringify(body);
      const res = await fetch(`${BASE_URL}${path}`, opts);
      if (res.status === 502) throw new Error("🔴 502 Bad Gateway — Railway proxy issue NOT fixed");
      if (res.status === 503) throw new Error("503 — payment service unavailable");
      if (res.status !== 402) throw new Error(`Got ${res.status}`);
      return "402 ✓";
    });
  }

  // === x402 v2 FORMAT ===
  console.log("\n── x402 v2 Compliance ──");

  await test("402 has PAYMENT-REQUIRED header (base64)", async () => {
    const res = await fetch(`${BASE_URL}/api/v1/skill/scan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "test", skill_name: "test" }),
    });
    const prHeader = res.headers.get("payment-required");
    if (!prHeader) throw new Error("Missing PAYMENT-REQUIRED header");
    const decoded = JSON.parse(Buffer.from(prHeader, "base64").toString("utf-8"));
    if (!decoded.x402Version) throw new Error("Missing x402Version");
    return `x402v${decoded.x402Version}`;
  });

  await test("402 body has accepts array", async () => {
    const res = await fetch(`${BASE_URL}/api/v1/skill/scan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "test", skill_name: "test" }),
    });
    const body = await res.json();
    if (!body.accepts || !Array.isArray(body.accepts)) throw new Error("Missing/invalid accepts");
    const a = body.accepts[0];
    if (a.scheme !== "exact") throw new Error(`Wrong scheme: ${a.scheme}`);
    if (!a.payTo) throw new Error("Missing payTo");
    if (!a.network) throw new Error("Missing network");
    if (!a.amount) throw new Error("Missing amount");
    return `scheme:${a.scheme} network:${a.network} amount:${a.amount} payTo:${a.payTo.slice(0,10)}...`;
  });

  // === FACILITATOR ===
  console.log("\n── Facilitator ──");

  await test("Facilitator reachable", async () => {
    const res = await fetch(FACILITATOR_URL, {
      method: "GET",
      signal: AbortSignal.timeout(5000),
    });
    if (res.status >= 500) throw new Error(`Facilitator error: ${res.status}`);
    return `HTTP ${res.status}`;
  });

  // === RESULTS ===
  console.log(`\n${"═".repeat(40)}`);
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  if (failed === 0) {
    console.log("  🎉 All tests passed! x402 integration is working.");
    console.log("  Next: test with x402-fetch for full payment flow.");
  } else {
    console.log("  ⚠️  Some tests failed. Check the errors above.");
  }
  console.log(`${"═".repeat(40)}\n`);
}

main().catch(console.error);
