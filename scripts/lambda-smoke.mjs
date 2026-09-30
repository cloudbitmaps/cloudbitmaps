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
  ]) {
    if (m[name] == null) throw new Error(`${label}: missing export ${name}`);
  }
  // Data enters a loaded store only as a published generation, so the round-trip IS the load: encode the ids
  // into one immutable `.crbm`, publish it, then read it back. The two ids sit in different 16-bit chunks, so
  // chunk routing and the native bitmap both run rather than a single-container no-op.
  // A BACKEND, which is what the docs tell users to build, so the round-trip goes through the pointer. A raw
  // driver with no registry would leave the pointer path silently dead while the round-trip kept passing,
  // because a store with one generation list-scans to the same answer. Plain ESM run inside a container: no
  // compiler would say.
  const store = new m.CloudRoaring({ storage: new m.MemoryStorage({ now: () => 0 }) });
  await store.load({ segment: 'lambda-smoke' }, [42, 70_000]);
  const seg = store.segment('lambda-smoke');
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
