import dotenv from "dotenv";
dotenv.config();

import { createPublicClient, createWalletClient, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { readFileSync } from "fs";

/**
 * Deploy ClawVault escrow contract to Base.
 *
 * Prerequisites:
 *   1. Compile with: npx solc --abi --bin --optimize contracts/ClawVault.sol
 *      OR use Remix IDE (remix.ethereum.org) — paste contract, compile, copy ABI + bytecode
 *   2. Set COMPILED_ABI_PATH and COMPILED_BIN_PATH below
 *
 * Constructor args:
 *   - USDC on Base: 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
 *   - Arbiter: your wallet (migrate to multisig later)
 *   - Fee recipient: your wallet (protocol fees go here)
 *   - Fee: 100 bps = 1%
 */

const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const FEE_BPS = 100; // 1% protocol fee

async function main() {
  console.log("🔐 Deploying ClawVault to Base...\n");

  const account = privateKeyToAccount(process.env.PRIVATE_KEY);
  console.log(`📍 Deployer/Arbiter: ${account.address}`);
  console.log(`💰 Fee: ${FEE_BPS / 100}%`);
  console.log(`🪙 USDC: ${USDC_BASE}\n`);

  const publicClient = createPublicClient({ chain: base, transport: http() });
  const walletClient = createWalletClient({ account, chain: base, transport: http() });

  // Check balance
  const balance = await publicClient.getBalance({ address: account.address });
  console.log(`⛽ ETH balance: ${(Number(balance) / 1e18).toFixed(6)} ETH`);
  if (balance < 10000000000000n) { // 0.00001 ETH
    console.error("❌ Not enough ETH for gas");
    process.exit(1);
  }

  // ============================================
  // OPTION 1: Deploy via pre-compiled artifacts
  // ============================================
  // Uncomment and set paths if you compiled locally:
  //
  // const abi = JSON.parse(readFileSync("./contracts/ClawVault.abi", "utf-8"));
  // const bytecode = "0x" + readFileSync("./contracts/ClawVault.bin", "utf-8").trim();
  //
  // const hash = await walletClient.deployContract({
  //   abi,
  //   bytecode,
  //   args: [USDC_BASE, account.address, account.address, BigInt(FEE_BPS)],
  // });

  // ============================================
  // OPTION 2: Deploy via Remix
  // ============================================
  // 1. Go to https://remix.ethereum.org
  // 2. Paste ClawVault.sol
  // 3. Add OpenZeppelin: @openzeppelin/contracts (Remix handles this)
  // 4. Compile with Solidity 0.8.24+
  // 5. Deploy tab → Injected Provider (MetaMask on Base)
  // 6. Constructor args:
  //    _usdc: 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
  //    _arbiter: [your wallet address]
  //    _feeRecipient: [your wallet address]
  //    _feeBps: 100
  // 7. Deploy → save contract address

  console.log(`
╔══════════════════════════════════════════════════════════════╗
║  CLAWVAULT DEPLOYMENT GUIDE                                  ║
╠══════════════════════════════════════════════════════════════╣
║                                                              ║
║  Easiest method: Remix IDE                                   ║
║                                                              ║
║  1. Go to https://remix.ethereum.org                         ║
║  2. Create new file: ClawVault.sol                           ║
║  3. Paste the contract from contracts/ClawVault.sol          ║
║  4. Compiler tab → Solidity 0.8.24 → Compile                ║
║  5. Deploy tab → Environment: Injected Provider              ║
║     (MetaMask connected to Base Mainnet)                     ║
║                                                              ║
║  Constructor arguments:                                      ║
║    _usdc:         ${USDC_BASE}  ║
║    _arbiter:      ${account.address}  ║
║    _feeRecipient: ${account.address}  ║
║    _feeBps:       ${FEE_BPS}                                            ║
║                                                              ║
║  6. Click Deploy → confirm in MetaMask                       ║
║  7. Copy contract address                                    ║
║  8. Add to .env: ESCROW_CONTRACT_ADDRESS=0x...               ║
║  9. Verify on Basescan:                                      ║
║     https://basescan.org/verifyContract                      ║
║                                                              ║
║  Gas estimate: ~0.002 ETH (~$5)                              ║
║                                                              ║
╚══════════════════════════════════════════════════════════════╝
  `);
}

main().catch(console.error);
