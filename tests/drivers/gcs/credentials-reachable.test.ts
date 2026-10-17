import { inspect } from 'node:util';
import type { Storage } from '@google-cloud/storage';
import {
  isNotFoundError,
  isTransientError,
  isValidationError,
  isWriteConflictError,
} from '@cloudbitmaps/core/driver-kit';
import { GcsRegistryDriver, GcsRegistryStore } from '@/gcs/registry';
import { scrubCredentials } from '@/gcs/scrub-error';
import { GcsStorageDriver } from '@/gcs/storage';
import {
  ACCESS_TOKEN,
  ANSWERS,
  CLIENT_SECRET,
  CREDENTIAL_KINDS,
  PLANTED_SECRETS,
  REFRESH_TOKEN,
  SELF_SIGNED_JWT,
  TOKEN_ANSWERS,
  clientFor,
  guardLoopback,
  isolateGoogleEnv,
  startLoopback,
  type Answer,
} from '../../helpers/gcs-error-answers';

/**
 * An error the GCS driver throws carries no credential in anything code can reach, not only in what a logger prints.
 * The SDK keeps the response it got on the error, and through it the request it sent, with the bearer token in its
 * `Authorization` header, and the HTTP agent it shares with every other call; a resumable upload's error keeps the
 * request's `config`. On a download, and wherever a body lists no errors, the body becomes the message, so a proxy's
 * page or a JSON body that quotes the request puts the token in the message and the stack. Every call the driver makes
 * gets every answer in `ANSWERS` from a loopback server, with each kind of credential; the error it throws is walked
 * (own properties of every kind, getters read, map and set entries, prototypes, the `cause` chain) and printed every
 * way code prints one (`util.inspect` with hidden properties, `JSON.stringify`, `String`, `stack`, `structuredClone`).
 * The class the driver raises is checked too: it is the one it raised before the scrubber was rebuilt.
 */
const GEN = { segment: 's', generation: 1 };
const LIMIT = { timeout: 60_000 };

/** What the driver throws, in the vocabulary its callers act on; `sdk` for the SDK's own error, passed on. */
type Kind = 'none' | 'sdk' | 'transient' | 'validation' | 'notFound' | 'conflict';
const kindOf = (err: unknown): Kind | 'other' =>
  err === undefined
    ? 'none'
    : isTransientError(err)
      ? 'transient'
      : isValidationError(err)
        ? 'validation'
        : isNotFoundError(err)
          ? 'notFound'
          : isWriteConflictError(err)
            ? 'conflict'
            : err instanceof Error
              ? 'sdk'
              : 'other';

const sleepless = { sleep: async (): Promise<void> => {} };
const storage = (s: Storage, extra: Record<string, unknown> = {}): GcsStorageDriver =>
  new GcsStorageDriver({ storage: s, bucket: 'b', clock: sleepless, ...extra });
const drain = async (items: AsyncIterable<unknown>): Promise<void> => {
  for await (const item of items) void item;
};
const store = (s: Storage): GcsRegistryStore => new GcsRegistryStore(s, s, 'b', 0, false);
const registry = (s: Storage): GcsRegistryDriver =>
  new GcsRegistryDriver({ storage: s, bucket: 'b' });

const READS = ['storage read', 'storage tail', 'storage head'];
const CALLS: Record<string, (s: Storage) => Promise<unknown>> = {
  'storage read': (s) => storage(s).getRange(GEN, 0, 8),
  'storage tail': (s) => storage(s).getTail(GEN, 8),
  'storage head': (s) => storage(s).getTail(GEN, 0),
  'storage write': (s) =>
    storage(s).putImmutable(GEN, async (sink) => {
      await sink.write(new Uint8Array([1, 2, 3]));
    }),
  'storage resumable write': (s) =>
    storage(s, { simpleUploadThresholdBytes: 4 }).putImmutable(GEN, async (sink) => {
      await sink.write(new Uint8Array(9));
    }),
  'storage delete': (s) => storage(s).delete(GEN),
  'storage delete under a version': (s) =>
    storage(s, { conditionalDelete: true }).delete(GEN, { ifVersion: '5' }),
  'storage list': (s) => drain(storage(s).list({ segment: 's' })),
  'registry read': (s) => registry(s).get({ segment: 's' }),
  'registry create': (s) => registry(s).create({ segment: 's' }, { currentGen: 0 }),
  'registry compare-and-swap write': (s) =>
    store(s).write('k', new Uint8Array([1]), { version: '5' }),
  'registry delete': (s) => store(s).delete('k', { version: '5' }),
  'registry listKeys': (s) => drain(store(s).listKeys('p')),
};

/** What each answer makes the driver throw: the same for every call unless the answer names the calls that differ. */
const EXPECTED: Record<string, [Kind, Record<string, Kind>?]> = {
  '401 Invalid Credentials': ['sdk'],
  '403 forbidden': ['sdk'],
  '404 no such object (the bucket listed)': [
    'sdk',
    {
      ...Object.fromEntries(READS.map((call) => [call, 'notFound'])),
      'storage delete': 'none',
      'storage delete under a version': 'none',
      'storage list': 'none',
      'registry read': 'none',
      'registry listKeys': 'none',
      'registry delete': 'conflict',
    },
  ],
  '404 no such bucket': ['validation'],
  '412 conditionNotMet': [
    'sdk',
    {
      'storage write': 'conflict',
      'storage resumable write': 'conflict',
      'registry compare-and-swap write': 'conflict',
      'registry delete': 'conflict',
    },
  ],
  '416 range not satisfiable': [
    'sdk',
    Object.fromEntries(READS.map((call) => [call, 'validation'])),
  ],
  '429 rateLimitExceeded': ['transient'],
  '500 backendError': ['transient'],
  '503 backendError': ['transient'],
  '502 proxy page quoting the request': ['transient'],
  '502 proxy page listing the request headers after a short heading': ['transient'],
  '502 proxy page listing the request headers under a caption': ['transient'],
  '502 proxy page listing the request headers as a definition list': ['transient'],
  '500 text body quoting the raw request': ['transient'],
  '400 JSON error quoting the request': ['sdk'],
  '400 JSON body quoting the request': ['sdk'],
  '403 XML SignatureDoesNotMatch quoting the request': ['sdk'],
  'reset connection': ['transient'],
};
const expectedFor = (call: string, answer: string): Kind => {
  const [all, some] = EXPECTED[answer] ?? ['sdk'];
  return some?.[call] ?? all;
};

/** Every string reachable from `root`, keys included, with a guard against cycles. */
function reachableStrings(root: unknown): string[] {
  const strings: string[] = [];
  const visited = new Set<unknown>();
  const visit = (value: unknown): void => {
    if (typeof value === 'string') {
      strings.push(value);
      return;
    }
    if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return;
    if (visited.has(value)) return;
    visited.add(value);
    if (value instanceof Map) {
      for (const [k, v] of value) {
        visit(k);
        visit(v);
      }
    } else if (value instanceof Set) {
      for (const v of value) visit(v);
    } else if (ArrayBuffer.isView(value)) {
      strings.push(
        Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString('latin1'),
      );
    }
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key === 'string') strings.push(key);
      let child: unknown;
      try {
        child = (value as Record<string | symbol, unknown>)[key];
      } catch {
        continue;
      }
      visit(child);
    }
    visit(Object.getPrototypeOf(value));
  };
  visit(root);
  return strings;
}

/** Every way code turns an error into text, or into another object it can read. */
function views(err: unknown): string[] {
  const json = (replacer?: string[]): string => {
    try {
      return JSON.stringify(err, replacer) ?? '';
    } catch {
      return '';
    }
  };
  const clone: unknown = structuredClone(err);
  return [
    inspect(err, { showHidden: true, depth: Infinity, getters: true }),
    json(),
    json(Object.getOwnPropertyNames(err as object)),
    String(err),
    String((err as { stack?: unknown }).stack),
    inspect(clone, { showHidden: true, depth: Infinity }),
    ...reachableStrings(clone),
    ...reachableStrings(err),
  ];
}

/** An error and the errors in its `cause` chain. */
function chain(err: unknown): object[] {
  const out: object[] = [];
  for (let e = err, i = 0; typeof e === 'object' && e !== null && i < 12; i++) {
    out.push(e);
    e = (e as { cause?: unknown }).cause;
  }
  return out;
}

const TRANSPORT = [
  'config',
  'request',
  'agent',
  'socket',
  '_httpMessage',
  'connection',
  'req',
  'res',
];

describe('GCS: no credential is reachable from an error the driver throws', LIMIT, () => {
  let answer: Answer | undefined;
  let token: Answer = TOKEN_ANSWERS.issued;
  let loop: Awaited<ReturnType<typeof startLoopback>>;
  let guard: ReturnType<typeof guardLoopback>;
  let restoreEnv: () => void;

  beforeAll(async () => {
    restoreEnv = isolateGoogleEnv();
    guard = guardLoopback();
    loop = await startLoopback(
      () => answer,
      () => token,
    );
  });
  afterAll(async () => {
    await loop.close();
    guard.restore();
    restoreEnv();
    // Nothing was sent anywhere but the loopback server.
    expect(guard.attempts).toEqual([]);
  });
  beforeEach(() => {
    loop.seen.clear();
    token = TOKEN_ANSWERS.issued;
  });

  /** The credentials the requests carried, and the ones a client holds: none may be reachable from the error. */
  const secretsIn = (text: string): string[] =>
    [
      ACCESS_TOKEN,
      SELF_SIGNED_JWT,
      SELF_SIGNED_JWT.split('.')[2] ?? SELF_SIGNED_JWT,
      REFRESH_TOKEN,
      CLIENT_SECRET,
      ...PLANTED_SECRETS,
      ...[...loop.seen].flatMap((value) => [value, value.replace(/^Bearer /, '')]),
    ].filter((secret) => text.includes(secret));

  describe.each(CREDENTIAL_KINDS)('%s', (kind) => {
    const cases = Object.keys(CALLS).flatMap((call) =>
      Object.keys(ANSWERS).map((name) => ({ call, name, expected: expectedFor(call, name) })),
    );

    it.each(cases)('$call, $name', async ({ call, name, expected }) => {
      answer = ANSWERS[name];
      let err: unknown;
      try {
        await CALLS[call]?.(clientFor(kind, loop.url));
      } catch (error) {
        err = error;
      }
      expect(kindOf(err)).toBe(expected);
      // The SDK sends a resumable upload's own requests to a custom endpoint, as this server is, with no credential.
      if (call !== 'storage resumable write') expect(loop.seen.size).toBeGreaterThan(0);
      expectNoCredential(err);
    });
  });

  it.each(Object.keys(CALLS))(
    '%s, a refresh the token endpoint refuses, quoting the refresh token and client secret',
    async (call) => {
      answer = ANSWERS['503 backendError'];
      token = TOKEN_ANSWERS['refused, quoting the request'];
      let err: unknown;
      try {
        await CALLS[call]?.(clientFor('refresh token', loop.url));
      } catch (error) {
        err = error;
      }
      // Every request but the resumable upload's waits on the refresh, and fails with it.
      expect(kindOf(err)).toBe(call === 'storage resumable write' ? 'transient' : 'sdk');
      expectNoCredential(err);
    },
  );

  function expectNoCredential(err: unknown): void {
    if (err === undefined) return;
    for (const e of chain(err)) {
      for (const key of TRANSPORT) expect(Object.getOwnPropertyNames(e)).not.toContain(key);
      const response = (e as { response?: unknown }).response;
      if (response !== undefined) {
        expect(Object.getPrototypeOf(response)).toBe(Object.prototype);
        for (const value of Object.values(response as object)) {
          expect(['number', 'string']).toContain(typeof value);
        }
      }
    }
    for (const text of views(err)) expect(secretsIn(text)).toEqual([]);
  }

  it('the walk reaches the credentials the SDK keeps, and none once scrubbed, inside an AggregateError too', async () => {
    answer = ANSWERS['502 proxy page quoting the request'];
    const client = clientFor('access token', loop.url);
    let raw: unknown;
    try {
      await client.bucket('b').getFiles({ prefix: 'p' });
    } catch (error) {
      raw = error;
    }
    expect(reachableStrings(raw).some((text) => secretsIn(text).length > 0)).toBe(true);
    const out = scrubCredentials(new AggregateError([new Error('first'), raw], 'many'));
    for (const text of views(out)) expect(secretsIn(text)).toEqual([]);
    expect((out.errors[1] as { code?: unknown }).code).toBe(502);
  });
});
