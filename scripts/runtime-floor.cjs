'use strict';
/*
 * The detectors behind the runtime-floor policy gate, kept separate from
 * `tests/ci/runtime-version-policy.test.ts` so they can be fired at planted inputs from `tests/arch`.
 *
 * That separation is this repo's own convention — `scripts/sdk-specifiers.cjs`,
 * `scripts/dts-specifiers.cjs` and `tests/arch/no-circular.test.ts` all do it, because
 * "`pnpm lint` passing proves nothing about a rule that never matched". The floor policy skipped it, and an
 * adversarial review found exactly what that convention exists to prevent: with both patterns inlined in the
 * test and nothing firing them at planted inputs, `node-version: 22.11` (below the declared floor), a quoted
 * `node-version: "20"`, a pin with a trailing comment, and ten realistic phrasings of a prose floor
 * (`Node.js >= 20` foremost) all passed a green gate.
 */

/** `'22.12'` → `[22, 12]`. */
const parts = (v) => v.split('.').map(Number);

/** Numeric comparison, shorter version zero-padded: `22.12` === `22.12.0`. */
function compareVersions(a, b) {
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/**
 * Can `pin` resolve to something at or above `floor`?
 *
 * NOT a plain `compareVersions(pin, floor) >= 0`, and the difference is the whole point. A pin names a
 * PREFIX: `node-version: 22` and `.nvmrc: 22` both resolve to the latest 22.x, which is far above a 22.12
 * floor — so `22` must pass even though `22 < 22.12` numerically. `22.11` must fail, because it pins the
 * 22.11.x series and every member of it is below the floor. So compare only as far as the pin specifies.
 */
function satisfiesFloor(pin, floor) {
  const depth = parts(pin).length;
  return compareVersions(pin, parts(floor).slice(0, depth).join('.')) >= 0;
}

/**
 * Every prose declaration of a Node floor, as `{ raw, version }`.
 *
 * Matches the SHAPES people actually write a floor in, not just the one the README happens to use today:
 * an operator (`Node >= 22.12`, `Node.js ≥ 22.12`, `node > 22.12`), a trailing plus (`Node v22.12+`), or the
 * words (`Node 22.12 or later/newer/above`). `&nbsp;` counts as a space because this is Markdown.
 *
 * Deliberately NOT matched, because none of them declares a floor: `node:22-slim` (a Docker tag — the colon
 * is not a separator this accepts), `nodejs22.x` (an AWS runtime id — the `\b` after `node(.js)?` fails
 * against the digit), and a bare mention like "Node 20 reached EOL", which states history, not a
 * requirement. Each of those is present in this repo and must stay silent.
 */
function findNodeFloorClaims(text) {
  const SPACE = '(?:&nbsp;|\\s)';
  const VER = 'v?([0-9]+(?:\\.[0-9]+)*)';
  const NODE = `\\bnode(?:\\.?js)?\\b`;
  const patterns = [
    // Node >= 22.12 / Node.js ≥ 22.12 / node > 22.12
    new RegExp(`${NODE}${SPACE}*(?:≥|>=|>)${SPACE}*${VER}`, 'gi'),
    // Node v22.12+ / Node 22.12 or later
    new RegExp(`${NODE}${SPACE}*${VER}${SPACE}*(?:\\+|or${SPACE}+(?:later|newer|above))`, 'gi'),
    // Minimum Node: 22.12 / Minimum Node.js 22.12
    new RegExp(`\\bminimum${SPACE}+node(?:\\.?js)?${SPACE}*:?${SPACE}*${VER}`, 'gi'),
  ];
  const out = [];
  const seen = new Set();
  for (const re of patterns) {
    for (const m of text.matchAll(re)) {
      const key = `${m.index}:${m[1]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ raw: m[0].trim(), version: m[1] });
    }
  }
  return out;
}

/**
 * Every literal `node-version:` pin in a workflow, as `{ raw, version }`.
 *
 * Accepts a quoted value and tolerates a trailing comment — both defeated the first draft's `\s*$` anchor,
 * which meant `node-version: 20 # pinned for repro` was simply not a pin as far as the gate was concerned.
 * An expression pin (`${{ matrix.node }}`) is intentionally skipped: it carries no literal to judge, and the
 * matrix itself is asserted separately.
 */
function findPinnedNodeVersions(yaml) {
  return [
    ...yaml.matchAll(/node-version:[ \t]*(['"]?)([0-9]+(?:\.[0-9]+)*)\1[ \t]*(?:#.*)?$/gm),
  ].map((m) => ({ raw: m[0].trim(), version: m[2] }));
}

module.exports = { compareVersions, satisfiesFloor, findNodeFloorClaims, findPinnedNodeVersions };
