/**
 * `connect(url)` — a working store from one string.
 *
 * Wiring was the largest first-use cost in the library, and it is entirely incidental. Reaching S3 meant four
 * imports and three constructors, with `bucket` and `prefix` repeated across two drivers — and repeating them
 * is not merely tedious, it is a hazard: mismatch the prefix and the registry points somewhere the cold driver
 * never writes, which looks like an empty store rather than a typo.
 *
 * ```ts
 * const store = await connect('s3://my-bitmaps/cloudroaring?region=us-east-1');
 * ```
 *
 * **The URL is the one everyone already types.** `s3://bucket/prefix` is the form used by the AWS CLI, s3fs,
 * DuckDB, Polars and Spark, so the scheme names the *protocol* rather than a vendor — which is also what lets
 * MinIO, Ceph and R2 work through the same scheme with an `endpoint`. Required things are in the path;
 * everything optional is a query parameter, because the SDK already resolves a region from `AWS_REGION`, the
 * shared profile, or instance metadata, and a parameter that is usually inferred should not look mandatory.
 *
 * **It is a shortcut, never the only door.** `connect` returns exactly the `CloudRoaring` the
 * constructors return — not a subset and not a wrapper — so anything a hand-wired store can do, a connected
 * one can too. The moment you need a client this cannot express (a shared credential provider, a proxy agent,
 * a custom retry strategy), construct the drivers yourself and pass them to `new CloudRoaring(...)`. That is a
 * documented step down, not a cliff, and the guide shows both.
 *
 * **Credentials are refused, not ignored.** They belong to the SDK's own resolution chain, and a URL is the
 * kind of string that ends up in a log, a crash report or a CI variable that outlives the secret. A URL
 * carrying them is rejected outright: silently dropping them would leave someone believing a key was in use
 * while the SDK quietly authenticated as somebody else. For the same reason nothing here echoes a URL back
 * verbatim — an error prints the scheme, host, path and the *names* of the query parameters, never a value.
 *
 * `async` is forced rather than chosen: the drivers are optional peer dependencies behind subpath exports, and
 * the main entry stays SDK-free, so the right subpath has to be `await import`ed. A synchronous `connect`
 * would pull every cloud SDK into every consumer's bundle.
 */
import { ValidationError, UnsupportedError } from '@cloudbitmaps/core';
import type { IColdDriver, IRegistryDriver } from '@cloudbitmaps/core';

/** The schemes {@link resolveWiring} understands. */
const SCHEMES = ['s3:', 'gs:', 'az:', 'file:', 'memory:'] as const;

/**
 * The query parameters each scheme understands. A parameter that does not apply is a typo or a
 * misunderstanding, and either way ignoring it silently produces a store wired differently from the one the
 * caller described — `?pathstyle=true` against MinIO reaches for a virtual-host bucket that does not exist.
 */
const PARAMS: Readonly<Record<string, readonly string[]>> = {
  's3:': ['region', 'endpoint', 'pathStyle', 'table'],
  'gs:': ['region', 'table'],
  'az:': ['region', 'table'],
  'file:': [],
  'memory:': [],
};

/** The driver pair a URL resolves to. */
export interface Wiring {
  readonly cold: IColdDriver;
  readonly registry: IRegistryDriver;
}

/**
 * The URL as it is safe to put in an error: userinfo dropped, and query parameters reduced to their names.
 *
 * An error message is the single most likely place for a URL to be copied into a bug report, and a value in
 * it may be a secret someone pasted despite the rule above. Whatever a caller actually needs to see — the
 * bad flag, the unknown parameter — the sentence names explicitly, so nothing is lost by withholding the rest.
 */
function safeUrl(url: URL | string): string {
  if (typeof url === 'string') {
    // The unparseable case: there is no structure to rebuild from, so redact the two shapes positionally.
    return url.replace(/\/\/[^/@]*@/, '//\u2026@').replace(/([?&])([^=&]*)=[^&]*/g, '$1$2=\u2026');
  }
  const names = [...new Set(url.searchParams.keys())];
  const query = names.length === 0 ? '' : `?${names.map((n) => `${n}=\u2026`).join('&')}`;
  return `${url.protocol}//${url.host}${url.pathname}${query}`;
}

function fail(url: URL | string, why: string): never {
  throw new ValidationError(`connect: ${why}\n  url: ${safeUrl(url)}`);
}

/** Read a boolean query parameter, refusing anything that is not clearly one. */
function flag(u: URL, name: string): boolean | undefined {
  const raw = u.searchParams.get(name);
  if (raw === null) return undefined;
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  return fail(u, `\`${name}\` must be true or false; got ${JSON.stringify(raw)}`);
}

/** Percent-decoding that reports a bad escape as a URL problem rather than a bare `URIError`. */
function decodePath(raw: string, u: URL): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return fail(u, 'the path is not valid percent-encoding — a literal `%` is written `%25`');
  }
}

/**
 * The bucket/container, which is the URL's host.
 *
 * A port is refused rather than folded in: `s3://bucket:9000/p` is what someone reaching for MinIO writes,
 * and `host` would hand the SDK a bucket literally named `bucket:9000`. The address of an S3-compatible
 * store is `?endpoint=`, which is a different thing in a different place.
 */
function hostOf(u: URL, label: string, example: string): string {
  if (u.port !== '') {
    // Only `s3://` has somewhere else to put an address, so only it gets told where.
    const hint =
      u.protocol === 's3:'
        ? ` An S3-compatible store's address goes in \`?endpoint=\` — e.g. ` +
          `s3://${u.hostname}/prefix?endpoint=http://${u.hostname}:${u.port}&pathStyle=true`
        : '';
    fail(u, `a ${label} name has no port.${hint}`);
  }
  if (u.hostname === '') fail(u, `needs a ${label}: ${example}`);
  return u.hostname;
}

/**
 * The object-store prefix: the path, decoded, with the slashes that carry no meaning trimmed off.
 *
 * Decoding matters because the drivers take a literal key prefix, not a URL component: `s3://b/my prefix`
 * must reach the same objects as a hand-wired `prefix: 'my prefix'`, and `my%20prefix/` is a different place
 * in the bucket. Trimming matters because `s3://b/team` and `s3://b/team/` are the same store to anyone
 * reading them, and the key builders already normalize the object side — the registry key prefix has to
 * agree, or one spelling silently gets its own set of pointers.
 */
function prefixOf(u: URL): string | undefined {
  const decoded = decodePath(u.pathname, u).replace(/^\/+|\/+$/g, '');
  if (decoded === '') return undefined;
  for (const segment of decoded.split('/')) {
    // URL parsing resolves an unencoded `..` away before we ever see it; this catches the encoded spelling,
    // which arrives intact and would otherwise reach the drivers as a traversal attempt.
    if (segment === '.' || segment === '..') {
      fail(
        u,
        'a path segment cannot be "." or ".." — the prefix names a place, it does not navigate to one',
      );
    }
  }
  return decoded;
}

/** Refuse a query parameter the scheme has no use for, rather than wiring something other than what was asked. */
function checkParams(u: URL): void {
  const allowed = PARAMS[u.protocol] ?? [];
  for (const name of u.searchParams.keys()) {
    if (allowed.includes(name)) continue;
    fail(
      u,
      allowed.length === 0
        ? `${u.protocol}// takes no query parameters; got \`${name}\``
        : `\`${name}\` is not a ${u.protocol}// parameter. It takes ${allowed.join(', ')} ` +
            `(spelled exactly — they are case-sensitive)`,
    );
  }
}

/**
 * Resolve a storage URL to the driver pair a store needs.
 *
 * The public entry point is `connect` in the package barrel; this is the half that knows about URLs, kept
 * separate so it never has to import `CloudRoaring` — which would be an import cycle, and is exactly what the
 * architecture gate refused when the two lived together. **The schemes, the per-scheme query parameters and
 * the optional peer each needs are documented on `connect` itself**, because that is the symbol a consumer
 * can reach and the one whose doc comment ships in `index.d.ts`; `PARAMS` above is what the code obeys.
 *
 * **GCS and Azure have no object-store registry of their own**, so they need one named explicitly — today
 * that means `?table=<dynamodb-table>`, or wiring a registry by hand. The error says so rather than failing
 * at the first read.
 */
export async function resolveWiring(url: string): Promise<Wiring> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return fail(
      url,
      `not a URL — it needs a scheme and \`://\`, as in s3://bucket/prefix. Expected one of ${SCHEMES.join(' ')}`,
    );
  }
  return wire(parsed);
}

async function wire(u: URL): Promise<Wiring> {
  // Everything checkable from the string alone is checked BEFORE any driver is imported, so a typo reports a
  // typo rather than an instruction to install a large SDK the caller may not even need. The scheme comes
  // first among those: every check below is scheme-specific, and reporting one of them for a scheme we do not
  // support at all would answer a question the caller did not ask.
  if (!(u.protocol in PARAMS)) {
    throw new UnsupportedError(
      `connect: unsupported scheme ${u.protocol}. Expected one of ${SCHEMES.join(' ')}\n  url: ${safeUrl(u)}`,
    );
  }
  if (u.username !== '' || u.password !== '') {
    fail(
      u,
      'credentials do not belong in a storage URL. The SDK resolves them itself (environment, shared ' +
        'profile, instance metadata, workload identity); if you need a specific credential, build the ' +
        'client yourself and pass the drivers to `new CloudRoaring({ cold, registry })`.',
    );
  }
  if (u.hash !== '') {
    fail(
      u,
      'a `#` starts a URL fragment, so everything after it is dropped rather than becoming part of the ' +
        'prefix. Write it `%23` if the prefix really contains one.',
    );
  }
  checkParams(u);

  switch (u.protocol) {
    case 'memory:': {
      if (u.host !== '' || (u.pathname !== '' && u.pathname !== '/')) {
        fail(
          u,
          'memory:// addresses nothing — it is an in-process store, so it takes no host or path',
        );
      }
      const { MemoryColdDriver, MemoryRegistryDriver } = await import('@cloudbitmaps/core');
      return { cold: new MemoryColdDriver(), registry: new MemoryRegistryDriver() };
    }

    case 'file:': {
      // `file:///var/lib/x` puts the path in `pathname` and leaves `host` empty. A non-empty host means a
      // two-slash URL (`file://var/lib/x`), where `var` would be silently dropped — refuse rather than guess.
      if (u.host !== '') {
        return fail(u, 'a file URL needs three slashes: file:///absolute/path');
      }
      if (u.pathname === '' || u.pathname === '/') return fail(u, 'file URL needs a path');
      // `fileURLToPath` rather than the pathname: on Windows `file:///C:/data` has pathname `/C:/data`, and
      // the leading slash makes it a different (invalid) path. It percent-decodes too, so this is also where
      // a bad escape surfaces.
      const { fileURLToPath } = await import('node:url');
      let root: string;
      try {
        root = fileURLToPath(u);
      } catch {
        return fail(
          u,
          'not a usable file path — check the percent-encoding (a literal `%` is written `%25`)',
        );
      }
      const { LocalFsColdDriver, LocalFsRegistryDriver } = await import('@cloudbitmaps/core');
      return { cold: new LocalFsColdDriver(root), registry: new LocalFsRegistryDriver(root) };
    }

    case 's3:': {
      const bucket = hostOf(u, 'bucket', 's3://bucket/prefix');
      const prefix = prefixOf(u);
      const endpoint = u.searchParams.get('endpoint') ?? undefined;
      const region = u.searchParams.get('region') ?? undefined;
      const pathStyle = flag(u, 'pathStyle');
      if (endpoint !== undefined && u.searchParams.get('table') !== null) {
        // `endpoint` is the address of an S3-compatible store; a DynamoDB registry pointed at the same
        // address is not talking to a DynamoDB. Left to itself the SDK would resolve the table against real
        // AWS instead — a store whose data and pointers live in different clouds, which reads as data loss.
        fail(
          u,
          "`endpoint` and `table` together are ambiguous: `endpoint` is the S3-compatible store's address, " +
            'and the DynamoDB registry would either be sent there or quietly resolve against AWS. Build the ' +
            'two clients yourself and pass the drivers to `new CloudRoaring({ cold, registry })`.',
        );
      }
      const { S3Client } = await loadOptional<typeof import('@aws-sdk/client-s3')>(
        '@aws-sdk/client-s3',
        's3://',
      );
      const client = new S3Client({
        ...(region === undefined ? {} : { region }),
        ...(endpoint === undefined ? {} : { endpoint }),
        ...(pathStyle === true ? { forcePathStyle: true } : {}),
      });
      const { S3ColdDriver, S3RegistryDriver } = await import('@cloudbitmaps/core/s3');
      const cold = new S3ColdDriver({
        client,
        bucket,
        ...(prefix === undefined ? {} : { prefix }),
      });
      const registry =
        (await dynamoRegistry(u, prefix)) ??
        new S3RegistryDriver({ client, bucket, ...(prefix === undefined ? {} : { prefix }) });
      return { cold, registry };
    }

    case 'gs:': {
      const bucket = hostOf(u, 'bucket', 'gs://bucket/prefix');
      const prefix = prefixOf(u);
      const { Storage } = await loadOptional<typeof import('@google-cloud/storage')>(
        '@google-cloud/storage',
        'gs://',
      );
      const { GcsColdDriver } = await import('@cloudbitmaps/core/gcs');
      const cold = new GcsColdDriver({
        storage: new Storage(),
        bucket,
        ...(prefix === undefined ? {} : { prefix }),
      });
      return { cold, registry: requireNamedRegistry(await dynamoRegistry(u, prefix), 'gs://', u) };
    }

    case 'az:': {
      const container = hostOf(u, 'container', 'az://container/prefix');
      const prefix = prefixOf(u);
      // The connection string comes from the environment, never the URL — same reason credentials never do.
      // `AZURE_STORAGE_CONNECTION_STRING` is the variable the Azure SDK and CLI already use, so this is the
      // value that is almost certainly already set rather than a name invented here.
      const conn = process.env['AZURE_STORAGE_CONNECTION_STRING'];
      if (conn === undefined || conn === '') {
        return fail(
          u,
          'az:// reads its credentials from AZURE_STORAGE_CONNECTION_STRING, which is unset. Set it, or build ' +
            'a ContainerClient yourself (any credential the Azure SDK supports) and pass the drivers to ' +
            '`new CloudRoaring({ cold, registry })`.',
        );
      }
      const { BlobServiceClient } = await loadOptional<typeof import('@azure/storage-blob')>(
        '@azure/storage-blob',
        'az://',
      );
      const { AzureBlobColdDriver } = await import('@cloudbitmaps/core/azure');
      const cold = new AzureBlobColdDriver({
        containerClient: BlobServiceClient.fromConnectionString(conn).getContainerClient(container),
        ...(prefix === undefined ? {} : { prefix }),
      });
      return { cold, registry: requireNamedRegistry(await dynamoRegistry(u, prefix), 'az://', u) };
    }

    /* c8 ignore next 6 -- unreachable: the scheme was checked against PARAMS above. It stays as the
       exhaustiveness guard for the day a scheme is added to PARAMS and not to the switch. */
    default:
      throw new UnsupportedError(
        `connect: unsupported scheme ${u.protocol}. Expected one of ${SCHEMES.join(' ')}\n  url: ${safeUrl(u)}`,
      );
  }
}

/**
 * `?table=` wires a DynamoDB registry; absent, the caller's scheme decides whether that is fatal.
 *
 * The URL's path scopes the registry exactly as it scopes the objects. Without that, `s3://bucket/tenantA`
 * and `s3://bucket/tenantB` sharing one table compute the *same* partition key for the same segment name:
 * two stores that look independent, silently overwriting each other's pointers.
 */
async function dynamoRegistry(
  u: URL,
  prefix: string | undefined,
): Promise<IRegistryDriver | undefined> {
  const table = u.searchParams.get('table');
  if (table === null) return undefined;
  if (table === '') return fail(u, '`table` must not be empty');
  // The prefix becomes the registry key prefix, where `|` and `#` are the key's own delimiters. The driver
  // refuses those itself; catching them here is what turns the refusal into a sentence about the URL.
  for (const ch of prefix ?? '') {
    if (ch === '|' || ch === '#' || ch.charCodeAt(0) < 0x20) {
      return fail(
        u,
        'the path becomes the registry key prefix, so it cannot contain `|`, `#` or control characters',
      );
    }
  }
  const { DynamoDBClient } = await loadOptional<typeof import('@aws-sdk/client-dynamodb')>(
    '@aws-sdk/client-dynamodb',
    '?table=',
  );
  const region = u.searchParams.get('region') ?? undefined;
  const { DynamoDbRegistryDriver } = await import('@cloudbitmaps/core/dynamodb');
  return new DynamoDbRegistryDriver({
    client: new DynamoDBClient(region === undefined ? {} : { region }),
    tableName: table,
    ...(prefix === undefined ? {} : { keyPrefix: prefix }),
  });
}

function requireNamedRegistry(
  registry: IRegistryDriver | undefined,
  scheme: string,
  u: URL,
): IRegistryDriver {
  if (registry !== undefined) return registry;
  return fail(
    u,
    `${scheme} has no registry of its own — a registry resolves which generation is current, and only S3 and ` +
      `the local filesystem can host one in the same place as the data. Add \`?table=<dynamodb-table>\`, or ` +
      `construct the drivers yourself and pass them to \`new CloudRoaring({ cold, registry })\`.`,
  );
}

/**
 * Was this failure the package's own absence, rather than a fault inside it?
 *
 * Exported for its tests, not for consumers — the package barrel does not re-export it. It needs testing
 * because it is a judgement about another runtime's error objects, and getting it wrong is silent in both
 * directions: too loose and a broken install is reported as "not installed", sending someone to reinstall
 * what they already have; too strict and the friendly instruction never appears.
 *
 * It walks the `cause` chain because a dynamic import's rejection rarely arrives bare — a loader hook, a
 * bundler runtime or a test runner wraps it, leaving its own text in `message` and Node's error in `cause`.
 * Reading only the top-level message misses every one of those.
 *
 * @internal
 */
export function isPackageMissing(err: unknown, pkg: string): boolean {
  const MODULE_NOT_FOUND = new Set(['ERR_MODULE_NOT_FOUND', 'MODULE_NOT_FOUND']);
  // Bounded: a `cause` chain can be cyclic, and this runs on an error path where a hang is worse than a miss.
  for (let e: unknown = err, depth = 0; e !== null && e !== undefined && depth < 8; depth++) {
    const { code, message } = e as { code?: unknown; message?: unknown };
    if (MODULE_NOT_FOUND.has(String(code))) {
      const named = /Cannot find (?:package|module) ['"]([^'"]+)['"]/.exec(String(message ?? ''));
      // A named specifier that is NOT ours means the package is installed and something inside it is not:
      // a different fault, and "run npm i <pkg>" points away from it. Unnamed (a reworded message from
      // another Node version) still counts — the code already says module-not-found, and the specifier we
      // asked for is the likeliest subject.
      return named === null || named[1] === pkg;
    }
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Import an optional peer, turning a missing package into an instruction rather than a module-not-found.
 *
 * `load` is a seam, not a parameter anyone passes: every one of these SDKs is installed in this workspace, so
 * the catch below is unreachable from a test that imports for real, and the instruction it produces — the
 * thing a user actually sees when a peer is missing — would ship unverified. @internal
 */
export async function loadOptional<T>(
  pkg: string,
  forWhat: string,
  load: (specifier: string) => Promise<unknown> = (specifier) =>
    import(/* @vite-ignore */ specifier),
): Promise<T> {
  try {
    return (await load(pkg)) as T;
  } catch (err) {
    if (!isPackageMissing(err, pkg)) throw err;
    throw new UnsupportedError(
      `connect: ${forWhat} needs the optional peer \`${pkg}\`, which is not installed. Run ` +
        `\`npm i ${pkg}\` — the SDKs are optional peers so you only install the backends you actually use.`,
    );
  }
}
