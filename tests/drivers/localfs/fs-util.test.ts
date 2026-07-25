import { isCode, isFsTransient, mapFsError } from '@/drivers/localfs/fs-util';
import { IntegrityError, TransientError } from '@/core/errors';

const fsErr = (code: string): Error => Object.assign(new Error(code), { code });

describe('localfs error helpers', () => {
  it('isCode matches a Node system error code', () => {
    expect(isCode(fsErr('ENOENT'), 'ENOENT')).toBe(true);
    expect(isCode(fsErr('EEXIST'), 'ENOENT')).toBe(false);
    expect(isCode('not an error', 'ENOENT')).toBe(false);
  });

  it('isFsTransient flags busy / again / fd-exhaustion / timeout', () => {
    for (const code of ['EBUSY', 'EAGAIN', 'EMFILE', 'ENFILE', 'ETIMEDOUT']) {
      expect(isFsTransient(fsErr(code))).toBe(true);
    }
    expect(isFsTransient(fsErr('ENOENT'))).toBe(false);
    expect(isFsTransient(fsErr('EEXIST'))).toBe(false);
    expect(isFsTransient('nope')).toBe(false);
  });

  it('mapFsError wraps a transient fault as TransientError (preserving cause), else passes through', () => {
    const busy = fsErr('EMFILE');
    const mapped = mapFsError(busy);
    expect(mapped).toBeInstanceOf(TransientError);
    expect((mapped as TransientError).cause).toBe(busy);

    const enoent = fsErr('ENOENT');
    expect(mapFsError(enoent)).toBe(enoent); // not transient — unchanged

    const integrity = new IntegrityError('corrupt');
    expect(mapFsError(integrity)).toBe(integrity); // our own typed errors pass through
  });
});
