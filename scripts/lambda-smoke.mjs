/*
 * Lambda / Amazon-Linux deployability smoke: the in-container half.
 *
 * Runs INSIDE an Amazon Linux 2023 (AWS Lambda `nodejs`) container against the packed library, unpacked into
 * `node_modules` by the orchestrator, to prove CloudRoaring loads on the flagship serverless target. The packages hold
 * no native code, so this verifies that no native addon is installed, then that the library loads and round-trips under
 * BOTH module systems. Not part of the unit suite (needs Docker), driven by `scripts/lambda-smoke.sh` (locally and in
 * CI).
 */
import { existsSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { URL, fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

/** Every file under `dir` whose name ends in `.node`: a compiled addon. */
function addons(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...addons(path));
    else if (entry.name.endsWith('.node')) found.push(path);
  }
  return found;
}

const modules = fileURLToPath(new URL('./node_modules', import.meta.url));
// The native `roaring` package is the dependency the flavor no longer has; its presence, or any addon, is a regression.
const traces = [
  ...addons(modules),
  ...(existsSync(join(modules, 'roaring')) ? [join(modules, 'roaring')] : []),
];
if (traces.length > 0) throw new Error(`a native addon is installed: ${traces.join(', ')}`);

async function exercise(label, m) {
  for (const name of ['CloudRoaring', 'MemoryStorage']) {
    if (m[name] == null) throw new Error(`${label}: missing export ${name}`);
  }
  // Data enters a loaded store only as a published generation, so the round-trip IS the load: encode the ids
  // into one immutable `.crbm`, publish it, then read it back. The two ids sit in different 16-bit chunks, so
  // chunk routing and the bitmap codec both run rather than a single-container no-op.
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
    (await seg.count()) === 2 &&
    (await seg.stat()).sizeBytes > 0;
  if (!ok) throw new Error(`${label}: round-trip returned a wrong result`);
  console.log(
    `  ${label}: loads + round-trips on ${process.platform}/${process.arch} (node ${process.versions.node})`,
  );
}

// The installed package is resolved by name → exercises the published `exports` map (import + require conditions).
await exercise('esm', await import('@cloudbitmaps/roaring'));
await exercise('cjs', require('@cloudbitmaps/roaring'));
console.log(
  'lambda-smoke: @cloudbitmaps/roaring is deployable to the Amazon Linux 2023 / AWS Lambda runtime',
);
