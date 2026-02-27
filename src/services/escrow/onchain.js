/**
 * ClawVault On-Chain Client
 * Interacts with the ClawVault smart contract on Base.
 *
 * This replaces the off-chain escrow.js for production use.
 * The contract holds all funds — TrustLayer never custodies USDC.
 */

import { createPublicClient, http, parseAbi, formatUnits, encodeAbiParameters, keccak256, toHex } from "viem";
import { base } from "viem/chains";
import { config } from "../../config.js";

const CLAWVAULT_ABI = parseAbi([
  // Write functions
  "function createEscrow(address seller, uint256 amount, bytes32 serviceHash, uint256 deadlineSeconds, uint256 acceptanceWindowSeconds) returns (uint256)",
  "function markDelivered(uint256 escrowId, bytes32 deliveryHash)",
  "function acceptDelivery(uint256 escrowId)",
  "function openDispute(uint256 escrowId, string reason)",
  "function resolveDispute(uint256 escrowId, bool buyerWins)",
  "function reclaimExpired(uint256 escrowId)",
  "function claimByTimeout(uint256 escrowId)",

  // Read functions
  "function getEscrow(uint256 escrowId) view returns (tuple(address buyer, address seller, uint256 amount, uint256 fee, bytes32 serviceHash, bytes32 deliveryHash, uint256 deadline, uint256 deliveredAt, uint256 acceptanceWindow, uint8 status, string disputeReason))",
  "function getStats() view returns (uint256, uint256, uint256, uint256)",
  "function canReclaim(uint256 escrowId) view returns (bool)",
  "function canClaimByTimeout(uint256 escrowId) view returns (bool)",
  "function nextEscrowId() view returns (uint256)",
  "function feeBps() view returns (uint256)",
]);

const STATUS_MAP = ["Active", "Delivered", "Completed", "Disputed", "Refunded", "Resolved"];

const publicClient = createPublicClient({ chain: base, transport: http(config.baseRpcUrl) });

function getContract() {
  if (!config.escrowContract) throw new Error("ESCROW_CONTRACT_ADDRESS not set in .env");
  return config.escrowContract;
}

// ====== READ OPERATIONS (free, no gas) ======

/**
 * Get escrow details from the smart contract.
 */
export async function getEscrowOnChain(escrowId) {
  const result = await publicClient.readContract({
    address: getContract(),
    abi: CLAWVAULT_ABI,
    functionName: "getEscrow",
    args: [BigInt(escrowId)],
  });

  return {
    id: escrowId,
    buyer: result.buyer,
    seller: result.seller,
    amount_usdc: formatUnits(result.amount, 6),
    fee_usdc: formatUnits(result.fee, 6),
    service_hash: result.serviceHash,
    delivery_hash: result.deliveryHash,
    deadline: new Date(Number(result.deadline) * 1000).toISOString(),
    delivered_at: result.deliveredAt > 0n ? new Date(Number(result.deliveredAt) * 1000).toISOString() : null,
    acceptance_window_seconds: Number(result.acceptanceWindow),
    status: STATUS_MAP[result.status] || "Unknown",
    dispute_reason: result.disputeReason,
    contract: getContract(),
    chain: "Base (8453)",
    trust_model: "On-chain smart contract. Funds held by immutable contract, not by TrustLayer.",
    basescan: `https://basescan.org/address/${getContract()}`,
  };
}

/**
 * Get global contract stats.
 */
export async function getContractStats() {
  const [totalCreated, totalVolume, totalFees, nextId] = await publicClient.readContract({
    address: getContract(),
    abi: CLAWVAULT_ABI,
    functionName: "getStats",
  });

  const feeBps = await publicClient.readContract({
    address: getContract(),
    abi: CLAWVAULT_ABI,
    functionName: "feeBps",
  });

  return {
    total_escrows: Number(totalCreated),
    total_volume_usdc: formatUnits(totalVolume, 6),
    total_fees_usdc: formatUnits(totalFees, 6),
    next_escrow_id: Number(nextId),
    fee_percent: `${Number(feeBps) / 100}%`,
    contract: getContract(),
    trust_model: "On-chain. All data verifiable on Basescan.",
  };
}

export async function canReclaim(escrowId) {
  return publicClient.readContract({
    address: getContract(),
    abi: CLAWVAULT_ABI,
    functionName: "canReclaim",
    args: [BigInt(escrowId)],
  });
}

export async function canClaimByTimeout(escrowId) {
  return publicClient.readContract({
    address: getContract(),
    abi: CLAWVAULT_ABI,
    functionName: "canClaimByTimeout",
    args: [BigInt(escrowId)],
  });
}

// ====== WRITE HELPERS (generate tx data for agents to sign) ======

/**
 * Generate the transaction data for creating an escrow.
 * The agent signs and submits this themselves — TrustLayer never holds keys.
 *
 * Workflow:
 *   1. Agent calls this endpoint to get tx data
 *   2. Agent approves USDC to ClawVault contract
 *   3. Agent sends the createEscrow tx
 */
export function buildCreateEscrowTx({ seller, amountUsdc, serviceDescription, deadlineHours, acceptanceWindowHours }) {
  const amountRaw = BigInt(Math.round(parseFloat(amountUsdc) * 1e6));
  const serviceHash = keccak256(toHex(serviceDescription));
  const deadlineSeconds = BigInt(Math.round(deadlineHours * 3600));
  const acceptanceWindow = BigInt(Math.round((acceptanceWindowHours || 24) * 3600));

  // Fee calculation (mirrors contract logic)
  // Agent needs to know total to approve

  return {
    step_1_approve: {
      description: "First, approve USDC spending by the ClawVault contract",
      to: config.usdcAddress,
      data: `approve(${getContract()}, amount)`,
      note: "Approve amount + fee (1%). Use your wallet or agent framework to send this tx.",
    },
    step_2_create: {
      description: "Then, create the escrow",
      to: getContract(),
      function: "createEscrow",
      args: {
        seller,
        amount: amountRaw.toString(),
        serviceHash,
        deadlineSeconds: deadlineSeconds.toString(),
        acceptanceWindowSeconds: acceptanceWindow.toString(),
      },
      abi_snippet: "createEscrow(address,uint256,bytes32,uint256,uint256)",
    },
    human_readable: {
      seller,
      amount_usdc: amountUsdc,
      service_hash: serviceHash,
      deadline_hours: deadlineHours,
      acceptance_window_hours: acceptanceWindowHours || 24,
      contract: getContract(),
      chain: "Base (8453)",
      basescan: `https://basescan.org/address/${getContract()}`,
    },
    trust_model: "You sign the transaction yourself. TrustLayer never touches your funds. The smart contract holds USDC until delivery is confirmed or deadline expires.",
  };
}

export function buildMarkDeliveredTx(escrowId, deliveryProof) {
  const deliveryHash = keccak256(toHex(deliveryProof));
  return {
    to: getContract(),
    function: "markDelivered",
    args: { escrowId: escrowId.toString(), deliveryHash },
    note: "Seller signs this to mark delivery. Buyer then has the acceptance window to accept or dispute.",
  };
}

export function buildAcceptDeliveryTx(escrowId) {
  return {
    to: getContract(),
    function: "acceptDelivery",
    args: { escrowId: escrowId.toString() },
    note: "Buyer signs this to release USDC to seller.",
  };
}

export function buildDisputeTx(escrowId, reason) {
  return {
    to: getContract(),
    function: "openDispute",
    args: { escrowId: escrowId.toString(), reason },
    note: "Buyer signs this to open a dispute. TrustLayer arbiter will review.",
  };
}

export function buildReclaimTx(escrowId) {
  return {
    to: getContract(),
    function: "reclaimExpired",
    args: { escrowId: escrowId.toString() },
    note: "Buyer can call this after deadline if seller didn't deliver. Full refund.",
  };
}

export function buildClaimByTimeoutTx(escrowId) {
  return {
    to: getContract(),
    function: "claimByTimeout",
    args: { escrowId: escrowId.toString() },
    note: "Seller can call this if buyer didn't accept/dispute within acceptance window.",
  };
}
