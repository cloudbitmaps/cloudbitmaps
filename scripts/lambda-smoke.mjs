/*
 * Lambda / Amazon-Linux deployability smoke — the in-container half.
 *
 * Runs INSIDE an Amazon Linux 2023 (AWS Lambda `nodejs`) container against the packed-and-installed library,
 * to prove CloudRoaring deploys to the flagship serverless target. The native `roaring` dep ships no
 * linux-arm64 prebuilt for the current Lambda node runtimes, so it compiles for the target at install (the
 * orchestrator provisions a toolchain first); this verifies that build succeeds AND the addon loads + runs
 * under BOTH module systems. Not part of the unit suite (needs Docker + a toolchain) — driven by
 * `scripts/lambda-smoke.sh` (locally and in CI).
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

async function exercise(label, m) {
  for (const name of ['CloudRoaring', 'MemoryWarmDriver', 'MemoryColdChunkSource']) {
    if (m[name] == null) throw new Error(`${label}: missing export ${name}`);
  }
  const seg = new m.CloudRoaring({
    warm: new m.MemoryWarmDriver(),
    cold: new m.MemoryColdChunkSource(),
  }).segment('lambda-smoke');
  await seg.add(42);
  await seg.add(70_000); // a second 16-bit chunk → exercises routing + the native bitmap, not just a no-op
  const ok = (await seg.has(42)) && !(await seg.has(1)) && (await seg.count()) === 2;
  if (!ok) throw new Error(`${label}: roaring round-trip returned a wrong result`);
  console.log(
    `  ${label}: roaring loads + round-trips on ${process.platform}/${process.arch} (node ${process.versions.node})`,
  );
}

// The installed package is resolved by name → exercises the published `exports` map (import + require conditions).
await exercise('esm', await import('@cloudbitmaps/roaring'));
await exercise('cjs', require('@cloudbitmaps/roaring'));
console.log(
  'lambda-smoke: @cloudbitmaps/roaring is deployable to the Amazon Linux 2023 / AWS Lambda runtime',
);
