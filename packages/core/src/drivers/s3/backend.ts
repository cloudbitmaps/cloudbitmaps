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
 * `.registry` for anyone wiring something the facade does not cover.
 */
import { S3Client } from '@aws-sdk/client-s3';
import type { IRegistryDriver, IStorageDriver, StorageBackend } from '@/core/ports';
import { S3StorageDriver } from './storage';
import { S3RegistryDriver } from './registry';

export interface S3StorageOptions {
  /** Target bucket (must already exist). */
  readonly bucket: string;
  /** Optional key prefix under which everything lives — generations and the registry alike. */
  readonly prefix?: string;
  /** A constructed client. Supply one for a credential chain the SDK cannot infer; otherwise one is built. */
  readonly client?: S3Client;
  /** Region for the client built when `client` is absent. Falls back to the SDK's own resolution. */
  readonly region?: string;
  /** Endpoint for an S3-compatible store (MinIO, Ceph, R2). Ignored when `client` is supplied. */
  readonly endpoint?: string;
  /** Path-style addressing, which most S3-compatible stores require. Ignored when `client` is supplied. */
  readonly pathStyle?: boolean;
  /**
   * Static credentials, for the S3-compatible stores that issue them (MinIO, Ceph, R2).
   *
   * On AWS itself, leave this unset — the SDK's own chain (instance role, SSO, environment, profile) is what
   * you want, and hard-coding keys to reach it would be a downgrade. It exists because the alternative for a
   * MinIO user was to construct an `S3Client` purely to carry two strings, which is the ergonomics this class
   * is here to remove. Ignored when `client` is supplied.
   */
  readonly credentials?: {
    readonly accessKeyId: string;
    readonly secretAccessKey: string;
    readonly sessionToken?: string;
  };
  /** Injected clock for the registry's `createdAt`/`updatedAt`; defaults to `Date.now`. */
  readonly now?: () => number;
}

export class S3Storage implements StorageBackend {
  readonly storage: IStorageDriver;
  readonly registry: IRegistryDriver;
  /** The client both halves share — built here unless one was supplied. */
  readonly client: S3Client;

  constructor(options: S3StorageOptions) {
    this.client =
      options.client ??
      new S3Client({
        ...(options.region === undefined ? {} : { region: options.region }),
        ...(options.endpoint === undefined ? {} : { endpoint: options.endpoint }),
        ...(options.pathStyle === undefined ? {} : { forcePathStyle: options.pathStyle }),
        ...(options.credentials === undefined ? {} : { credentials: options.credentials }),
      });
    const shared = {
      client: this.client,
      bucket: options.bucket,
      ...(options.prefix === undefined ? {} : { prefix: options.prefix }),
    };
    this.storage = new S3StorageDriver(shared);
    this.registry = new S3RegistryDriver({
      ...shared,
      ...(options.now === undefined ? {} : { now: options.now }),
    });
  }
}
