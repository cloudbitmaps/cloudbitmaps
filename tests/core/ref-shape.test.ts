import { ValidationError } from '@/index';
import { validateSegmentRef, validateUserRef } from '@/core/validate';
import { batchWorld } from '../helpers/batch-world';

const REF_IS_OBJECT = "a segment ref is an object such as { segment: 'name' }";
const USER_SHAPE = `${REF_IS_OBJECT}; store.segment() takes the bare name`;

describe('a segment ref that is not an object', () => {
  it.each([
    ['a string', 'shoppers'],
    ['null', null],
    ['undefined', undefined],
  ])('is refused with the shape of a ref by both validators: %s', (_name, bad) => {
    for (const validate of [validateSegmentRef, validateUserRef]) {
      expect(() => validate(bad as never)).toThrow(ValidationError);
    }
    // The driver kit's validator says what a ref is; only the application-facing one points at store.segment().
    expect(() => validateSegmentRef(bad as never)).toThrow(
      new RegExp(`^${REF_IS_OBJECT.replace(/[{}]/g, '\\$&')}$`),
    );
    expect(() => validateUserRef(bad as never)).toThrow(USER_SHAPE);
  });

  it('is refused by store.load, with the name left out of the message', async () => {
    const w = await batchWorld({ s: [1, 2, 3] });
    for (const bad of ['shoppers', null, undefined]) {
      const err = await w.store.load(bad as never, [1]).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as Error).message).toBe(USER_SHAPE);
    }
  });

  it('a ref object still loads', async () => {
    const w = await batchWorld({ s: [1, 2, 3] });
    await expect(w.store.load({ segment: 's' }, [1, 2])).resolves.toMatchObject({
      published: true,
    });
  });

  it('store.segment given an object or an array says what to pass, without the name', async () => {
    const w = await batchWorld({ s: [1] });
    const messageOf = (bad: unknown): string => {
      try {
        w.store.segment(bad as never);
      } catch (e) {
        expect(e).toBeInstanceOf(ValidationError);
        return (e as Error).message;
      }
      return '';
    };
    const ref = messageOf({ segment: 'personal-name', namespace: 'tenant-7' });
    expect(ref).toBe(
      'segment: the name is a string, not a ref: for a ref, call store.segment(ref.segment, { namespace: ref.namespace })',
    );
    expect(ref).not.toContain('personal-name');
    expect(ref).not.toContain('tenant-7');
    expect(messageOf(['personal-name'])).toBe(
      "segment: the name is a string, store.segment('name'), not an array",
    );
  });

  it("the namespace option the advice names addresses the ref's namespace", async () => {
    const w = await batchWorld({ s: [1] });
    expect(() => w.store.segment('s', { namespace: 'tenant-7' })).not.toThrow();
  });
});
