import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { LocalFsStorage, MemoryStorage } from '@/drivers/backends';

/** The two backends with no cloud have no lifecycle rules to break a store: both say `ok`, with no request to make. */

const root = mkdtempSync(join(tmpdir(), 'lifecycle-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('checkLifecycle on the backends without a cloud', () => {
  it('MemoryStorage is ok', async () => {
    const out = await new MemoryStorage().checkLifecycle();
    expect(out.status).toBe('ok');
    expect(out.detail).toMatch(/memory/);
  });

  it('LocalFsStorage is ok, and names no path', async () => {
    const out = await new LocalFsStorage(root).checkLifecycle();
    expect(out.status).toBe('ok');
    expect(out.detail).not.toContain(root);
  });
});
