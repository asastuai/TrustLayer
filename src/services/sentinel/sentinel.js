/**
 * Sentinel — SLA Monitoring for x402 Services
 * Part of the TrustLayer suite.
 *
 * Pings registered x402 services every 60s and tracks:
 * - Uptime percentage (30d rolling)
 * - Latency (p50, p95, p99)
 * - Error rate
 * - x402 compliance (proper 402 response format)
 * - Downtime incidents
 */

import Database from "better-sqlite3";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { mkdirSync } from "fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, "../../../data/sentinel.db");
mkdirSync(join(__dirname, "../../../data"), { recursive: true });

const db = new Database(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS services (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    url TEXT UNIQUE NOT NULL,
    name TEXT,
    description TEXT,
    first_seen TEXT DEFAULT (datetime('now')),
    last_checked TEXT,
    is_active INTEGER DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS pings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    service_id INTEGER NOT NULL,
    status_code INTEGER,
    latency_ms INTEGER,
    is_up INTEGER NOT NULL,
    x402_compliant INTEGER DEFAULT 0,
    error TEXT,
    checked_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (service_id) REFERENCES services(id)
  );

  CREATE INDEX IF NOT EXISTS idx_pings_service ON pings(service_id, checked_at);
  CREATE INDEX IF NOT EXISTS idx_pings_time ON pings(checked_at);

  CREATE TABLE IF NOT EXISTS incidents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    service_id INTEGER NOT NULL,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    duration_seconds INTEGER,
    type TEXT DEFAULT 'downtime',
    FOREIGN KEY (service_id) REFERENCES services(id)
  );

  CREATE TABLE IF NOT EXISTS alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    service_id INTEGER NOT NULL,
    alert_type TEXT NOT NULL,
    webhook_url TEXT,
    threshold REAL,
    is_active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (service_id) REFERENCES services(id)
  );
`);

// ====== SERVICE MANAGEMENT ======

const upsertService = db.prepare(`
  INSERT INTO services (url, name, description) VALUES (?, ?, ?)
  ON CONFLICT(url) DO UPDATE SET name=excluded.name, description=excluded.description
`);

const getService = db.prepare(`SELECT * FROM services WHERE url = ?`);
const getAllServices = db.prepare(`SELECT * FROM services WHERE is_active = 1`);
const getServiceById = db.prepare(`SELECT * FROM services WHERE id = ?`);

export function registerService(url, name = null, description = null) {
  upsertService.run(url, name, description);
  return getService.get(url);
}

export function listServices() {
  return getAllServices.all();
}

// ====== PING EXECUTION ======

const insertPing = db.prepare(`
  INSERT INTO pings (service_id, status_code, latency_ms, is_up, x402_compliant, error)
  VALUES (?, ?, ?, ?, ?, ?)
`);

const updateLastChecked = db.prepare(`
  UPDATE services SET last_checked = datetime('now') WHERE id = ?
`);

/**
 * Ping a single service and record the result.
 */
export async function pingService(service) {
  const start = Date.now();
  let statusCode = 0;
  let isUp = 0;
  let x402Compliant = 0;
  let error = null;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);

    const res = await fetch(service.url, {
      method: "GET",
      signal: controller.signal,
      headers: { "User-Agent": "TrustLayer-Sentinel/1.0" },
    });

    clearTimeout(timer);
    statusCode = res.status;
    isUp = statusCode >= 200 && statusCode < 500 ? 1 : 0;

    // Check x402 compliance
    if (statusCode === 402) {
      try {
        const body = await res.json();
        x402Compliant =
          body.x402Version && body.accepts && Array.isArray(body.accepts) ? 1 : 0;
      } catch {
        x402Compliant = 0;
      }
    } else if (statusCode === 200) {
      isUp = 1;
    }
  } catch (err) {
    error = err.name === "AbortError" ? "timeout" : err.message;
    isUp = 0;
  }

  const latencyMs = Date.now() - start;

  insertPing.run(service.id, statusCode, latencyMs, isUp, x402Compliant, error);
  updateLastChecked.run(service.id);

  // Check for incident transitions
  handleIncidentDetection(service.id, isUp);

  return { serviceId: service.id, url: service.url, statusCode, latencyMs, isUp, x402Compliant, error };
}

/**
 * Ping all registered services.
 */
export async function pingAllServices() {
  const services = getAllServices.all();
  const results = await Promise.allSettled(
    services.map((s) => pingService(s))
  );
  return results
    .filter((r) => r.status === "fulfilled")
    .map((r) => r.value);
}

// ====== INCIDENT DETECTION ======

const getOpenIncident = db.prepare(`
  SELECT * FROM incidents WHERE service_id = ? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1
`);

const openIncident = db.prepare(`
  INSERT INTO incidents (service_id, started_at, type) VALUES (?, datetime('now'), 'downtime')
`);

const closeIncident = db.prepare(`
  UPDATE incidents SET ended_at = datetime('now'),
    duration_seconds = CAST((julianday('now') - julianday(started_at)) * 86400 AS INTEGER)
  WHERE id = ?
`);

function handleIncidentDetection(serviceId, isUp) {
  const existing = getOpenIncident.get(serviceId);
  if (!isUp && !existing) {
    openIncident.run(serviceId);
  } else if (isUp && existing) {
    closeIncident.run(existing.id);
  }
}

// ====== SLA CALCULATIONS ======

/**
 * Get SLA metrics for a service.
 */
export function getServiceSLA(serviceUrl) {
  const service = getService.get(serviceUrl);
  if (!service) return null;

  // 24h metrics
  const h24 = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(is_up) as up_count,
      AVG(latency_ms) as avg_latency,
      MIN(latency_ms) as min_latency,
      MAX(latency_ms) as max_latency
    FROM pings
    WHERE service_id = ? AND checked_at > datetime('now', '-1 day')
  `).get(service.id);

  // 7d metrics
  const d7 = db.prepare(`
    SELECT COUNT(*) as total, SUM(is_up) as up_count, AVG(latency_ms) as avg_latency
    FROM pings WHERE service_id = ? AND checked_at > datetime('now', '-7 days')
  `).get(service.id);

  // 30d metrics
  const d30 = db.prepare(`
    SELECT COUNT(*) as total, SUM(is_up) as up_count, AVG(latency_ms) as avg_latency
    FROM pings WHERE service_id = ? AND checked_at > datetime('now', '-30 days')
  `).get(service.id);

  // Latency percentiles (last 24h)
  const latencies = db.prepare(`
    SELECT latency_ms FROM pings
    WHERE service_id = ? AND checked_at > datetime('now', '-1 day') AND is_up = 1
    ORDER BY latency_ms ASC
  `).all(service.id).map((r) => r.latency_ms);

  const p50 = percentile(latencies, 50);
  const p95 = percentile(latencies, 95);
  const p99 = percentile(latencies, 99);

  // Recent incidents
  const incidents = db.prepare(`
    SELECT * FROM incidents WHERE service_id = ? ORDER BY started_at DESC LIMIT 10
  `).all(service.id);

  // x402 compliance rate
  const compliance = db.prepare(`
    SELECT COUNT(*) as total, SUM(x402_compliant) as compliant
    FROM pings WHERE service_id = ? AND status_code = 402 AND checked_at > datetime('now', '-7 days')
  `).get(service.id);

  const uptime24h = h24.total ? ((h24.up_count / h24.total) * 100).toFixed(2) : null;
  const uptime7d = d7.total ? ((d7.up_count / d7.total) * 100).toFixed(2) : null;
  const uptime30d = d30.total ? ((d30.up_count / d30.total) * 100).toFixed(2) : null;

  const slaGrade =
    parseFloat(uptime7d) >= 99.9 ? "A+" :
    parseFloat(uptime7d) >= 99.5 ? "A" :
    parseFloat(uptime7d) >= 99.0 ? "B" :
    parseFloat(uptime7d) >= 95.0 ? "C" :
    parseFloat(uptime7d) >= 90.0 ? "D" : "F";

  return {
    service: { url: service.url, name: service.name, first_seen: service.first_seen },
    uptime: { "24h": uptime24h, "7d": uptime7d, "30d": uptime30d },
    latency: {
      avg_ms: Math.round(h24.avg_latency || 0),
      min_ms: h24.min_latency || 0,
      max_ms: h24.max_latency || 0,
      p50_ms: p50, p95_ms: p95, p99_ms: p99,
    },
    x402_compliance: compliance.total
      ? `${((compliance.compliant / compliance.total) * 100).toFixed(0)}%`
      : "N/A",
    sla_grade: slaGrade,
    incidents: incidents.map((i) => ({
      started: i.started_at, ended: i.ended_at, duration_s: i.duration_seconds, type: i.type,
    })),
    total_pings: h24.total,
    timestamp: new Date().toISOString(),
    source: "trustlayer:sentinel:v1",
  };
}

/**
 * Get the global leaderboard of services ranked by SLA.
 */
export function getLeaderboard() {
  const services = getAllServices.all();
  const board = [];

  for (const s of services) {
    const stats = db.prepare(`
      SELECT COUNT(*) as total, SUM(is_up) as up, AVG(latency_ms) as latency
      FROM pings WHERE service_id = ? AND checked_at > datetime('now', '-7 days')
    `).get(s.id);

    if (stats.total < 10) continue; // Need minimum data

    board.push({
      url: s.url,
      name: s.name,
      uptime_7d: stats.total ? ((stats.up / stats.total) * 100).toFixed(2) : "0",
      avg_latency_ms: Math.round(stats.latency || 0),
      pings: stats.total,
    });
  }

  return board
    .sort((a, b) => parseFloat(b.uptime_7d) - parseFloat(a.uptime_7d))
    .map((s, i) => ({ rank: i + 1, ...s }));
}

/**
 * Get current status of all services (live dashboard).
 */
export function getLiveStatus() {
  const services = getAllServices.all();
  return services.map((s) => {
    const lastPing = db.prepare(
      `SELECT * FROM pings WHERE service_id = ? ORDER BY checked_at DESC LIMIT 1`
    ).get(s.id);

    return {
      url: s.url,
      name: s.name,
      status: lastPing?.is_up ? "UP" : "DOWN",
      last_status_code: lastPing?.status_code || null,
      last_latency_ms: lastPing?.latency_ms || null,
      last_checked: s.last_checked,
      x402_compliant: lastPing?.x402_compliant ? true : false,
    };
  });
}

// ====== HELPERS ======

function percentile(sortedArr, p) {
  if (!sortedArr.length) return 0;
  const idx = Math.ceil((p / 100) * sortedArr.length) - 1;
  return sortedArr[Math.max(0, idx)];
}
