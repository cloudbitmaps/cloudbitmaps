import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ContainerClient, StorageSharedKeyCredential } from '@azure/storage-blob';
import { AzureBlobStorage } from '@/azure-blob/backend';
import { guardLoopback } from '../../helpers/loopback-guard';

/**
 * `AzureBlobStorage.checkLifecycle` is always `unchecked`, because an account's lifecycle management policy is on the
 * management plane, which a blob client does not reach. It sends no request at all: a loopback server counts them.
 */

let server: Server;
let url: string;
let requests = 0;
let guard: ReturnType<typeof guardLoopback>;
beforeAll(async () => {
  guard = guardLoopback();
  server = createServer((req, res) => {
    requests += 1;
    req.resume();
    res.writeHead(500).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  guard.restore();
  expect(guard.attempts).toEqual([]);
});

const ACCOUNT_KEY = Buffer.from('stand-in-account-key-0123456789').toString('base64');
const store = (prefix?: string): AzureBlobStorage =>
  new AzureBlobStorage({
    containerClient: new ContainerClient(
      `${url}/acct/box`,
      new StorageSharedKeyCredential('stand-in', ACCOUNT_KEY),
    ),
    ...(prefix === undefined ? {} : { prefix }),
  });

describe('AzureBlobStorage.checkLifecycle', () => {
  it('is unchecked and says how to read the policy by hand, naming the container and prefix', async () => {
    const out = await store('/cr//').checkLifecycle();
    expect(out.status).toBe('unchecked');
    expect(out.detail).toContain('az storage account management-policy show');
    expect(out.detail).toContain('"box/cr/"');
  });

  it('names the whole container when the store has no prefix', async () => {
    expect((await store().checkLifecycle()).detail).toContain('"box/"');
  });

  it('sends no request', async () => {
    requests = 0;
    await store('cr').checkLifecycle();
    expect(requests).toBe(0);
  });

  it('carries no credential', async () => {
    const out = await store('cr').checkLifecycle();
    expect(out.detail).not.toContain(ACCOUNT_KEY);
    expect(out.detail).not.toContain('stand-in');
  });
});
