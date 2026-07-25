'use strict';
/*
 * Dependency-audit gate (test-strategy T6).
 *
 * Wraps `pnpm audit --prod --json` and fails ONLY on a non-triaged advisory at or above the threshold
 * (default: high). Advisories the project has explicitly triaged live in `package.json` →
 * `pnpm.auditConfig.ignoreGhsas` (a single source of truth, with the rationale documented in SECURITY.md).
 * This gives a real blocking gate — a brand-new advisory in a prod dependency breaks CI — while known,
 * build-time-only advisories don't perpetually red the pipeline.
 *
 * pnpm 9's `pnpm audit` CLI does not filter by `package.json` > `pnpm.auditConfig.ignoreGhsas` and offers no
 * per-advisory ignore flag (verified: `pnpm audit --prod --audit-level high` still exits non-zero on the
 * triaged advisories), so we do the filtering here. No extra dependency: pnpm + Node only. `--prod` scopes to
 * runtime dependencies (dev-tool advisories are out of scope for what ships). Run it via `node scripts/audit.cjs`
 * (NOT `pnpm audit`, which is pnpm's built-in command, not this script). Bar: `AUDIT_LEVEL=critical|high|moderate|low`.
 */
const { execSync } = require('node:child_process');
const pkg = require('../package.json');

const LEVELS = { info: 0, low: 1, moderate: 2, high: 3, critical: 4 };
const levelName = process.env.AUDIT_LEVEL || 'high';
const threshold = LEVELS[levelName];
if (threshold === undefined) {
  console.error(
    `audit: unknown AUDIT_LEVEL "${levelName}" (expected info|low|moderate|high|critical)`,
  );
  process.exit(2);
}
const allow = new Set((pkg.pnpm && pkg.pnpm.auditConfig && pkg.pnpm.auditConfig.ignoreGhsas) || []);

let raw = '';
try {
  // pnpm exits non-zero when advisories exist; we still want the JSON, so capture stdout on throw too.
  raw = execSync('pnpm audit --prod --json', {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
} catch (err) {
  raw = err.stdout ? err.stdout.toString() : '';
}

let report;
try {
  report = JSON.parse(raw);
} catch {
  console.error('audit: could not parse `pnpm audit --prod --json` output — failing closed');
  process.exit(2);
}

// Fail CLOSED on a non-audit result. A registry/network failure returns valid JSON `{ "error": {...} }`
// (no `advisories`/`metadata`), which would otherwise sail through as "0 advisories" — a false green. A real
// run always carries `metadata`.
if (report.error) {
  const e = report.error;
  console.error(
    `audit: \`pnpm audit\` failed (${e.code || 'error'}: ${e.summary || e.message || 'unknown'}) — failing closed`,
  );
  process.exit(2);
}
if (!report.metadata) {
  console.error('audit: audit report missing `metadata` (unexpected shape) — failing closed');
  process.exit(2);
}

const advisories = Object.values(report.advisories || {});
const id = (a) => a.github_advisory_id || a.cves?.[0] || String(a.id);
const atOrAbove = advisories.filter((a) => (LEVELS[a.severity] ?? 0) >= threshold);
const triaged = atOrAbove.filter((a) => allow.has(id(a)));
const offending = atOrAbove.filter((a) => !allow.has(id(a)));

if (triaged.length) {
  console.log(
    `audit: ${triaged.length} triaged advisory(ies) ignored per pnpm.auditConfig.ignoreGhsas ` +
      `(see SECURITY.md): ${triaged.map(id).join(', ')}`,
  );
}
if (offending.length) {
  console.error(`audit: ${offending.length} un-triaged advisory(ies) at/above "${levelName}":`);
  for (const a of offending) {
    const path = a.findings?.[0]?.paths?.[0] || a.module_name;
    console.error(`  ${a.severity}\t${id(a)}\t${a.module_name}\t${path}`);
    console.error(
      `      Triage it (fix/upgrade, or add its GHSA to pnpm.auditConfig.ignoreGhsas + SECURITY.md).`,
    );
  }
  process.exit(1);
}
console.log(`audit: no un-triaged advisories at/above "${levelName}" in prod dependencies.`);
