import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DeleteObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { isAwsS3Host, probeClient } from '@/s3/client-probe';
import { isolateAwsEnv, type IsolatedAwsEnv } from '../../helpers/aws-env';
import { sdkWithout } from '../../helpers/stub-s3-bucket';

/**
 * What a real `S3Client` would do with a request, found out without sending one.
 *
 * The registry's hard delete is safe only where S3 applies `If-Match` on a delete, and only if the SDK sends it. The
 * first is a fact about the host a request goes to, which the SDK decides: a constructor `endpoint`, but also
 * `AWS_ENDPOINT_URL_S3`, `AWS_ENDPOINT_URL` and an `endpoint_url` in the shared config file, which it reads only when
 * a request is built. The second is a fact about the SDK version: an SDK whose model lacks a member drops it from the
 * request without a word. So the probe builds the requests the registry will send, runs them through a second client
 * made from the first one's configuration, and reads them back before the signing step. The transport here is a
 * tripwire that fails the test if a request is ever handed to it, and the caller's own middleware, logger and
 * credential provider are counted, to show the probe does not run them.
 */

const BUCKET = 'a-bucket';
const credentials = { accessKeyId: 'stub', secretAccessKey: 'stub' };

let sent = 0;
const tripwire = {
  handle: (): Promise<never> => {
    sent += 1;
    return Promise.reject(new Error('a request left the machine'));
  },
  updateHttpClientConfig: (): void => {},
  httpHandlerConfigs: (): Record<string, never> => ({}),
};

const client = (options: ConstructorParameters<typeof S3Client>[0] = {}): S3Client =>
  new S3Client({ region: 'us-east-1', credentials, requestHandler: tripwire as never, ...options });

let env: IsolatedAwsEnv;
beforeEach(() => {
  sent = 0;
  env = isolateAwsEnv();
});
afterEach(() => {
  env.restore();
});

const hostOf = async (c: S3Client): Promise<string | undefined> =>
  (await probeClient(c, BUCKET))?.host;

describe('where a client sends a request to the bucket, by every way an endpoint is set', () => {
  it('AWS S3, with nothing set: the regional host, and the SDK sends the preconditions', async () => {
    const facts = await probeClient(client(), BUCKET);
    expect(facts).toEqual({
      host: `${BUCKET}.s3.us-east-1.amazonaws.com`,
      sendsDeleteIfMatch: true,
      sendsPutIfMatch: true,
      sendsPutIfNoneMatch: true,
    });
    expect(sent).toBe(0);
  });

  const routes: Array<{
    name: string;
    setup: (env: IsolatedAwsEnv) => S3Client;
    host: string | RegExp;
    aws: boolean;
  }> = [
    {
      name: 'a constructor endpoint (MinIO)',
      setup: () => client({ endpoint: 'http://127.0.0.1:9000' }),
      host: '127.0.0.1',
      aws: false,
    },
    {
      name: 'AWS_ENDPOINT_URL_S3',
      setup: (e) => (e.set({ AWS_ENDPOINT_URL_S3: 'http://127.0.0.1:9000' }), client()),
      host: '127.0.0.1',
      aws: false,
    },
    {
      name: 'AWS_ENDPOINT_URL',
      setup: (e) => (e.set({ AWS_ENDPOINT_URL: 'http://minio.internal:9000' }), client()),
      host: `${BUCKET}.minio.internal`,
      aws: false,
    },
    {
      name: 'AWS_ENDPOINT_URL with AWS_IGNORE_CONFIGURED_ENDPOINT_URLS (a control: the variable is the cause)',
      setup: (e) => (
        e.set({
          AWS_ENDPOINT_URL: 'http://minio.internal:9000',
          AWS_IGNORE_CONFIGURED_ENDPOINT_URLS: 'true',
        }),
        client()
      ),
      host: `${BUCKET}.s3.us-east-1.amazonaws.com`,
      aws: true,
    },
    {
      name: 'an endpoint_url in the shared config file (default profile)',
      setup: (e) => (e.writeConfig('[default]\nendpoint_url = http://127.0.0.1:9000\n'), client()),
      host: '127.0.0.1',
      aws: false,
    },
    {
      name: 'an endpoint_url under services.s3 in the shared config file',
      setup: (e) => (
        e.writeConfig(
          '[default]\nservices = local\n\n[services local]\ns3 =\n  endpoint_url = http://minio.internal:9000\n',
        ),
        client()
      ),
      host: `${BUCKET}.minio.internal`,
      aws: false,
    },
    {
      name: 'an endpoint function returning a URL',
      setup: () => client({ endpoint: (() => 'http://minio.internal:9000') as never }),
      host: `${BUCKET}.minio.internal`,
      aws: false,
    },
    {
      name: 'an endpoint function returning an endpoint object',
      setup: () =>
        client({
          endpoint: (async () => ({
            protocol: 'https:',
            hostname: 'storage.example.test',
            path: '/',
          })) as never,
        }),
      host: `${BUCKET}.storage.example.test`,
      aws: false,
    },
    {
      name: 'a Cloudflare R2 endpoint',
      setup: () => client({ endpoint: 'https://acct.r2.cloudflarestorage.com' }),
      host: `${BUCKET}.acct.r2.cloudflarestorage.com`,
      aws: false,
    },
    {
      name: 'a FIPS endpoint',
      setup: () => client({ useFipsEndpoint: true }),
      host: `${BUCKET}.s3-fips.us-east-1.amazonaws.com`,
      aws: true,
    },
    {
      name: 'a dual-stack endpoint',
      setup: () => client({ useDualstackEndpoint: true }),
      host: `${BUCKET}.s3.dualstack.us-east-1.amazonaws.com`,
      aws: true,
    },
    {
      name: 'a FIPS dual-stack endpoint',
      setup: () => client({ useFipsEndpoint: true, useDualstackEndpoint: true }),
      host: `${BUCKET}.s3-fips.dualstack.us-east-1.amazonaws.com`,
      aws: true,
    },
    {
      name: 'a China region',
      setup: () => client({ region: 'cn-north-1' }),
      host: `${BUCKET}.s3.cn-north-1.amazonaws.com.cn`,
      aws: true,
    },
    {
      name: 'a VPC interface endpoint, set as the endpoint',
      setup: () =>
        client({ endpoint: 'https://bucket.vpce-0abc123-xyz.s3.us-east-1.vpce.amazonaws.com' }),
      host: /\.vpce-0abc123-xyz\.s3\.us-east-1\.vpce\.amazonaws\.com$/,
      aws: true,
    },
    {
      name: 'an explicit regional AWS endpoint',
      setup: () => client({ endpoint: 'https://s3.eu-west-1.amazonaws.com', region: 'eu-west-1' }),
      host: /(^|\.)s3\.eu-west-1\.amazonaws\.com$/,
      aws: true,
    },
  ];

  it.each(routes)('$name', async ({ setup, host, aws }) => {
    const facts = await probeClient(setup(env), BUCKET);
    expect(facts, 'the probe resolved nothing').toBeDefined();
    if (typeof host === 'string') expect(facts!.host).toBe(host);
    else expect(facts!.host).toMatch(host);
    expect(isAwsS3Host(facts!.host)).toBe(aws);
    expect(sent, 'the probe handed the transport a request').toBe(0);
  });

  it('reads the environment when a request is built, not when the client was: why the answer cannot be had at construction', async () => {
    const built = client();
    expect(built.config.isCustomEndpoint).toBe(false);
    env.set({ AWS_ENDPOINT_URL_S3: 'http://127.0.0.1:9000' });
    expect(built.config.isCustomEndpoint).toBe(false); // the flag still says AWS
    expect(await hostOf(built)).toBe('127.0.0.1'); // the request would not go there
  });
});

describe('the SDK is checked for the headers the registry relies on', () => {
  const restores: Array<() => void> = [];
  afterEach(() => {
    while (restores.length > 0) restores.pop()!();
  });
  const without = (
    command: Parameters<typeof sdkWithout>[0],
    member: Parameters<typeof sdkWithout>[1],
  ): void => {
    restores.push(sdkWithout(command, member));
  };

  it('sees a DeleteObject that carries no If-Match', async () => {
    without('DeleteObjectCommand', 'IfMatch');
    expect(await probeClient(client(), BUCKET)).toMatchObject({
      sendsDeleteIfMatch: false,
      sendsPutIfMatch: true,
      sendsPutIfNoneMatch: true,
    });
  });

  it('sees a PutObject that carries no If-Match, and one that carries no If-None-Match', async () => {
    without('PutObjectCommand', 'IfMatch');
    expect(await probeClient(client(), BUCKET)).toMatchObject({
      sendsDeleteIfMatch: true,
      sendsPutIfMatch: false,
      sendsPutIfNoneMatch: true,
    });
    restores.pop()!();
    without('PutObjectCommand', 'IfNoneMatch');
    expect(await probeClient(client(), BUCKET)).toMatchObject({
      sendsPutIfMatch: true,
      sendsPutIfNoneMatch: false,
    });
  });

  it('control: the patch is what an SDK without the member does, and it is undone', async () => {
    expect(await probeClient(client(), BUCKET)).toMatchObject({ sendsDeleteIfMatch: true });
    without('DeleteObjectCommand', 'IfMatch');
    expect(await probeClient(client(), BUCKET)).toMatchObject({ sendsDeleteIfMatch: false });
    restores.pop()!();
    expect(await probeClient(client(), BUCKET)).toMatchObject({ sendsDeleteIfMatch: true });
  });
});

describe('the probe leaves the caller’s client alone', () => {
  it('runs none of its middleware, logs no command to its logger, looks up no credential, and sends nothing', async () => {
    let middleware = 0;
    let commandsLogged = 0;
    let lookups = 0;
    const mine = client({
      // The SDK's logging middleware reports each command it runs at `info`. Its configuration providers report what
      // they did not find at `debug` as they resolve, for the caller's client or the probe's alike.
      logger: {
        debug: (): void => {},
        info: (): void => {
          commandsLogged += 1;
        },
        warn: (): void => {},
        error: (): void => {},
      },
      credentials: () => {
        lookups += 1;
        return Promise.resolve(credentials);
      },
    });
    mine.middlewareStack.add(
      (next) => (args) => {
        middleware += 1; // a request counter, a tracer, an audit log: none may see a request that never exists
        return next(args);
      },
      { step: 'initialize', name: 'callerInstrumentation' },
    );
    expect(await probeClient(mine, BUCKET)).toBeDefined();
    expect({ middleware, commandsLogged, lookups, sent }).toEqual({
      middleware: 0,
      commandsLogged: 0,
      lookups: 0,
      sent: 0,
    });
  });

  it('does not call S3Client.prototype.send, so a class-level mock of it (aws-sdk-client-mock) records nothing from the probe', async () => {
    const original = S3Client.prototype.send;
    const recorded: string[] = [];
    S3Client.prototype.send = function (
      this: S3Client,
      command: { constructor: { name: string } },
    ) {
      recorded.push(command.constructor.name);
      return Promise.resolve({});
    } as typeof original;
    try {
      const facts = await probeClient(client(), BUCKET);
      expect(recorded).toEqual([]);
      expect(facts).toMatchObject({ sendsDeleteIfMatch: true, sendsPutIfMatch: true });
    } finally {
      S3Client.prototype.send = original;
    }
  });

  it('works for a client built with cacheMiddleware, and leaves its cached handlers alone', async () => {
    const cached = client({ cacheMiddleware: true });
    expect(await probeClient(cached, BUCKET)).toBeDefined();
    expect(await probeClient(cached, BUCKET)).toBeDefined();
    // An ordinary delete, sent the way any other caller of the shared client sends it, still reaches the transport.
    await expect(
      cached.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: 'k' })),
    ).rejects.toThrow('a request left the machine');
    expect(sent).toBe(1);
  });
});

describe('a client the probe cannot read', () => {
  it('a double with no middleware stack is not sent anything, and answers nothing', async () => {
    let calls = 0;
    const double = {
      send: (): Promise<never> => {
        calls += 1;
        return Promise.reject(new Error('unhandled'));
      },
    } as unknown as S3Client;
    expect(await probeClient(double, BUCKET)).toBeUndefined();
    expect(calls).toBe(0);
  });

  it('a class-based double with no resolved config is not built a second time', async () => {
    let built = 0;
    class Double {
      constructor() {
        built += 1;
      }
      send(): Promise<never> {
        return Promise.reject(new Error('unhandled'));
      }
    }
    expect(await probeClient(new Double() as unknown as S3Client, BUCKET)).toBeUndefined();
    expect(built).toBe(1); // the one the test made
  });

  it('a client whose region cannot be resolved answers nothing, and throws nothing', async () => {
    const noRegion = new S3Client({ credentials, requestHandler: tripwire as never });
    expect(await probeClient(noRegion, BUCKET)).toBeUndefined();
    expect(sent).toBe(0);
  });

  it('a client whose class cannot build a second client answers nothing, and throws nothing', async () => {
    const c = client();
    Object.defineProperty(c, 'constructor', {
      value: function (): never {
        throw new Error('cannot build');
      },
    });
    expect(await probeClient(c, BUCKET)).toBeUndefined();
  });
});

describe('which hosts are AWS S3', () => {
  it.each([
    's3.amazonaws.com',
    'bucket.s3.amazonaws.com',
    's3.us-east-1.amazonaws.com',
    'bucket.s3.eu-west-1.amazonaws.com',
    's3-us-west-2.amazonaws.com',
    's3-fips.us-east-1.amazonaws.com',
    's3.dualstack.us-east-1.amazonaws.com',
    's3-fips.dualstack.us-gov-west-1.amazonaws.com',
    's3.cn-north-1.amazonaws.com.cn',
    'bucket.s3.cn-northwest-1.amazonaws.com.cn',
    'bucket.vpce-0abc-xyz.s3.us-east-1.vpce.amazonaws.com',
    'my-ap-123456789012.s3-accesspoint.us-east-1.amazonaws.com',
    'S3.US-EAST-1.AMAZONAWS.COM',
    's3.us-east-1.amazonaws.com.',
  ])('%s is', (host) => {
    expect(isAwsS3Host(host)).toBe(true);
  });

  it.each([
    '127.0.0.1',
    'localhost',
    'minio.internal',
    'acct.r2.cloudflarestorage.com',
    's3.wasabisys.com',
    'amazonaws.com',
    's3.amazonaws.com.evil.test',
    'evilamazonaws.com',
    'evil-s3.amazonaws.com.attacker.test',
    'abc123.execute-api.us-east-1.amazonaws.com',
    'bucket.s3.stub.test',
    '',
  ])('%s is not', (host) => {
    expect(isAwsS3Host(host)).toBe(false);
  });
});
