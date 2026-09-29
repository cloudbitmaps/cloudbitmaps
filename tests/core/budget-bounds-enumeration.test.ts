import { collectWithinBudget, resolveBudget, DEFAULT_BUDGET } from '@/core/budget';
import { BudgetExceededError } from '@/core/errors';

// The budget bounds the ENUMERATION, not just the fan-out it feeds.
//
// These tests pin that a caller stops reading an async iterable once the budget is exceeded. Checking
// `items.length` after a full drain refuses the fan-out too, but only after buffering the whole list, so a tight
// budget would provide no memory protection at all: that contradicts the bounded-memory invariant, and makes the
// documented mitigation (`budget.maxRequests`) the very thing that does not work.
//
// THE ASSERTION THAT MATTERS is not "it throws" — a full drain throws too. It is **how far the source was
// consumed**. A test that only checks for the error passes against a full drain. So each case below counts
// what the iterable actually yielded and asserts the scan was abandoned, which is the only observable
// difference between the two implementations.
const budget = resolveBudget({ maxRequests: 2 }, DEFAULT_BUDGET);

/** An async source that records how many items it was asked for. */
function countingSource(total: number): { source: AsyncIterable<number>; yielded: () => number } {
  let yielded = 0;
  return {
    yielded: () => yielded,
    source: {
      async *[Symbol.asyncIterator]() {
        for (let i = 0; i < total; i++) {
          yielded++;
          yield i;
        }
      },
    },
  };
}

describe('collectWithinBudget', () => {
  it('abandons the scan at the ceiling instead of draining the source', async () => {
    const { source, yielded } = countingSource(10_000);
    await expect(collectWithinBudget(source, budget, 'probe')).rejects.toBeInstanceOf(
      BudgetExceededError,
    );
    // 3, not 10,000: two admitted, the third trips the ceiling and stops. This is the whole point — the old
    // code yielded all 10,000 first. Resident memory is now O(budget), not O(source).
    expect(yielded()).toBe(3);
  });

  it('admits exactly the budget, matching checkBudget’s threshold', async () => {
    // A budget of N must admit N and refuse the N+1'th — the same `>` comparison `checkBudget` uses. Off-by-one
    // here would either reject legitimate work or leak one extra unit past the ceiling.
    const exact = countingSource(2);
    await expect(collectWithinBudget(exact.source, budget, 'probe')).resolves.toEqual([0, 1]);
    expect(exact.yielded()).toBe(2);

    const overByOne = countingSource(3);
    await expect(collectWithinBudget(overByOne.source, budget, 'probe')).rejects.toBeInstanceOf(
      BudgetExceededError,
    );
  });

  it('drains fully when the budget is disabled, because that is an explicit opt-out', async () => {
    const { source, yielded } = countingSource(500);
    await expect(collectWithinBudget(source, null, 'probe')).resolves.toHaveLength(500);
    expect(yielded()).toBe(500);
  });

  it('names the operation and admits it cannot report an exact total', async () => {
    // The message is deliberately vaguer than checkBudget's: an exact total requires finishing the scan, which
    // is the cost being refused. It must not imply a precise count it did not pay for.
    const { source } = countingSource(10_000);
    const err = (await collectWithinBudget(source, budget, 'subjectReport').catch(
      (e: unknown) => e,
    )) as Error;
    expect(err.message).toContain('subjectReport');
    expect(err.message).toContain('more than 2');
    expect(err.message).not.toMatch(/\b10000\b/);
  });

  it('propagates a source failure rather than masking it as a budget breach', async () => {
    const boom: AsyncIterable<number> = {
      async *[Symbol.asyncIterator]() {
        yield 1;
        throw new Error('backend exploded');
      },
    };
    await expect(collectWithinBudget(boom, budget, 'probe')).rejects.toThrow('backend exploded');
  });
});
