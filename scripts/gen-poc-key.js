/**
 * Generate a fresh Ed25519 keypair for PoC attestation signing.
 *
 * Usage:
 *   node scripts/gen-poc-key.js
 *
 * Prints the private key (hex) and public key (hex).
 * Set POC_SIGNING_KEY=<private> in your .env to enable signed attestations.
 */

import { randomBytes } from "node:crypto";
import { getPublicKeyAsync, etc } from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha2";

// Wire sha512 via the etc namespace. Compatible with @noble/ed25519 v2.x and v3.x
// (the v3 release sealed the older `ed.hashes` namespace; etc.sha512Async is the
// stable surface across both).
etc.sha512Async = async (...m) => sha512(etc.concatBytes(...m));

function toHex(bytes) {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

const privateKey = randomBytes(32);
const publicKey = await getPublicKeyAsync(privateKey);

console.log("=".repeat(60));
console.log("PoC Ed25519 keypair generated");
console.log("=".repeat(60));
console.log("");
console.log("PRIVATE KEY (set as POC_SIGNING_KEY in .env):");
console.log(`  ${toHex(privateKey)}`);
console.log("");
console.log("PUBLIC KEY (publish this so consumers can verify attestations):");
console.log(`  ${toHex(publicKey)}`);
console.log("");
console.log("WARNING: store the private key securely. Never commit to git.");
console.log("");
