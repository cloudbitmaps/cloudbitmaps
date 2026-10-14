import { ValidationError } from '@/index';
import { validateSegmentRef, validateUserRef } from '@/core/validate';
import { batchWorld } from '../helpers/batch-world';

const SHAPE =
  "a segment ref is an object such as { segment: 'name' }; store.segment() takes the bare name";

describe('a segment ref that is not an object', () => {
  it.each([
    ['a string', 'shoppers'],
    ['null', null],
    ['undefined', undefined],
  ])('is refused with the shape of a ref by both validators: %s', (_name, bad) => {
    for (const validate of [validateSegmentRef, validateUserRef]) {
      expect(() => validate(bad as never)).toThrow(ValidationError);
      expect(() => validate(bad as never)).toThrow(SHAPE);
    }
  });

  it('is refused by store.load, with the name left out of the message', async () => {
    const w = await batchWorld({ s: [1, 2, 3] });
    for (const bad of ['shoppers', null, undefined]) {
      const err = await w.store.load(bad as never, [1]).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as Error).message).toBe(SHAPE);
    }
  });

  it('a ref object still loads', async () => {
    const w = await batchWorld({ s: [1, 2, 3] });
    await expect(w.store.load({ segment: 's' }, [1, 2])).resolves.toMatchObject({
      published: true,
    });
  });

  it('store.segment given an object says to pass ref.segment, without the name', async () => {
    const w = await batchWorld({ s: [1] });
    const err = (() => {
      try {
        w.store.segment({ segment: 'personal-name' } as never);
      } catch (e) {
        return e as Error;
      }
      return undefined;
    })();
    expect(err).toBeInstanceOf(ValidationError);
    expect(err!.message).toBe(
      "segment: the name is a string, store.segment('name'), not an object: pass ref.segment",
    );
    expect(err!.message).not.toContain('personal-name');
  });
});
