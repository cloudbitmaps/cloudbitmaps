/**
 * `S3Storage` — the S3 backend as one object: the generations and the pointer, in one bucket, stated once.
 *
 * Replaces two constructor calls that each repeated `client`, `bucket` and `prefix`. Repeating them is how
 * they come apart: point the registry at one prefix and the objects at another and the store answers *empty*
 * rather than *misconfigured*, which is the hardest kind of wrong answer to debug. Here the location is written
 * once and shared, so the mismatch cannot be expressed.
 *
 * **It will build a client for you**, which is the common case — `new S3Storage({ bucket })` picks up the
 * ambient credential chain and region exactly as the SDK would. Pass `client` instead when you need a
 * credential chain the SDK cannot infer (SSO, an assumed role, a custom retry strategy); pass `endpoint` +
 * `pathStyle` + `credentials` for an S3-compatible store (MinIO, Ceph, R2). Both halves stay reachable as `.storage` and
 * `.registry` for anyone wiring something the facade does not cover. `maxObjectBytes` and `partBytes` size the
 * multipart upload.
 */
import { STORAGE_BACKEND, ValidationError, brandAsBackend } from '@cloudbitmaps/core/driver-kit';
import type {
  IRegistryDriver,
  IStorageDriver,
  StorageBackend,
} from '@cloudbitmaps/core/driver-kit';
import { S3Client } from '@aws-sdk/client-s3';
import { S3StorageDriver } from './storage';
import { S3RegistryDriver } from './registry';

export interface S3StorageOptions {
  /** Target bucket (must already exist). */
  readonly bucket: string;
  /** Optional key prefix under which everything lives — generations and the registry alike. */
  readonly prefix?: string;
  /**
   * A constructed client. Supply one for a credential chain the SDK cannot infer; otherwise one is built. Its retry
   * applies to every request except the conditional writes, which are sent once whatever it is configured to do.
   */
  readonly client?: S3Client;
  /** Region for the client built when `client` is absent (refused beside `client`). Falls back to the SDK's own resolution. */
  readonly region?: string;
  /** Endpoint for an S3-compatible store (MinIO, Ceph, R2). Refused beside `client`, which carries its own. */
  readonly endpoint?: string;
  /** Path-style addressing, which most S3-compatible stores require. Refused beside `client`, which carries its own. */
  readonly pathStyle?: boolean;
  /**
   * Static credentials, for the S3-compatible stores that issue them (MinIO, Ceph, R2).
   *
   * On AWS itself, leave this unset — the SDK's own chain (instance role, SSO, environment, profile) is what
   * you want, and hard-coding keys to reach it would be a downgrade. It exists because the alternative for a
   * MinIO user was to construct an `S3Client` purely to carry two strings, which is the ergonomics this class
   * is here to remove. Refused beside `client`, which carries its own.
   */
  readonly credentials?: {
    readonly accessKeyId: string;
    readonly secretAccessKey: string;
    readonly sessionToken?: string;
  };
  /**
   * Largest object the backend will write and advertise. Default = `partBytes × 10,000` (≈ 80 GiB at the default
   * 8 MiB part) — the honest ceiling reachable within S3's 10,000-part limit. Set it higher and `partBytes`
   * auto-grows so 10,000 parts still cover it (raising peak write memory to ~one part); up to the 5 TiB S3 max.
   * Must be a positive safe integer.
   */
  readonly maxObjectBytes?: number;
  /** Multipart part size in bytes (default 8 MiB; a smaller value is raised to the S3 5 MiB minimum). Must be a
   * positive safe integer. Tunes peak write memory. */
  readonly partBytes?: number;
  /** Injected clock for the registry's `createdAt`/`updatedAt`; defaults to `Date.now`. */
  readonly now?: () => number;
}

/**
 * The keys `new S3Storage(options)` takes. Any other is refused by name rather than ignored: an ignored client or
 * endpoint key builds a client from ambient credentials against the **public** endpoint, and for a store pointed at
 * MinIO that is production traffic from a wiring typo.
 */
export const S3_STORAGE_OPTION_KEYS = [
  'bucket',
  'prefix',
  'client',
  'region',
  'endpoint',
  'pathStyle',
  'credentials',
  'maxObjectBytes',
  'partBytes',
  'now',
] as const;

/** The settings that build a client, which a supplied `client` already carries and so cannot be given beside. */
const CLIENT_SETTINGS = ['region', 'endpoint', 'pathStyle', 'credentials'] as const;

/** Refuse an options bag that is not an object, or that holds a key not in `keys`, naming each such key. */
function refuseUnknown(
  name: string,
  options: unknown,
  keys: readonly string[],
  hint: string,
): void {
  if (options === null || typeof options !== 'object') {
    throw new ValidationError(
      `${name} needs an options object — got ${options === null ? 'null' : typeof options}`,
    );
  }
  const unknown = Object.keys(options).filter((k) => !keys.includes(k));
  if (unknown.length > 0) {
    const list = (ks: readonly string[]): string => ks.map((k) => `\`${k}\``).join(', ');
    throw new ValidationError(
      `${name} does not take ${list(unknown)}. It takes ${list(keys)}; ${hint}.`,
    );
  }
}

export class S3Storage implements StorageBackend {
  /** Cross-bundle brand, stamped non-enumerably in the constructor so a spread cannot carry it. */
  declare readonly [STORAGE_BACKEND]: true;
  readonly storage: IStorageDriver;
  readonly registry: IRegistryDriver;
  /** The client both halves share — built here unless one was supplied. */
  readonly client: S3Client;

  constructor(options: S3StorageOptions) {
    refuseUnknown('S3Storage', options, S3_STORAGE_OPTION_KEYS, 'an S3 client goes in `client`');
    if (options.client !== undefined && options.client !== null) {
      // A supplied client already carries its region, endpoint, addressing style and credentials, so a setting
      // beside it is ignored, and ignoring it leaves the store talking to somewhere the caller did not mean:
      // an `endpoint` meant for MinIO, silently dropped, is production traffic from a client that was built
      // for AWS. Refuse instead of picking one.
      const ignored = CLIENT_SETTINGS.filter((k) => options[k] !== undefined);
      if (ignored.length > 0) {
        throw new ValidationError(
          `S3Storage takes \`client\` OR ${CLIENT_SETTINGS.map((k) => `\`${k}\``).join(' / ')}, not both — ` +
            `got \`client\` with ${ignored.map((k) => `\`${k}\``).join(', ')}; ` +
            'the `client` already carries them, so configure them on the client, or drop `client`',
        );
      }
      this.client = options.client;
    } else {
      this.client = new S3Client({
        ...(options.region === undefined ? {} : { region: options.region }),
        ...(options.endpoint === undefined ? {} : { endpoint: options.endpoint }),
        ...(options.pathStyle === undefined ? {} : { forcePathStyle: options.pathStyle }),
        ...(options.credentials === undefined ? {} : { credentials: options.credentials }),
      });
    }
    const shared = {
      client: this.client,
      bucket: options.bucket,
      ...(options.prefix === undefined ? {} : { prefix: options.prefix }),
    };
    this.storage = new S3StorageDriver({
      ...shared,
      ...(options.maxObjectBytes === undefined ? {} : { maxObjectBytes: options.maxObjectBytes }),
      ...(options.partBytes === undefined ? {} : { partBytes: options.partBytes }),
    });
    this.registry = new S3RegistryDriver({
      ...shared,
      ...(options.now === undefined ? {} : { now: options.now }),
    });
    brandAsBackend(this);
  }
}
