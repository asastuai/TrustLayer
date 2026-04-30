<div align="center">

# TrustLayer

### Reputation primitive for the agentic economics. PoC-grounded, x402-native, on Base.

[![Base L2](https://img.shields.io/badge/Base-L2-0052FF.svg)](https://base.org)
[![x402](https://img.shields.io/badge/payments-x402-brightgreen.svg)](https://www.x402.org/)
[![Node](https://img.shields.io/badge/Node.js-20%2B-339933.svg)](https://nodejs.org/)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

*Part of [**Aletheia**](https://github.com/asastuai/aletheia). Full stack for the agentic economics.*

</div>

---

## What it is

TrustLayer is the reputation layer of the agentic economics. Four primitives that autonomous agents need before they can transact with unfamiliar counterparties: skill audit, test harness, uptime monitoring, payment escrow. Single API. x402-paid. Base-native.

The four services share one underlying signal: PoC commitments. Each service produces or consumes attestations bound to a freshness horizon, and reputation aggregates over the lifetime of those commitments per agent-key.

| Service | Role | What PoC type it produces |
|---|---|---|
| **ClawScan** | Skill auditor. Scans for malware, prompt injection, credential theft, supply-chain attacks. | `f_c` (when scanned) + signed safety attestation |
| **QABot** | Test harness. Tests agents for responsiveness, accuracy, safety, adversarial robustness. | `f_m` (model version tested) + behavior attestation |
| **Sentinel** | SLA monitor. Pings registered x402 services every 60s. | `f_c` (uptime samples) + reliability attestation |
| **Escrow** | Payment escrow. Buyer protection for agent-to-agent transactions. | Settlement gate. Releases funds against a PoC commitment from the provider. |

ClawScan was built in response to the ClawHavoc attack (341+ malicious skills identified in Feb 2026). Sentinel and QABot exist because at machine speed, agents cannot do due diligence the way humans can.

---

## ◊ How it ties into Proof-of-Context

PoC is the verification primitive that binds attestations to a freshness horizon and gates settlement against it. TrustLayer is the aggregation layer above it.

Three concrete surfaces.

**1. Reputation is a function of PoC commitments, not vibes.** Each agent-key's reputation score is computed from the lifetime of PoC commitments associated with it. Successful commitments raise score. Freshness violations slash it. Disputes resolved against the agent slash harder.

**2. Service attestations are PoC-typed.** ClawScan, QABot, Sentinel emit attestations that include the freshness type they are claiming to verify (`f_c`, `f_m`, `f_i`). A consumer of a TrustLayer attestation knows exactly what dimension of context was checked and when.

**3. Escrow uses PoC commitments as release condition.** Settlement gating in practice. If the counterparty's PoC commitment at delivery time has drifted past horizon, the escrow does not release. This is not a metaphor. It is the same mechanic SUR Protocol's A2A dark pool uses for trade settlement, applied to escrowed payments between agents.

The remaining surface (cross-protocol reputation portability — agent reputation built on TrustLayer carrying to other marketplaces) is documented as the next-step integration. Currently TrustLayer is a single-protocol reputation primitive on Base.

---

## The 4 services

### ClawScan — skill auditor

Scans OpenClaw / ClawHub skills for malware, prompt injection, credential theft, and supply-chain attacks. Returns a structured safety score plus a PoC-typed attestation signed by the auditor.

### QABot — agent test harness

Tests AI agents for responsiveness, accuracy, safety, and adversarial robustness. Run automated test suites against any x402 service. The "CI/CD for agents" primitive. Each test run produces a PoC commitment over the model version, sampling parameters, and test surface.

### Sentinel — SLA monitor

Pings registered x402 services every 60 seconds. Tracks uptime, latency, reliability. Public leaderboard ranks services by real performance, not claims. Every uptime sample is an `f_c`-typed PoC commitment.

### Escrow — payment escrow

Escrow contract layer for agent-to-agent transactions. Delivery verification, disputes, auto-resolution. Release is conditional on the counterparty's PoC commitment being within freshness horizon at delivery time. Buyer protection without centralized intermediary.

---

## Quick start

```bash
git clone https://github.com/asastuai/TrustLayer.git
cd trustlayer
npm install
cp .env.example .env   # edit with your wallet
npm start
```

---

## API

| Service | Endpoint | Price | Description |
|---|---|---|---|
| ClawScan | `POST /api/v1/skill/scan` | $0.01 | Quick scan |
| ClawScan | `POST /api/v1/skill/verify` | $2.00 | Deep verification + badge |
| ClawScan | `GET /api/v1/skill/lookup` | Free | Lookup existing score |
| QABot | `POST /api/v1/qa/test` | $0.05 | Quick test suite |
| QABot | `POST /api/v1/qa/full` | $0.50 | Full safety test |
| QABot | `POST /api/v1/qa/adversarial` | $1.00 | Red team |
| Sentinel | `GET /api/v1/sla/live` | Free | Live status dashboard |
| Sentinel | `GET /api/v1/sla/leaderboard` | Free | Service rankings |
| Sentinel | `GET /api/v1/sla/report` | $0.01 | Detailed SLA report |
| Sentinel | `POST /api/v1/sla/register` | Free | Register service |
| Escrow | `POST /api/v1/escrow/create` | $0.10 | Create escrow |
| Escrow | `GET /api/v1/escrow/:id` | Free | Check escrow status |
| Escrow | `POST /api/v1/escrow/dispute` | $0.50 | File dispute |

All priced endpoints are x402-native. Paid in USDC at request time. No accounts, no subscriptions.

---

## Token: $TRUST

| Property | Value |
|---|---|
| Supply | 100M fixed |
| Chain | Base (via Clanker v4) |
| Utility | Stake for free scans, verification discounts, bug-bounty rewards, governance |
| Revenue split | 50% buyback / 25% operator / 15% bug bounty / 10% infrastructure |

---

## Why this exists

Before two agents can transact at scale, four questions need cheap, verifiable answers.

- Before install. Is this skill safe? → ClawScan.
- After deploy. Does this agent behave correctly? → QABot.
- In production. Will the service stay up? → Sentinel.
- During payment. Can I recover if the counterparty defaults? → Escrow.

TrustLayer answers all four from one x402 API. Each answer is a PoC commitment, not a verbal claim.

---

## Tests

```bash
npm test
```

13 tests passing. Coverage:

- 8 PoC primitive tests (multi-type attest, verify, payload tampering, horizon expiry, default freshness type, getPublicKey).
- 5 endpoint smoke tests (info, health, poc/public-key, sla/live, sla/leaderboard).

Tests use `node --test`. No external runner.

---

## Generating a PoC signing key

```bash
npm run gen-poc-key
```

Set the private key as `POC_SIGNING_KEY` in `.env`. Publish the public key so consumers can verify TrustLayer attestations against your operator identity.

If `POC_SIGNING_KEY` is unset, attestations are returned without signatures (still informational, but not cryptographically bound).

---

## Status

Honest snapshot.

| What runs | What is missing |
|---|---|
| 4 service primitives wired. 8 paid endpoints emit Ed25519-signed PoC attestations (`f_c` for ClawScan + Sentinel, `f_m` for QABot, `f_s` for Escrow). 13 tests passing. `/api/v1/poc/public-key` published. | Production traffic. Cross-protocol reputation portability. On-chain PoC commitment registry. Triple-anchor `block_height` + `drand_round` wiring. Escrow on-chain V2 (currently centralized beta). |

---

## ❖ Part of Aletheia

TrustLayer is the reputation layer of [Aletheia](https://github.com/asastuai/aletheia). Five sibling repos compose the rest of the stack.

- [**Proof-of-Context**](https://github.com/asastuai/proof-of-context) — verification spine. The primitive TrustLayer aggregates.
- [**SUR Protocol**](https://github.com/asastuai/sur-protocol) — perp DEX. Source of high-frequency PoC commitments from agent trading.
- [**PayClaw**](https://github.com/asastuai/payclaw) — agent wallet. Holds funds released through TrustLayer's escrow.
- [**BaseOracle**](https://github.com/asastuai/BaseOracle) — pay-per-query market data. Producer of `f_i`-attested commitments.
- [**Vigil**](https://github.com/asastuai/vigil) — DeFi intelligence. Producer of risk and MEV signal commitments.

---

## License

MIT. See [LICENSE](LICENSE).

---

Built by [Juan Cruz Maisu](https://github.com/asastuai). Buenos Aires, Argentina.
