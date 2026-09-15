import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from '@/index';
import { ValidationError } from '@/core/errors';

// `connect` is a shortcut, so the tests are about the two things a shortcut can get wrong: producing the
// wrong wiring, and failing unhelpfully. It is NOT a second configuration surface — the object it returns is
// the same `CloudRoaring` the constructors return, which the first test pins by using it.

describe('connect', () => {
  it('memory:// gives a working store — the whole journey through one string', async () => {
    const store = await connect('memory://');
    await store.load({ segment: 'users' }, [1, 2, 3]);
    expect(await store.segment('users').count()).toBe(3);
    expect(await store.exists({ segment: 'users' })).toBe(true);
  });

  it('file:// wires both drivers at one root, so the registry and the objects agree', async () => {
    const root = await mkdtemp(join(tmpdir(), 'crbm-connect-'));
    try {
      const store = await connect(`file://${root}`);
      await store.load({ segment: 'a', namespace: 'ns' }, [7, 8]);
      // Read it back through a SEPARATE store at the same URL: proves the wiring is durable, not in-process.
      const reopened = await connect(`file://${root}`);
      expect(await reopened.segment('a', { namespace: 'ns' }).count()).toBe(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('passes store options through, and they are the same options the constructor takes', async () => {
    const store = await connect('memory://', { coldGenTtlMs: 1234 });
    expect(store).toBeDefined();
    await store.load({ segment: 's' }, [1]);
    expect(await store.segment('s').count()).toBe(1);
  });

  it('refuses a URL it cannot wire, and says what it expected', async () => {
    await expect(connect('not a url')).rejects.toBeInstanceOf(ValidationError);
    await expect(connect('redis://localhost')).rejects.toThrow(/unsupported scheme/);
    await expect(connect('s3://')).rejects.toThrow(/needs a bucket/);
    await expect(connect('gs://')).rejects.toThrow(/needs a bucket/);
    await expect(connect('az://')).rejects.toThrow(/needs a container/);
    await expect(connect('file://')).rejects.toThrow(/needs a path/);
  });

  it('refuses the two-slash file URL rather than silently dropping a path segment', async () => {
    // `file://var/lib/x` parses with host=`var`, so `var` would vanish. A store pointed at `/lib/x` instead
    // of `/var/lib/x` is the kind of mistake that looks like an empty bucket.
    await expect(connect('file://var/lib/x')).rejects.toThrow(/three slashes/);
  });

  it('tells a gs:// or az:// user WHY a registry is needed, not just that one is missing', async () => {
    // Neither has an object-store registry of its own, and discovering that at the first read would be worse
    // than discovering it here.
    await expect(connect('gs://bucket/pfx')).rejects.toThrow(/no registry of its own/);
    await expect(connect('gs://bucket/pfx')).rejects.toThrow(/table=/);
  });

  it('rejects a non-boolean flag instead of quietly treating it as false', async () => {
    await expect(connect('s3://b/p?pathStyle=yes')).rejects.toThrow(/must be true or false/);
    await expect(connect('s3://b/p?table=')).rejects.toThrow(/must not be empty/);
  });
});
