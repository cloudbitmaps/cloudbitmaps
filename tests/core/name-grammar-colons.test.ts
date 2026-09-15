import fc from 'fast-check';
import { ValidationError } from '@/core/errors';
import { validateSegmentRef } from '@/core/validate';

// Colons are legal in a name after the first character. This file is the grammar's contract: what the
// change bought, what it deliberately did NOT open up, and the property that holds over the whole space.
//
// The motivating failure: every dated-bucket example the retention docs published — `active:2026-08-01`,
// `sent:daily:${day}` — threw. They were written, reviewed, formatted, gate-passed and merged without once
// being executed, because prose in a fenced block is not run by anything.

const ok = (segment: string): void => validateSegmentRef({ segment });

describe('name grammar: colons', () => {
  it('accepts the dated-bucket shapes the docs always used', () => {
    for (const name of [
      'dedup:2026-08-01',
      'sent:daily:2026-08-01',
      'active:2026-08-01',
      'a:b',
      'seg:0',
      'user:123:seen',
    ])
      expect(() => ok(name)).not.toThrow();
  });

  it('accepts a colon in a namespace too, not just a segment', () => {
    expect(() => validateSegmentRef({ segment: 's', namespace: 'tenant:acme' })).not.toThrow();
  });

  it('still refuses a LEADING colon — an empty family is a typo, not a name', () => {
    expect(() => ok(':daily')).toThrow(ValidationError);
    expect(() => validateSegmentRef({ segment: 's', namespace: ':acme' })).toThrow(ValidationError);
  });

  it('still refuses a leading underscore, which is reserved for the _default sentinel', () => {
    expect(() => ok('_default')).toThrow(ValidationError);
  });

  it('did NOT open the door to anything else — %, /, \\ and .. stay out', () => {
    // `%` matters most: `drivers/localfs/paths.ts` percent-encodes `:` on the way to a filesystem path, and
    // that encoding is only reversible because no legal name can spell an escape sequence itself.
    for (const bad of ['a%3Ab', 'a%b', 'a/b', 'a\\b', 'a..b', 'a b', 'a:b/../c'])
      expect(() => ok(bad)).toThrow(ValidationError);
  });

  it('holds the 256-character ceiling with colons in play', () => {
    expect(() => ok('a' + ':b'.repeat(127) + 'c')).not.toThrow(); // 256
    expect(() => ok('a' + ':b'.repeat(128))).toThrow(ValidationError); // 257
  });

  it('property: a legal name plus interior colons is still a legal name', () => {
    const LEAD = fc.constantFrom(...'abzAZ09'.split(''));
    const REST = fc.stringMatching(/^[A-Za-z0-9._:-]{0,64}$/);
    fc.assert(
      fc.property(LEAD, REST, (lead, rest) => {
        const name = lead + rest;
        // `..` is refused independently of the charset, so exclude it from the claim.
        fc.pre(!name.includes('..'));
        expect(() => ok(name)).not.toThrow();
      }),
      { numRuns: 500 },
    );
  });
});
