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
 * **It is a shortcut, never the only door.** `connect` returns exactly the {@link CloudRoaring} the
 * constructors return — not a subset and not a wrapper — so anything a hand-wired store can do, a connected
 * one can too. The moment you need a client this cannot express (a shared credential provider, a proxy agent,
 * a custom retry strategy), construct the drivers yourself and pass them to `new CloudRoaring(...)`. That is a
 * documented step down, not a cliff, and the guide shows both.
 *
 * **Credentials are deliberately not expressible.** They belong to the SDK's own resolution chain, and a URL
 * is the kind of string that ends up in a log, a crash report or a CI variable that outlives the secret.
 *
 * `async` is forced rather than chosen: the drivers are optional peer dependencies behind subpath exports, and
 * the main entry stays SDK-free, so the right subpath has to be `await import`ed. A synchronous `connect`
 * would pull every cloud SDK into every consumer's bundle.
 */
import { ValidationError, UnsupportedError } from '@cloudbitmaps/core';
import type { IColdDriver, IRegistryDriver } from '@cloudbitmaps/core';

/** The schemes {@link connect} understands. */
const SCHEMES = ['s3:', 'gs:', 'az:', 'file:', 'memory:'] as const;

/** The driver pair a URL resolves to. */
export interface Wiring {
  readonly cold: IColdDriver;
  readonly registry: IRegistryDriver;
}

function fail(url: string, why: string): never {
  throw new ValidationError(`connect: ${why}\n  url: ${url}`);
}

/** Read a boolean query parameter, refusing anything that is not clearly one. */
function flag(params: URLSearchParams, name: string, url: string): boolean | undefined {
  const raw = params.get(name);
  if (raw === null) return undefined;
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  return fail(url, `\`${name}\` must be true or false; got ${JSON.stringify(raw)}`);
}

/**
 * Resolve a storage URL to the driver pair a store needs.
 *
 * The public entry point is `connect` in the package barrel; this is the half that knows about URLs, kept
 * separate so it never has to import `CloudRoaring` — which would be an import cycle, and is exactly what the
 * architecture gate refused when the two lived together.
 *
 * | scheme | example | needs |
 * | --- | --- | --- |
 * | `s3://` | `s3://bucket/prefix?region=us-east-1` | `@aws-sdk/client-s3` |
 * | `gs://` | `gs://bucket/prefix` | `@google-cloud/storage` + a registry (see below) |
 * | `az://` | `az://container/prefix` | `@azure/storage-blob`, `AZURE_STORAGE_CONNECTION_STRING`, + a registry |
 * | `file://` | `file:///var/lib/cloudbitmaps` | nothing |
 * | `memory://` | `memory://` | nothing — for tests |
 *
 * Query parameters, all optional: `region`, `endpoint` and `pathStyle` (S3-compatible stores such as MinIO,
 * Ceph and R2), and `table` (a DynamoDB registry instead of the object-store one).
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
    return fail(url, `not a URL. Expected one of ${SCHEMES.join(' ')}`);
  }
  return wire(parsed, url);
}

async function wire(u: URL, url: string): Promise<Wiring> {
  const q = u.searchParams;
  // `pathname` keeps a leading slash and may be empty; the prefix is what follows the bucket.
  const prefix = u.pathname.replace(/^\/+/, '') || undefined;

  switch (u.protocol) {
    case 'memory:': {
      const { MemoryColdDriver, MemoryRegistryDriver } = await import('@cloudbitmaps/core');
      return { cold: new MemoryColdDriver(), registry: new MemoryRegistryDriver() };
    }

    case 'file:': {
      // `file:///var/lib/x` puts the path in `pathname` and leaves `host` empty. A non-empty host means a
      // two-slash URL (`file://var/lib/x`), where `var` would be silently dropped — refuse rather than guess.
      if (u.host !== '') {
        return fail(url, 'a file URL needs three slashes: file:///absolute/path');
      }
      const root = decodeURIComponent(u.pathname);
      if (root === '' || root === '/') return fail(url, 'file URL needs a path');
      const { LocalFsColdDriver, LocalFsRegistryDriver } = await import('@cloudbitmaps/core');
      return { cold: new LocalFsColdDriver(root), registry: new LocalFsRegistryDriver(root) };
    }

    case 's3:': {
      const bucket = u.host;
      if (bucket === '') return fail(url, 'an s3 URL needs a bucket: s3://bucket/prefix');
      const { S3Client } = await loadOptional<typeof import('@aws-sdk/client-s3')>(
        '@aws-sdk/client-s3',
        's3://',
      );
      const endpoint = q.get('endpoint') ?? undefined;
      const region = q.get('region') ?? undefined;
      const client = new S3Client({
        ...(region === undefined ? {} : { region }),
        ...(endpoint === undefined ? {} : { endpoint }),
        ...(flag(q, 'pathStyle', url) === true ? { forcePathStyle: true } : {}),
      });
      const { S3ColdDriver, S3RegistryDriver } = await import('@cloudbitmaps/core/s3');
      const cold = new S3ColdDriver({
        client,
        bucket,
        ...(prefix === undefined ? {} : { prefix }),
      });
      const registry =
        (await dynamoRegistry(q, url)) ??
        new S3RegistryDriver({ client, bucket, ...(prefix === undefined ? {} : { prefix }) });
      return { cold, registry };
    }

    case 'gs:': {
      const bucket = u.host;
      if (bucket === '') return fail(url, 'a gs URL needs a bucket: gs://bucket/prefix');
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
      return { cold, registry: requireNamedRegistry(await dynamoRegistry(q, url), 'gs://', url) };
    }

    case 'az:': {
      const container = u.host;
      if (container === '') return fail(url, 'an az URL needs a container: az://container/prefix');
      // The connection string comes from the environment, never the URL — same reason credentials never do.
      // `AZURE_STORAGE_CONNECTION_STRING` is the variable the Azure SDK and CLI already use, so this is the
      // value that is almost certainly already set rather than a name invented here.
      const conn = process.env['AZURE_STORAGE_CONNECTION_STRING'];
      if (conn === undefined || conn === '') {
        return fail(
          url,
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
      return { cold, registry: requireNamedRegistry(await dynamoRegistry(q, url), 'az://', url) };
    }

    default:
      return fail(url, `unsupported scheme ${u.protocol}. Expected one of ${SCHEMES.join(' ')}`);
  }
}

/** `?table=` wires a DynamoDB registry; absent, the caller's scheme decides whether that is fatal. */
async function dynamoRegistry(
  q: URLSearchParams,
  url: string,
): Promise<IRegistryDriver | undefined> {
  const table = q.get('table');
  if (table === null) return undefined;
  if (table === '') return fail(url, '`table` must not be empty');
  const { DynamoDBClient } = await loadOptional<typeof import('@aws-sdk/client-dynamodb')>(
    '@aws-sdk/client-dynamodb',
    '?table=',
  );
  const region = q.get('region') ?? undefined;
  const { DynamoDbRegistryDriver } = await import('@cloudbitmaps/core/dynamodb');
  return new DynamoDbRegistryDriver({
    client: new DynamoDBClient(region === undefined ? {} : { region }),
    tableName: table,
  });
}

function requireNamedRegistry(
  registry: IRegistryDriver | undefined,
  scheme: string,
  url: string,
): IRegistryDriver {
  if (registry !== undefined) return registry;
  return fail(
    url,
    `${scheme} has no registry of its own — a registry resolves which generation is current, and only S3 and ` +
      `the local filesystem can host one in the same place as the data. Add \`?table=<dynamodb-table>\`, or ` +
      `construct the drivers yourself and pass them to \`new CloudRoaring({ cold, registry })\`.`,
  );
}

/** Import an optional peer, turning a missing package into an instruction rather than a module-not-found. */
async function loadOptional<T>(pkg: string, forWhat: string): Promise<T> {
  try {
    return (await import(/* @vite-ignore */ pkg)) as T;
  } catch {
    throw new UnsupportedError(
      `connect: ${forWhat} needs the optional peer \`${pkg}\`, which is not installed. Run ` +
        `\`npm i ${pkg}\` — the SDKs are optional peers so you only install the backends you actually use.`,
    );
  }
}
