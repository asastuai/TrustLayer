import dotenv from "dotenv";
dotenv.config();

import { Clanker } from "clanker-sdk/v4";
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";

const TOKEN_NAME = "TrustLayer";
const TOKEN_SYMBOL = "TRUST";
const TOKEN_DESCRIPTION =
  "The Trust Layer for the Agent Economy. 4-in-1: Skill Audit (ClawScan) + Agent QA (QABot) + SLA Monitor (Sentinel) + Payment Escrow. Powered by x402 on Base.";
const TOKEN_IMAGE = "ipfs://YOUR_LOGO_CID_HERE"; // Upload logo first via nft.storage

async function main() {
  console.log("🏗️  Deploying $TRUST on Base via Clanker v4...\n");

  const account = privateKeyToAccount(process.env.PRIVATE_KEY);
  console.log(`📍 Deployer: ${account.address}`);

  const publicClient = createPublicClient({ chain: base, transport: http() });
  const wallet = createWalletClient({ account, chain: base, transport: http() });
  const clanker = new Clanker({ publicClient, wallet });

  const { txHash, waitForTransaction, error } = await clanker.deploy({
    name: TOKEN_NAME,
    symbol: TOKEN_SYMBOL,
    image: TOKEN_IMAGE,
    tokenAdmin: account.address,
    metadata: {
      description: TOKEN_DESCRIPTION,
      socialMediaUrls: ["https://x.com/TrustLayerXYZ", "https://trustlayer.xyz"],
    },
    context: { interface: "Clanker SDK" },
    vanity: true,
    fees: { type: "dynamic", baseFee: 100, maxFee: 500 },
    vault: {
      percentage: 15,
      lockupDuration: 2592000,  // 30 days
      vestingDuration: 2592000, // 30 days
      recipient: account.address,
    },
    rewards: {
      recipients: [
        { recipient: account.address, admin: account.address, bps: 8000, token: "Paired" },
        { recipient: account.address, admin: account.address, bps: 2000, token: "Both" },
      ],
    },
    sniperFees: { startingFee: 500000, endingFee: 10000, secondsToDecay: 30 },
  });

  if (error) { console.error("❌", error); process.exit(1); }

  console.log(`✅ TX: ${txHash}\n   Waiting for confirmation...`);
  const result = await waitForTransaction();

  console.log(`
🎉 $TRUST DEPLOYED!
   Token:      ${result.address}
   Basescan:   https://basescan.org/token/${result.address}
   Clanker:    https://www.clanker.world/clanker/${result.address}
   DexScreener: https://dexscreener.com/base/${result.address}

💡 Next steps:
   1. Claim LP fees at: https://www.clanker.world/clanker/${result.address}/admin
   2. Add token address to .env
   3. Deploy server to Railway
  `);
}

main().catch(console.error);
