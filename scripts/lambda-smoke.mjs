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
  for (const name of [
    'CloudRoaring',
    'estimateCost',
    'MemoryStorageDriver',
    'MemoryRegistryDriver',
    'MemoryStorageChunkSource',
    'bulkLoadCrbmGeneration',
  ]) {
    if (m[name] == null) throw new Error(`${label}: missing export ${name}`);
  }
  // Data enters a loaded store only as a published generation, so the round-trip IS the load: encode the ids
  // into one immutable `.crbm`, publish it, then read it back. The two ids sit in different 16-bit chunks, so
  // chunk routing and the native bitmap both run rather than a single-container no-op.
  // A BACKEND, which is what the docs tell users to build. This wired a raw driver plus a `registry` option,
  // and that option stopped existing when the backend class landed — so the pointer path it meant to exercise
  // had been silently dead here ever since, while the round-trip kept passing because a store with one
  // generation list-scans to the same answer. Plain ESM run inside a container: no compiler was going to say.
  const backend = new m.MemoryStorage({ now: () => 0 });
  await m.bulkLoadCrbmGeneration(
    backend.storage,
    { segment: 'lambda-smoke', generation: 0 },
    [42, 70_000],
    { registry: backend.registry },
  );
  const seg = new m.CloudRoaring({ storage: backend }).segment('lambda-smoke');
  const ok =
    (await seg.has(42)) &&
    (await seg.has(70_000)) &&
    !(await seg.has(1)) &&
    (await seg.count()) === 2;
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
