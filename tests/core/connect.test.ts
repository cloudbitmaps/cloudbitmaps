import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from '@/index';
import { ValidationError, UnsupportedError } from '@/core/errors';
import { resolveWiring } from '@/connect';

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

// ─── What the URL actually wires ────────────────────────────────────────────────────────────────────────
// The tests above are about errors. These are about the opposite failure, the one a green suite hides: a URL
// that resolves happily to the WRONG place. Both were real — an adversarial review found them — and neither
// is observable from `connect`'s return value, so they are checked where they are decided, at the seam that
// turns a URL into drivers. Each stubs the SDK client's `send` and reads the key the driver would have used.

/** Swap in a `send` that records the command and answers "not there", so one read reveals one key. */
function captureSend(driver: unknown, notFound?: () => never): unknown[] {
  const captured: unknown[] = [];
  const client = (driver as { client: { send: (c: unknown) => Promise<unknown> } }).client;
  client.send = async (command: unknown): Promise<unknown> => {
    captured.push(command);
    if (notFound !== undefined) notFound();
    return {};
  };
  return captured;
}

const keyOf = (command: unknown): unknown => (command as { input: Record<string, unknown> }).input;

const noSuchKey = (): never => {
  throw Object.assign(new Error('missing'), { name: 'NoSuchKey' });
};

describe('connect: the wiring a URL resolves to', () => {
  it('scopes a shared DynamoDB registry by the path, so two tenants are two stores', async () => {
    // `?table=` used to ignore the path entirely: s3://bucket/tenantA and s3://bucket/tenantB computed the
    // SAME partition key for the same segment name, one silently overwriting the other's pointer. Nothing in
    // either store would look wrong — which is what makes it worth a test rather than a comment.
    const pkFor = async (url: string): Promise<string> => {
      const { registry } = await resolveWiring(url);
      const captured = captureSend(registry);
      await registry.get({ segment: 'users' });
      const key = (keyOf(captured[0]) as { Key: { PK: { S: string } } }).Key;
      return key.PK.S;
    };
    const a = await pkFor('s3://bucket/tenantA?table=cbm&region=us-east-1');
    const b = await pkFor('s3://bucket/tenantB?table=cbm&region=us-east-1');
    expect(a).not.toBe(b);
    expect(a).toContain('tenantA');
    expect(b).toContain('tenantB');
  });

  it('treats a trailing slash as the same store, on both sides of the wiring', async () => {
    // The object side normalizes `team` and `team/` to one prefix. If the registry key prefix did not agree,
    // the two spellings would share their data and split their pointers.
    const pkFor = async (url: string): Promise<string> => {
      const { registry } = await resolveWiring(url);
      const captured = captureSend(registry);
      await registry.get({ segment: 'users' });
      return (keyOf(captured[0]) as { Key: { PK: { S: string } } }).Key.PK.S;
    };
    expect(await pkFor('s3://bucket/team?table=cbm')).toBe(
      await pkFor('s3://bucket/team/?table=cbm'),
    );
  });

  it('gives the drivers the decoded prefix — the key, not the URL component', async () => {
    // A prefix reaches the driver as a literal object key. Handing it `my%20prefix` would put the data
    // somewhere a hand-wired `prefix: 'my prefix'` never looks — the same bucket, a different place in it.
    const { registry } = await resolveWiring('s3://bucket/my prefix');
    const captured = captureSend(registry, noSuchKey);
    expect(await registry.get({ segment: 'users' })).toBeNull();
    const key = (keyOf(captured[0]) as { Key: string }).Key;
    expect(key).toBe('my prefix/registry/_default/users.reg');
  });
});

describe('connect: refusing what it cannot honour', () => {
  it('rejects credentials in the URL rather than silently ignoring them', async () => {
    // Silently dropping them is the dangerous half: the caller believes that key is in use while the SDK
    // authenticates as somebody else entirely.
    await expect(connect('s3://AKIAEXAMPLE:secret@bucket/x')).rejects.toThrow(
      /credentials do not belong/,
    );
  });

  it('keeps secrets and values out of the error it throws', async () => {
    // An error message is the most likely place for a URL to be copied into a bug report.
    const err = await connect('s3://AKIAEXAMPLE:supersecret@bucket/x').catch((e: unknown) => e);
    expect(String(err)).not.toContain('supersecret');
    expect(String(err)).not.toContain('AKIAEXAMPLE');
    const flagErr = await connect('s3://bucket/x?pathStyle=yes&region=us-east-1').catch(
      (e: unknown) => e,
    );
    // The offending value is named by the sentence; the echoed URL carries parameter NAMES only.
    expect(String(flagErr)).toContain('"yes"');
    expect(String(flagErr)).not.toContain('region=us-east-1');
  });

  it('refuses an unknown or inapplicable query parameter instead of ignoring it', async () => {
    await expect(connect('s3://bucket/x?pathstyle=true')).rejects.toThrow(
      /is not a s3:\/\/ parameter/,
    );
    await expect(connect('file:///tmp/x?table=cbm')).rejects.toThrow(/takes no query parameters/);
    await expect(connect('memory://?region=us-east-1')).rejects.toThrow(
      /takes no query parameters/,
    );
  });

  it('refuses a host:port instead of reading it as a bucket name', async () => {
    // What someone reaching for MinIO writes. `host` would hand the SDK a bucket named `bucket:9000`.
    await expect(connect('s3://bucket:9000/p')).rejects.toThrow(/has no port/);
    await expect(connect('s3://bucket:9000/p')).rejects.toThrow(/endpoint=/);
  });

  it('refuses `endpoint` together with `table`, which would split a store across two clouds', async () => {
    // `endpoint` is the S3-compatible store's address; the DynamoDB registry cannot live there, so it would
    // quietly resolve against real AWS instead — data in MinIO, pointers in us-east-1.
    await expect(connect('s3://bucket/p?endpoint=http://localhost:9000&table=cbm')).rejects.toThrow(
      /ambiguous/,
    );
  });

  it('refuses a fragment rather than silently truncating the prefix', async () => {
    await expect(connect('s3://bucket/a#b')).rejects.toThrow(/fragment/);
  });

  it('refuses a traversal that only appears once the path is decoded', async () => {
    // URL parsing resolves away every spelling of a dot segment it recognizes — `..`, `%2E%2E`, `.%2E` all
    // collapse before we see them. `%2F` is the one it leaves alone, so `..%2F..` arrives intact and becomes
    // `../..` at the moment we decode it. The check has to run after the decode, which is where it runs.
    expect(new URL('s3://bucket/a/..%2F../c').pathname).toBe('/a/..%2F../c');
    await expect(connect('s3://bucket/a/..%2F../c')).rejects.toThrow(/cannot be "\." or "\.\."/);
  });

  it('reports bad percent-encoding as a URL problem, not a raw URIError', async () => {
    await expect(connect('file:///tmp/100%discount')).rejects.toBeInstanceOf(ValidationError);
    await expect(connect('s3://bucket/100%discount')).rejects.toThrow(/percent-encoding/);
  });

  it('refuses a memory:// URL that addresses something, since it addresses nothing', async () => {
    await expect(connect('memory://host/path')).rejects.toThrow(/takes no host or path/);
  });

  it('calls an unsupported scheme unsupported, not invalid', async () => {
    // The distinction a caller acts on: a typo is theirs to fix, an unsupported backend is ours.
    await expect(connect('redis://localhost')).rejects.toBeInstanceOf(UnsupportedError);
  });
});
