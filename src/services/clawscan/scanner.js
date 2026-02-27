import * as P from "./patterns.js";
// ClawScan — Skill Auditor (part of TrustLayer suite)

/**
 * Main scan function — analyzes a skill's content and returns a trust report.
 * @param {string} content - Raw SKILL.md content (or full skill directory text)
 * @param {string} skillName - Name of the skill
 * @param {object} metadata - Optional metadata (publisher, age, version, etc.)
 */
export function scanSkill(content, skillName, metadata = {}) {
  const startTime = Date.now();
  const findings = [];

  // 1. Metadata analysis
  const metaFindings = analyzeMetadata(skillName, metadata);
  findings.push(...metaFindings);

  // 2. Permission analysis
  const permFindings = analyzePermissions(content, skillName);
  findings.push(...permFindings);

  // 3. Content analysis (prompt injection, hidden instructions, obfuscation)
  const contentFindings = analyzeContent(content);
  findings.push(...contentFindings);

  // 4. Supply chain analysis (external URLs, prerequisites, dependencies)
  const supplyFindings = analyzeSupplyChain(content);
  findings.push(...supplyFindings);

  // 5. Behavioral analysis (credential access, exfiltration, shells)
  const behaviorFindings = analyzeBehavior(content);
  findings.push(...behaviorFindings);

  // Calculate scores per category
  const categories = {
    metadata: scoreCategory(metaFindings),
    permissions: scoreCategory(permFindings),
    content: scoreCategory(contentFindings),
    supply_chain: scoreCategory(supplyFindings),
    behavioral: scoreCategory(behaviorFindings),
  };

  // Weighted trust score
  const trustScore = Math.round(
    categories.metadata * 0.2 +
    categories.permissions * 0.25 +
    categories.content * 0.25 +
    categories.supply_chain * 0.2 +
    categories.behavioral * 0.1
  );

  // Force CRITICAL if any auto-fail condition
  const hasCriticalAutoFail =
    P.KNOWN_MALICIOUS_NAMES.has(skillName.toLowerCase()) ||
    findings.some(
      (f) =>
        f.severity === "CRITICAL" &&
        ["reverse_shell", "credential_exfiltration", "malicious_prerequisite", "known_malicious"].includes(f.check)
    );

  const finalScore = hasCriticalAutoFail ? Math.min(trustScore, 10) : trustScore;

  const riskLevel =
    finalScore >= 90 ? "SAFE" :
    finalScore >= 70 ? "LOW_RISK" :
    finalScore >= 40 ? "MEDIUM_RISK" :
    finalScore >= 20 ? "HIGH_RISK" : "CRITICAL";

  const recommendation =
    riskLevel === "SAFE" ? "This skill appears safe to install." :
    riskLevel === "LOW_RISK" ? "Generally safe. Review the noted findings before installing." :
    riskLevel === "MEDIUM_RISK" ? "Proceed with caution. Several concerns detected." :
    riskLevel === "HIGH_RISK" ? "NOT recommended. Multiple high-severity findings." :
    "DO NOT INSTALL. Critical threats detected.";

  return {
    skill: skillName,
    trust_score: finalScore,
    risk_level: riskLevel,
    scan_duration_ms: Date.now() - startTime,
    categories,
    findings: findings.map((f) => ({
      category: f.category,
      severity: f.severity,
      check: f.check,
      detail: f.detail,
      ...(f.location && { location: f.location }),
      ...(f.pattern && { pattern: f.pattern }),
    })),
    counts: {
      critical: findings.filter((f) => f.severity === "CRITICAL").length,
      high: findings.filter((f) => f.severity === "HIGH").length,
      medium: findings.filter((f) => f.severity === "MEDIUM").length,
      low: findings.filter((f) => f.severity === "LOW").length,
    },
    recommendation,
    timestamp: new Date().toISOString(),
    source: "clawscan:v1",
  };
}

// ====== CATEGORY ANALYZERS ======

function analyzeMetadata(skillName, metadata) {
  const findings = [];
  const nameLower = skillName.toLowerCase();

  // Check known malicious
  if (P.KNOWN_MALICIOUS_NAMES.has(nameLower)) {
    findings.push({
      category: "metadata", severity: "CRITICAL", check: "known_malicious",
      detail: `"${skillName}" is on the known malicious skills list (ClawHavoc campaign).`,
    });
  }

  // Typosquatting detection
  for (const legit of P.LEGITIMATE_SKILL_NAMES) {
    if (nameLower !== legit && levenshtein(nameLower, legit) <= 2) {
      findings.push({
        category: "metadata", severity: "HIGH", check: "typosquatting",
        detail: `Name "${skillName}" is suspiciously similar to legitimate skill "${legit}". Possible typosquat.`,
        pattern: "levenshtein_distance",
      });
      break;
    }
  }

  // Publisher age
  if (metadata.publisherAgeDays !== undefined && metadata.publisherAgeDays < 7) {
    findings.push({
      category: "metadata", severity: "MEDIUM", check: "new_publisher",
      detail: `Publisher account is ${metadata.publisherAgeDays} days old. New accounts have higher risk.`,
    });
  }

  return findings;
}

function analyzePermissions(content, skillName) {
  const findings = [];
  const contentLower = content.toLowerCase();

  // Extract permissions from content
  const detectedPerms = [];
  if (/shell\.execute|exec\(|child_process|spawn\(/i.test(content)) detectedPerms.push("shell.execute");
  if (/fs\.read|readFile|readdir|fs\.access/i.test(content)) detectedPerms.push("fs.read");
  if (/fs\.write|writeFile|appendFile|fs\.mkdir/i.test(content)) detectedPerms.push("fs.write");
  if (/fs\.read.*root|\/etc\/|\/usr\/|~\/\./i.test(content)) detectedPerms.push("fs.read_root");
  if (/fetch\(|http|https|axios|request\(/i.test(content)) detectedPerms.push("network.outbound");

  // Check against category rules
  const nameLower = skillName.toLowerCase();
  for (const [category, rules] of Object.entries(P.PERMISSION_RULES)) {
    if (nameLower.includes(category)) {
      for (const perm of detectedPerms) {
        if (rules.suspicious.includes(perm)) {
          findings.push({
            category: "permissions", severity: "CRITICAL", check: "excessive_permissions",
            detail: `Skill "${skillName}" (category: ${category}) requests "${perm}" which is suspicious for this type.`,
            pattern: `${perm}_on_${category}`,
          });
        }
      }
      break;
    }
  }

  // shell.execute is always worth flagging
  if (detectedPerms.includes("shell.execute") && detectedPerms.includes("network.outbound")) {
    findings.push({
      category: "permissions", severity: "HIGH", check: "dangerous_combo",
      detail: "Skill has both shell execution AND network access. This combination enables remote code execution.",
    });
  }

  return findings;
}

function analyzeContent(content) {
  const findings = [];
  const lines = content.split("\n");

  // Prompt injection
  matchPatterns(content, lines, P.PROMPT_INJECTION, "content", "CRITICAL", "prompt_injection", findings);

  // Obfuscation
  matchPatterns(content, lines, P.OBFUSCATION, "content", "HIGH", "obfuscation", findings);

  // Dangerous commands
  matchPatterns(content, lines, P.DANGEROUS_COMMANDS, "content", "CRITICAL", "dangerous_command", findings);

  return findings;
}

function analyzeSupplyChain(content) {
  const findings = [];
  const lines = content.split("\n");

  // Fake prerequisites
  matchPatterns(content, lines, P.FAKE_PREREQUISITES, "supply_chain", "CRITICAL", "malicious_prerequisite", findings);

  // Check external URLs that aren't well-known
  const urlRegex = /https?:\/\/[^\s"'<>)]+/g;
  const urls = content.match(urlRegex) || [];
  const trustedDomains = [
    "github.com/openclaw", "clawhub.ai", "moltbook.com",
    "npmjs.com", "pypi.org", "docs.openclaw.ai",
    "api.anthropic.com", "api.openai.com",
  ];

  for (const url of urls) {
    const isTrusted = trustedDomains.some((d) => url.includes(d));
    if (!isTrusted && /github\.com.*\/releases\/download/i.test(url)) {
      findings.push({
        category: "supply_chain", severity: "HIGH", check: "untrusted_download",
        detail: `Skill downloads binary from untrusted GitHub release: ${url.slice(0, 100)}`,
      });
    }
  }

  return findings;
}

function analyzeBehavior(content) {
  const findings = [];
  const lines = content.split("\n");

  // Credential access
  matchPatterns(content, lines, P.CREDENTIAL_ACCESS, "behavioral", "CRITICAL", "credential_access", findings);

  // Exfiltration URLs
  matchPatterns(content, lines, P.EXFILTRATION_URLS, "behavioral", "CRITICAL", "credential_exfiltration", findings);

  // Reverse shell
  matchPatterns(content, lines, P.REVERSE_SHELL, "behavioral", "CRITICAL", "reverse_shell", findings);

  return findings;
}

// ====== HELPERS ======

function matchPatterns(content, lines, patterns, category, severity, check, findings) {
  for (const pattern of patterns) {
    const match = content.match(pattern);
    if (match) {
      const lineNum = lines.findIndex((l) => pattern.test(l)) + 1;
      findings.push({
        category,
        severity,
        check,
        detail: `Detected ${check} pattern: "${match[0].slice(0, 80)}"`,
        location: lineNum > 0 ? `line ${lineNum}` : undefined,
        pattern: pattern.source.slice(0, 60),
      });
    }
  }
}

function scoreCategory(findings) {
  if (!findings.length) return 100;
  let score = 100;
  for (const f of findings) {
    if (f.severity === "CRITICAL") score -= 35;
    else if (f.severity === "HIGH") score -= 20;
    else if (f.severity === "MEDIUM") score -= 10;
    else if (f.severity === "LOW") score -= 5;
  }
  return Math.max(0, score);
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}
