/**
 * Escrow — Agent Payment Protection
 * Part of the TrustLayer suite.
 *
 * Manages escrow agreements between agents:
 * 1. Agent A creates escrow with conditions (what they need, deadline, amount)
 * 2. Agent A deposits USDC
 * 3. Agent B performs the service
 * 4. Verifier (auto or manual) confirms delivery
 * 5. USDC released to Agent B (or refunded to Agent A)
 *
 * MVP: Off-chain escrow coordination with on-chain USDC transfers.
 * V2: Full smart contract escrow (Solidity contract provided separately).
 */

import Database from "better-sqlite3";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { mkdirSync } from "fs";
import crypto from "crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, "../../../data/escrow.db");
mkdirSync(join(__dirname, "../../../data"), { recursive: true });

const db = new Database(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS escrows (
    id TEXT PRIMARY KEY,
    buyer_address TEXT NOT NULL,
    seller_address TEXT NOT NULL,
    amount_usdc TEXT NOT NULL,
    service_description TEXT NOT NULL,
    acceptance_criteria TEXT,
    deadline TEXT NOT NULL,
    status TEXT DEFAULT 'created',
    deposit_tx TEXT,
    release_tx TEXT,
    refund_tx TEXT,
    dispute_reason TEXT,
    dispute_evidence TEXT,
    resolution TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_escrow_buyer ON escrows(buyer_address);
  CREATE INDEX IF NOT EXISTS idx_escrow_seller ON escrows(seller_address);
  CREATE INDEX IF NOT EXISTS idx_escrow_status ON escrows(status);

  CREATE TABLE IF NOT EXISTS escrow_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    escrow_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    actor TEXT,
    data TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (escrow_id) REFERENCES escrows(id)
  );
`);

// ====== ESCROW LIFECYCLE ======

/**
 * Create a new escrow agreement.
 * Status flow: created → funded → delivered → completed | disputed → resolved
 */
export function createEscrow({
  buyerAddress,
  sellerAddress,
  amountUsdc,
  serviceDescription,
  acceptanceCriteria = null,
  deadlineHours = 24,
}) {
  const id = `esc_${crypto.randomBytes(12).toString("hex")}`;
  const deadline = new Date(Date.now() + deadlineHours * 3600 * 1000).toISOString();

  db.prepare(`
    INSERT INTO escrows (id, buyer_address, seller_address, amount_usdc, service_description, acceptance_criteria, deadline)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, buyerAddress, sellerAddress, amountUsdc, serviceDescription, acceptanceCriteria, deadline);

  logEvent(id, "created", buyerAddress, { amountUsdc, deadline });

  return {
    id,
    status: "created",
    buyer: buyerAddress,
    seller: sellerAddress,
    amount_usdc: amountUsdc,
    deadline,
    next_step: "Buyer must deposit USDC. Call POST /api/v1/escrow/fund with deposit transaction hash.",
  };
}

/**
 * Record that buyer has funded the escrow (deposit tx verified off-chain or on-chain).
 */
export function fundEscrow(escrowId, depositTxHash) {
  const esc = getEscrow(escrowId);
  if (!esc) throw new Error("Escrow not found");
  if (esc.status !== "created") throw new Error(`Cannot fund: status is ${esc.status}`);

  db.prepare(`UPDATE escrows SET status = 'funded', deposit_tx = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(depositTxHash, escrowId);
  logEvent(escrowId, "funded", esc.buyer_address, { depositTxHash });

  return {
    id: escrowId,
    status: "funded",
    message: "Escrow funded. Seller can now perform the service.",
    next_step: "Seller performs service, then calls POST /api/v1/escrow/deliver.",
  };
}

/**
 * Seller marks service as delivered with proof.
 */
export function deliverEscrow(escrowId, deliveryProof) {
  const esc = getEscrow(escrowId);
  if (!esc) throw new Error("Escrow not found");
  if (esc.status !== "funded") throw new Error(`Cannot deliver: status is ${esc.status}`);

  db.prepare(`UPDATE escrows SET status = 'delivered', updated_at = datetime('now') WHERE id = ?`)
    .run(escrowId);
  logEvent(escrowId, "delivered", esc.seller_address, { proof: deliveryProof });

  return {
    id: escrowId,
    status: "delivered",
    message: "Delivery recorded. Buyer has 24h to accept or dispute.",
    next_step: "Buyer calls POST /api/v1/escrow/accept to release payment, or POST /api/v1/escrow/dispute.",
  };
}

/**
 * Buyer accepts delivery — release payment to seller.
 */
export function acceptEscrow(escrowId) {
  const esc = getEscrow(escrowId);
  if (!esc) throw new Error("Escrow not found");
  if (esc.status !== "delivered") throw new Error(`Cannot accept: status is ${esc.status}`);

  db.prepare(`UPDATE escrows SET status = 'completed', updated_at = datetime('now') WHERE id = ?`)
    .run(escrowId);
  logEvent(escrowId, "completed", esc.buyer_address, { released_to: esc.seller_address });

  return {
    id: escrowId,
    status: "completed",
    message: `Payment of ${esc.amount_usdc} USDC released to seller.`,
    seller: esc.seller_address,
    release_note: "In MVP, TrustLayer operator sends USDC manually. V2 uses smart contract auto-release.",
  };
}

/**
 * Buyer or seller initiates a dispute.
 */
export function disputeEscrow(escrowId, disputerAddress, reason, evidence = null) {
  const esc = getEscrow(escrowId);
  if (!esc) throw new Error("Escrow not found");
  if (!["funded", "delivered"].includes(esc.status)) throw new Error(`Cannot dispute: status is ${esc.status}`);

  db.prepare(`
    UPDATE escrows SET status = 'disputed', dispute_reason = ?, dispute_evidence = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(reason, evidence, escrowId);
  logEvent(escrowId, "disputed", disputerAddress, { reason, evidence });

  return {
    id: escrowId,
    status: "disputed",
    message: "Dispute filed. TrustLayer will review and resolve within 48h.",
    reason,
    next_step: "Await resolution. Both parties can submit additional evidence via POST /api/v1/escrow/evidence.",
  };
}

/**
 * Resolve a dispute — either refund buyer or release to seller.
 */
export function resolveDispute(escrowId, resolution, winner) {
  const esc = getEscrow(escrowId);
  if (!esc) throw new Error("Escrow not found");
  if (esc.status !== "disputed") throw new Error(`Cannot resolve: status is ${esc.status}`);

  const newStatus = winner === "buyer" ? "refunded" : "completed";

  db.prepare(`UPDATE escrows SET status = ?, resolution = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(newStatus, resolution, escrowId);
  logEvent(escrowId, "resolved", "trustlayer", { resolution, winner });

  return {
    id: escrowId,
    status: newStatus,
    resolution,
    winner,
    message: winner === "buyer"
      ? `Refund of ${esc.amount_usdc} USDC to buyer.`
      : `Payment of ${esc.amount_usdc} USDC released to seller.`,
  };
}

/**
 * Auto-complete escrows past deadline with no dispute.
 * Called by cron job — if delivered + 24h + no dispute → auto-release.
 * If funded + past deadline + no delivery → auto-refund.
 */
export function processExpiredEscrows() {
  // Auto-release: delivered > 24h ago, no dispute
  const autoRelease = db.prepare(`
    SELECT * FROM escrows
    WHERE status = 'delivered' AND updated_at < datetime('now', '-1 day')
  `).all();

  for (const esc of autoRelease) {
    acceptEscrow(esc.id);
    logEvent(esc.id, "auto_completed", "system", { reason: "24h acceptance window expired" });
  }

  // Auto-refund: funded but past deadline, no delivery
  const autoRefund = db.prepare(`
    SELECT * FROM escrows
    WHERE status = 'funded' AND deadline < datetime('now')
  `).all();

  for (const esc of autoRefund) {
    db.prepare(`UPDATE escrows SET status = 'refunded', updated_at = datetime('now') WHERE id = ?`)
      .run(esc.id);
    logEvent(esc.id, "auto_refunded", "system", { reason: "Deadline passed without delivery" });
  }

  return { autoReleased: autoRelease.length, autoRefunded: autoRefund.length };
}

// ====== QUERIES ======

export function getEscrow(escrowId) {
  return db.prepare(`SELECT * FROM escrows WHERE id = ?`).get(escrowId);
}

export function getEscrowEvents(escrowId) {
  return db.prepare(`SELECT * FROM escrow_events WHERE escrow_id = ? ORDER BY created_at ASC`).all(escrowId);
}

export function getEscrowsByAddress(address) {
  return db.prepare(`
    SELECT * FROM escrows WHERE buyer_address = ? OR seller_address = ? ORDER BY created_at DESC LIMIT 50
  `).all(address, address);
}

export function getEscrowStats() {
  return db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
      SUM(CASE WHEN status = 'disputed' THEN 1 ELSE 0 END) as disputed,
      SUM(CASE WHEN status = 'refunded' THEN 1 ELSE 0 END) as refunded,
      SUM(CASE WHEN status IN ('created','funded','delivered') THEN 1 ELSE 0 END) as active
    FROM escrows
  `).get();
}

function logEvent(escrowId, eventType, actor, data) {
  db.prepare(`INSERT INTO escrow_events (escrow_id, event_type, actor, data) VALUES (?, ?, ?, ?)`)
    .run(escrowId, eventType, actor, JSON.stringify(data));
}
