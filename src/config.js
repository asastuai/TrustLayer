import dotenv from "dotenv";
dotenv.config();

export const config = {
  port: parseInt(process.env.PORT || "3000"),
  privateKey: process.env.PRIVATE_KEY,
  payToAddress: process.env.PAY_TO_ADDRESS,
  baseRpcUrl: process.env.BASE_RPC_URL || "https://mainnet.base.org",
  basescanApiKey: process.env.BASESCAN_API_KEY,
  facilitatorUrl: process.env.X402_FACILITATOR_URL || "https://api.cdp.coinbase.com/platform/v2/x402",
  usdcAddress: process.env.USDC_BASE_ADDRESS || "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  escrowContract: process.env.ESCROW_CONTRACT_ADDRESS,
  network: "eip155:8453",
  monitorInterval: parseInt(process.env.MONITOR_INTERVAL_MS || "60000"),

  // Pricing for all 4 services
  pricing: {
    // ClawScan — Skill Auditor
    skillScan: "$0.01",
    skillVerify: "$2.00",

    // QABot — Agent Testing
    qaQuick: "$0.05",
    qaFull: "$0.50",
    qaAdversarial: "$1.00",

    // Sentinel — SLA Monitor
    slaStatus: "$0.002",
    slaReport: "$0.01",
    slaSubscribe: "$0.50",

    // Escrow
    escrowCreate: "$0.10",
    escrowDispute: "$0.50",
  },
};

if (!config.payToAddress) {
  console.warn("⚠️  Missing PAY_TO_ADDRESS — paid endpoints will not work");
}
