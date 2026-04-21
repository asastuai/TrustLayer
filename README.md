<div align="center">

# 🏗️ TrustLayer

### Trust infrastructure for the AI-agent economy on Base

[![Base L2](https://img.shields.io/badge/Base-L2-0052FF.svg)](https://base.org)
[![x402](https://img.shields.io/badge/payments-x402-brightgreen.svg)](https://www.x402.org/)
[![Node](https://img.shields.io/badge/Node.js-20%2B-339933.svg)](https://nodejs.org/)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Related](https://img.shields.io/badge/BaseOracle-agent%20data-blueviolet.svg)](https://github.com/asastuai/BaseOracle)

Four trust primitives that autonomous agents need before the economy between them can scale: **skill audit, test harness, uptime monitoring, and payment escrow.** Single API, x402-paid, Base-native.

</div>

---

## What it is

As AI agents start transacting with each other autonomously, the missing piece isn't compute or capability — it's **verifiable trust between unfamiliar counterparties**. TrustLayer ships the four primitives you'd want before letting an agent pay another agent for work:

| Service | Role | Analogy |
|---------|------|---------|
| 🛡️ **ClawScan** | Skill auditor | Moody's for agent-installable skills |
| 🧪 **QABot** | Test harness | CI/CD for agent capabilities |
| 📡 **Sentinel** | SLA monitor | Uptime leaderboard for x402 services |
| 🔄 **Escrow** | Payment escrow | Buyer protection for agent-to-agent payments |

Each is consumable as a standalone x402 endpoint. Combined, they form a **proof-of-context layer** — a history-of-contextually-appropriate-behavior that agents can check before trusting, and operators can bond against.

Part of a small agent-infra stack:

- [**TrustLayer**](https://github.com/asastuai/TrustLayer) — *(this repo)* — trust infrastructure for agents
- [**BaseOracle**](https://github.com/asastuai/BaseOracle) — pay-per-query data for agents
- [**PayClaw**](https://github.com/asastuai/payclaw) — agent wallet SDK with programmable rules

---

## The 4 services

### 🛡️ ClawScan — Skill auditor

Scans OpenClaw / ClawHub skills for malware, prompt injection, credential theft, and supply-chain attacks. Built in response to the ClawHavoc attack (341+ malicious skills identified in Feb 2026). Returns a structured safety score.

### 🧪 QABot — Agent testing

Tests AI agents for responsiveness, accuracy, safety, and adversarial robustness. Run automated test suites against any x402 service — the "CI/CD for agents" primitive.

### 📡 Sentinel — SLA monitor

Pings registered x402 services every 60 seconds, tracking uptime, latency, and reliability. Public leaderboard ranks services by real performance, not claims.

### 🔄 Escrow — Payment protection

Escrow contract layer for agent-to-agent transactions: delivery verification, disputes, auto-resolution. Makes the buyer-protection primitive available without a centralized intermediary.

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
|---------|----------|-------|-------------|
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

All priced endpoints are x402-native — paid in USDC at request time, no accounts, no subscriptions.

---

## Token: $TRUST

| Property | Value |
|----------|-------|
| Supply | 100M fixed |
| Chain | Base (via Clanker v4) |
| Utility | Stake for free scans, verification discounts, bug-bounty rewards, governance |
| Revenue split | 50% buyback · 25% operator · 15% bug bounty · 10% infrastructure |

---

## Why this exists

Before two agents can transact at scale, four questions need cheap, verifiable answers:

- **Before install** → is this skill safe? *(ClawScan)*
- **After deploy** → does this agent behave correctly? *(QABot)*
- **In production** → will the service stay up? *(Sentinel)*
- **During payment** → can I recover if the counterparty defaults? *(Escrow)*

TrustLayer answers all four from one x402 API.

---

## License

MIT — see [LICENSE](LICENSE).

---

Built by [Juan Cruz Maisu](https://github.com/asastuai) · Buenos Aires, Argentina
