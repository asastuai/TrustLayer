import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "fs";
import { join } from "path";

// ── Setup DB ────────────────────────────────────────────────
const DATA_DIR = process.env.DATA_DIR || "./data";
if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(join(DATA_DIR, "registry.db"));

// Enable WAL for concurrent reads
db.pragma("journal_mode = WAL");

// ── Schema ──────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS skill_scans (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    skill_id    TEXT NOT NULL,
    score       INTEGER NOT NULL,
    risk_level  TEXT NOT NULL,
    issues      TEXT NOT NULL,
    passed      INTEGER NOT NULL,
    scanned_at  INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE INDEX IF NOT EXISTS idx_skill_scans_id ON skill_scans(skill_id);

  CREATE TABLE IF NOT EXISTS qa_reports (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_url   TEXT NOT NULL,
    test_type   TEXT NOT NULL,
    passed      INTEGER NOT NULL,
    score       INTEGER NOT NULL,
    results     TEXT NOT NULL,
    tested_at   INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE INDEX IF NOT EXISTS idx_qa_agent ON qa_reports(agent_url);

  CREATE TABLE IF NOT EXISTS global_stats (
    key   TEXT PRIMARY KEY,
    value INTEGER NOT NULL DEFAULT 0
  );

  INSERT OR IGNORE INTO global_stats(key, value) VALUES
    ('total_scans', 0),
    ('total_qa_tests', 0),
    ('total_escrows', 0),
    ('total_services_monitored', 0);
`);

// ── Prepared statements ──────────────────────────────────────
const insertScan = db.prepare(`
  INSERT INTO skill_scans (skill_id, score, risk_level, issues, passed)
  VALUES (@skill_id, @score, @risk_level, @issues, @passed)
`);

const lookupScanStmt = db.prepare(`
  SELECT * FROM skill_scans WHERE skill_id = ?
  ORDER BY scanned_at DESC LIMIT 1
`);

const insertQA = db.prepare(`
  INSERT INTO qa_reports (agent_url, test_type, passed, score, results)
  VALUES (@agent_url, @test_type, @passed, @score, @results)
`);

const lookupQAStmt = db.prepare(`
  SELECT * FROM qa_reports WHERE agent_url = ?
  ORDER BY tested_at DESC LIMIT 1
`);

const getStatsStmt = db.prepare(`
  SELECT key, value FROM global_stats
`);

const incrStat = db.prepare(`
  UPDATE global_stats SET value = value + 1 WHERE key = ?
`);

// ── Exported functions ───────────────────────────────────────

export function saveSkillScan(skillId, result) {
  insertScan.run({
    skill_id:   skillId,
    score:      result.score ?? 0,
    risk_level: result.riskLevel ?? "unknown",
    issues:     JSON.stringify(result.issues ?? []),
    passed:     result.passed ? 1 : 0,
  });
  incrStat.run("total_scans");
}

export function lookupSkill(skillId) {
  const row = lookupScanStmt.get(skillId);
  if (!row) return null;
  return {
    skillId:   row.skill_id,
    score:     row.score,
    riskLevel: row.risk_level,
    issues:    JSON.parse(row.issues),
    passed:    row.passed === 1,
    scannedAt: row.scanned_at,
  };
}

export function saveQAReport(agentUrl, testType, result) {
  insertQA.run({
    agent_url: agentUrl,
    test_type: testType,
    passed:    result.passed ? 1 : 0,
    score:     result.score ?? 0,
    results:   JSON.stringify(result.tests ?? result),
  });
  incrStat.run("total_qa_tests");
}

export function lookupQAReport(agentUrl) {
  const row = lookupQAStmt.get(agentUrl);
  if (!row) return null;
  return {
    agentUrl:  row.agent_url,
    testType:  row.test_type,
    passed:    row.passed === 1,
    score:     row.score,
    results:   JSON.parse(row.results),
    testedAt:  row.tested_at,
  };
}

export function getGlobalStats() {
  const rows = getStatsStmt.all();
  return Object.fromEntries(rows.map(r => [r.key, r.value]));
}

export function incrementEscrows() {
  incrStat.run("total_escrows");
}
