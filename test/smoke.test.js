/**
 * Smoke tests for TrustLayer endpoints.
 * Boots express in-process, hits free endpoints + new poc/public-key.
 *
 * Run with: npm test
 */

import { test } from "node:test";
import assert from "node:assert/strict";

process.env.PORT = "0";
process.env.POC_SIGNING_KEY =
  "4444444444444444444444444444444444444444444444444444444444444444";
process.env.POC_SOURCE_ID = "trustlayer:smoketest";
process.env.X402_PAYEE_ADDRESS = "0x0000000000000000000000000000000000000001";
process.env.X402_FACILITATOR_URL =
  "https://api.cdp.coinbase.com/platform/v2/x402";

const { default: express } = await import("express");
const { default: apiRoutes } = await import("../src/routes/api.js");

const app = express();
app.use(express.json());
app.use(apiRoutes);

let server;
let baseUrl;

test.before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      const port = server.address().port;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
});

test.after(() => {
  if (server) server.close();
});

test("GET /api/v1/info returns service metadata for 4 services", async () => {
  const res = await fetch(`${baseUrl}/api/v1/info`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.name, "TrustLayer");
  assert.ok(body.services.clawscan);
  assert.ok(body.services.qabot);
  assert.ok(body.services.sentinel);
  assert.ok(body.services.clawvault);
});

test("GET /api/v1/health returns ok", async () => {
  const res = await fetch(`${baseUrl}/api/v1/health`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, "ok");
});

test("GET /api/v1/poc/public-key emits multi-type capability", async () => {
  const res = await fetch(`${baseUrl}/api/v1/poc/public-key`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.public_key);
  assert.equal(body.source_id, "trustlayer:smoketest");
  assert.deepEqual(body.freshness_types_emitted.sort(), ["f_c", "f_m", "f_s"]);
  assert.ok(body.notes_per_service.clawscan);
});

test("GET /api/v1/sla/live returns service list", async () => {
  const res = await fetch(`${baseUrl}/api/v1/sla/live`);
  assert.equal(res.status, 200);
});

test("GET /api/v1/sla/leaderboard returns leaderboard", async () => {
  const res = await fetch(`${baseUrl}/api/v1/sla/leaderboard`);
  assert.equal(res.status, 200);
});
