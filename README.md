# 🏗️ TrustLayer

**The Trust Layer for the Agent Economy — 4 services, 1 API, 1 token.**

TrustLayer provides the complete trust infrastructure that the AI agent economy needs to scale safely. Built on Base, paid via x402 micropayments.

## The 4 Services

### 🛡️ ClawScan — Skill Auditor
Scans OpenClaw/ClawHub skills for malware, prompt injection, credential theft, and supply chain attacks. Built in response to the ClawHavoc attack (341+ malicious skills found Feb 2026).

### 🧪 QABot — Agent Testing
Tests AI agents for responsiveness, accuracy, safety, and adversarial robustness. The first "CI/CD for agents" — run automated test suites against any x402 service.

### 📡 Sentinel — SLA Monitor
Pings x402 services every 60 seconds, tracking uptime, latency, and reliability. Public leaderboard ranks services by real performance data. The "UptimeRobot" of the agent economy.

### 🔄 Escrow — Payment Protection
Manages payment protection for agent-to-agent transactions. Escrow, delivery verification, disputes, and auto-resolution. The missing "buyer protection" for x402.

## Quick Start

```bash
git clone https://github.com/YOUR_USER/trustlayer.git
cd trustlayer
npm install
cp .env.example .env  # Edit with your wallet
npm start
```

## API Overview

| Service | Endpoint | Price | Description |
|---------|----------|-------|-------------|
| ClawScan | `POST /api/v1/skill/scan` | $0.01 | Quick scan a skill |
| ClawScan | `POST /api/v1/skill/verify` | $2.00 | Deep verification + badge |
| ClawScan | `GET /api/v1/skill/lookup` | Free | Lookup existing score |
| QABot | `POST /api/v1/qa/test` | $0.05 | Quick test suite |
| QABot | `POST /api/v1/qa/full` | $0.50 | Full safety test |
| QABot | `POST /api/v1/qa/adversarial` | $1.00 | Red team testing |
| Sentinel | `GET /api/v1/sla/live` | Free | Live status dashboard |
| Sentinel | `GET /api/v1/sla/leaderboard` | Free | Service rankings |
| Sentinel | `GET /api/v1/sla/report` | $0.01 | Detailed SLA report |
| Sentinel | `POST /api/v1/sla/register` | Free | Register service for monitoring |
| Escrow | `POST /api/v1/escrow/create` | $0.10 | Create escrow |
| Escrow | `GET /api/v1/escrow/:id` | Free | Check escrow status |
| Escrow | `POST /api/v1/escrow/dispute` | $0.50 | File dispute |

## Token: $TRUST

- **Supply:** 100M fixed
- **Chain:** Base (via Clanker v4)
- **Utility:** Stake for free scans, discounts on verification, bug bounty rewards, governance
- **Revenue split:** 50% buyback, 25% founder, 15% bug bounty, 10% infra

## Why TrustLayer

The agent economy is a $30T opportunity (a16z estimate). But without trust infrastructure, it can't scale:
- **Before install** → ClawScan checks if skills are safe
- **After deploy** → QABot tests if agents work correctly
- **In production** → Sentinel monitors if services stay reliable
- **During transactions** → Escrow protects payments

We are the Moody's + UptimeRobot + PayPal Buyer Protection of the agent economy. In one API.

## License

MIT
