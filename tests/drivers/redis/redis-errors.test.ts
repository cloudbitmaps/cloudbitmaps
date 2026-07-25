import { isTransient } from '@/drivers/redis/redis-errors';

const codeErr = (code: string) => Object.assign(new Error(code), { code });

describe('Redis error classification', () => {
  it('dropped/timed-out sockets are transient', () => {
    for (const n of [
      'ECONNRESET',
      'ECONNREFUSED',
      'ETIMEDOUT',
      'EPIPE',
      'EAI_AGAIN',
      'ENOTFOUND',
    ]) {
      expect(isTransient(codeErr(n))).toBe(true);
    }
  });

  it('Redis failover/loading server replies + ioredis connection-state messages are transient', () => {
    for (const m of [
      'LOADING Redis is loading the dataset in memory',
      'CLUSTERDOWN Hash slot not served',
      'TRYAGAIN Multiple keys request during rehashing',
      'MASTERDOWN Link with MASTER is down',
      "READONLY You can't write against a read only replica.",
      'Connection is closed.',
      'Command timed out',
      "Stream isn't writeable and enableOfflineQueue options is false",
      'Reached the max retries per request limit (which is 20).', // ioredis MaxRetriesPerRequestError
    ]) {
      expect(isTransient(new Error(m))).toBe(true);
    }
  });

  it('deterministic replies / unknown errors are NOT transient (must surface)', () => {
    for (const m of [
      'WRONGTYPE Operation against a key holding the wrong kind of value',
      'ERR unknown command',
      'NOSCRIPT No matching script',
      'boom',
    ]) {
      expect(isTransient(new Error(m))).toBe(false);
    }
    expect(isTransient(null)).toBe(false);
    expect(isTransient({})).toBe(false);
  });
});
