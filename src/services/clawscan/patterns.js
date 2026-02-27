/**
 * Pattern databases for skill scanning.
 * Sourced from real ClawHavoc campaign analysis, Koi Security audit,
 * Semgrep OpenClaw cheat sheet, Adversa AI SecureClaw, and HaveIBeenClawned.
 */

// ====== MALICIOUS PATTERNS ======

export const CREDENTIAL_ACCESS = [
  /~\/\.openclaw\/\.env/,
  /~\/\.clawdbot\/\.env/,
  /~\/\.moltbot\//,
  /creds\.json/i,
  /gateway.*token/i,
  /sessionKey/,
  /ANTHROPIC_API_KEY/,
  /OPENAI_API_KEY/,
  /PRIVATE_KEY/,
  /\.env\b/,
  /process\.env/,
  /keychain/i,
];

export const EXFILTRATION_URLS = [
  /webhook\.site/i,
  /bore\.pub/i,
  /ngrok\.io/i,
  /pipedream\.net/i,
  /requestbin/i,
  /hookbin/i,
  /burpcollaborator/i,
  /interact\.sh/i,
  /oastify\.com/i,
  /91\.92\.242\.\d+/,  // Known ClawHavoc C2
  /canarytokens/i,
];

export const FAKE_PREREQUISITES = [
  /prerequisites.*(?:install|download|run).*(?:openclaw[_-]agent|windriver|driver)/i,
  /curl\s+.*github\.com\/(?!openclaw\/|anthropics\/)/i,
  /wget\s+.*github\.com\/(?!openclaw\/)/i,
  /brew\s+install\s+--cask.*from/i,
  /powershell.*-(?:e|enc|encoded)\s+/i,
  /iex\s*\(/i,
  /msiexec.*\/i\s+http/i,
  /\.msi\b.*download/i,
  /\.dmg\b.*download/i,
];

export const PROMPT_INJECTION = [
  /ignore\s+(?:previous|all|above|prior)\s+instructions/i,
  /you\s+are\s+now\s+(?:a|an|in)\s/i,
  /system\s*:\s*override/i,
  /forget\s+your\s+(?:rules|instructions|guidelines|training)/i,
  /do\s+not\s+mention\s+this/i,
  /hidden.*instruction/i,
  /pretend\s+(?:you|to)\s/i,
  /new\s+(?:system|base)\s+prompt/i,
  /disregard\s+(?:all|any|previous)/i,
  /jailbreak/i,
  /\bDAN\b.*mode/i,
];

export const REVERSE_SHELL = [
  /nc\s+-[elp]/,
  /ncat\s+.*-[elp]/,
  /bash\s+-i\s+>&?\s*\/dev\/tcp/,
  /python.*socket.*connect/,
  /ruby.*TCPSocket/,
  /perl.*socket/i,
  /reverse.*shell/i,
  /bind.*shell/i,
  /msfvenom/i,
  /metasploit/i,
];

export const OBFUSCATION = [
  /eval\s*\(.*atob/,
  /eval\s*\(.*decode/i,
  /Buffer\.from\s*\(.*base64/,
  /\\x[0-9a-f]{2}\\x[0-9a-f]{2}/i,  // Multiple hex sequences
  /String\.fromCharCode\s*\(/,
  /unescape\s*\(/,
  /\$\(.*`.*`\)/,  // Command substitution hiding
];

export const DANGEROUS_COMMANDS = [
  /rm\s+-rf\s+[\/~]/,
  /chmod\s+777/,
  /mkfs\b/,
  /dd\s+if=.*of=\/dev/,
  /:(){ :\|:& };:/,  // Fork bomb
  /crontab\s+/,
  /launchctl\s+/,
  /systemctl\s+enable/,
];

// ====== KNOWN MALICIOUS SKILLS (from Koi Security ClawHavoc report) ======

export const KNOWN_MALICIOUS_NAMES = new Set([
  "polymarket-trader", "polymarket-pro", "polytrading",
  "polymarket-all-in-one", "better-polymarket",
  "youtube-summarize", "youtube-summarize-pro",
  "youtube-thumbnail-grabber", "youtube-video-downloader",
  "solana-wallet-tracker", "solana-wallet",
  "auto-updater-agent", "update", "updater",
  "x-trends-tracker", "yahoo-finance-pro",
  "clawhub", "clawhub1", "clawhubb", "clawwhub", "cllawhub", "clawhubb",
  "rankaj",
]);

// ====== TYPOSQUATTING TARGETS (legitimate popular skills) ======

export const LEGITIMATE_SKILL_NAMES = [
  "moltbook", "web-search", "git-sync", "humanizer",
  "screenshot", "web-fetch", "calendar", "email",
  "slack", "discord", "telegram", "whatsapp",
  "github", "gitlab", "jira", "notion",
  "google-drive", "google-calendar", "google-sheets",
  "docker", "kubernetes", "aws", "azure",
  "postgres", "mysql", "redis", "mongodb",
  "stripe", "shopify", "salesforce",
  "memory", "browser", "terminal", "file-manager",
  "clanker", "bankr", "clawnch", "baseoracle",
];

// ====== PERMISSION/CATEGORY RULES ======
// What permissions are expected vs suspicious for skill categories

export const PERMISSION_RULES = {
  "wallet": { expected: ["network.outbound"], suspicious: ["shell.execute", "fs.write", "fs.read_root"] },
  "tracker": { expected: ["network.outbound"], suspicious: ["shell.execute", "fs.read_root"] },
  "summarize": { expected: ["network.outbound"], suspicious: ["shell.execute", "fs.read_root"] },
  "calendar": { expected: ["calendar"], suspicious: ["shell.execute", "network.outbound", "fs.read_root"] },
  "weather": { expected: ["network.outbound"], suspicious: ["shell.execute", "fs.write", "fs.read_root"] },
  "email": { expected: ["email", "network.outbound"], suspicious: ["shell.execute", "fs.read_root"] },
  "search": { expected: ["network.outbound"], suspicious: ["shell.execute", "fs.write"] },
  "social": { expected: ["network.outbound"], suspicious: ["shell.execute", "fs.read_root"] },
};
