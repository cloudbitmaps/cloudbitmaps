import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TransientError } from '@/core/errors';
import { publishGenerationKept } from '@/core/publish';
import type { SegmentRef } from '@/core/ports';
import { LocalFsRegistryDriver } from '@/drivers/localfs/registry';

/** The next read-only open of a registry row file under `under` fails once with `EMFILE`. */
const fault = vi.hoisted(() => ({ armed: false, under: '', fired: 0 }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  const open = async (path: unknown, flags?: unknown, mode?: unknown) => {
    if (
      fault.armed &&
      typeof path === 'string' &&
      path.startsWith(fault.under) &&
      path.endsWith('.reg') &&
      typeof flags === 'number' &&
      (flags & 3) === 0
    ) {
      fault.armed = false;
      fault.fired += 1;
      throw Object.assign(new Error('EMFILE: too many open files'), { code: 'EMFILE' });
    }
    return (real.open as (...a: unknown[]) => unknown)(path, flags, mode);
  };
  return { ...real, default: { ...real, open }, open };
});

const REF: SegmentRef = { namespace: 'ns', segment: 's' };

describe('a read fault inside the local-files registry before it reports its token', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'cbm-read-fault-'));
    fault.under = root;
    fault.fired = 0;
  });
  afterEach(async () => {
    fault.armed = false;
    await rm(root, { recursive: true, force: true });
  });

  it("is the read's own fault on the first attempt: nothing was sent, so no write has no answer", async () => {
    const registry = new LocalFsRegistryDriver(root, { now: () => 1_000 });
    await registry.create(REF, { currentGen: 0 });
    const row = (await registry.get(REF))!;
    fault.armed = true; // the read inside the compare-and-swap's lock
    let unanswered = 0;
    const err = await publishGenerationKept(
      registry,
      { ...REF, generation: 1 },
      {
        row,
        expectToken: row.token,
        expectRow: row,
        footerCrc: 1,
        onUnanswered: () => void (unanswered += 1),
      },
    ).catch((e: unknown) => e);
    expect(fault.fired).toBe(1);
    expect(err).toBeInstanceOf(TransientError);
    expect((err as Error).message).toContain('EMFILE');
    expect(unanswered).toBe(0);
    expect((await registry.get(REF))!.currentGen).toBe(0); // nothing was written
  });
});
