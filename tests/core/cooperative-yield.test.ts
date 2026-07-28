import { yieldEvery, YIELD_EVERY } from '@/core/cooperative';
import type { Clock } from '@/core/determinism';
import { SystemClock } from '@/system-clock';

// The yield primitive, and the one property that makes it worth having: it must be a MACROTASK.
//
// This is a fix whose plausible implementations measure as no change at all, so the tests are written against
// what actually happens to the event loop rather than against the shape of the code. Two traps:
//
//   1. `await Promise.resolve()` and `Clock.sleep(0)` both resolve on a MICROTASK, and the microtask queue drains
//      to empty before the loop advances a phase. A loop awaiting them starves pending I/O exactly as much as a
//      loop that never yields — measured at 555 ms of starvation against a 568 ms unyielded baseline.
//   2. Yielding per unit of work costs more than the work. Hence a cadence, and hence the `null` return: the
//      common call must allocate nothing.
//
// A test asserting only "a promise came back" would pass against both traps, so each case below pins the
// observable instead.
const clockWith = (over: Partial<Clock>): Clock => ({
  now: () => 0,
  sleep: () => Promise.resolve(),
  ...over,
});

describe('yieldEvery', () => {
  it('returns null until the cadence, so the hot path allocates nothing', () => {
    const tick = yieldEvery(clockWith({ yieldNow: () => Promise.resolve() }), 4);
    expect([tick(), tick(), tick()]).toEqual([null, null, null]);
    expect(tick()).toBeInstanceOf(Promise);
    // ...and the counter resets rather than yielding on every call from then on.
    expect([tick(), tick(), tick()]).toEqual([null, null, null]);
    expect(tick()).toBeInstanceOf(Promise);
  });

  it('never yields at all without a clock — opting out changes nothing', async () => {
    // `core/` cannot default a clock (timer-free by lint), so a core-only caller gets exactly the pre-existing
    // behaviour. Adding a yield point to a code path must never alter it for someone who did not opt in.
    const tick = yieldEvery(undefined, 1);
    for (let i = 0; i < 10; i++) expect(tick()).toBeNull();
  });

  it('prefers yieldNow, and falls back to sleep(1) — never sleep(0) — on a clock without it', async () => {
    const calls: string[] = [];
    const modern = yieldEvery(
      clockWith({
        yieldNow: () => {
          calls.push('yieldNow');
          return Promise.resolve();
        },
        sleep: (ms) => {
          calls.push(`sleep(${ms})`);
          return Promise.resolve();
        },
      }),
      1,
    );
    await modern();
    expect(calls).toEqual(['yieldNow']);

    // A Clock written before `yieldNow` existed still satisfies the interface — the member is optional. It must
    // degrade to something that genuinely yields. `sleep(1)` is a real timer; `sleep(0)` is contractually a
    // microtask and would silently reinstate the bug.
    calls.length = 0;
    const legacy = yieldEvery(
      clockWith({
        sleep: (ms) => {
          calls.push(`sleep(${ms})`);
          return Promise.resolve();
        },
      }),
      1,
    );
    await legacy();
    expect(calls).toEqual(['sleep(1)']);
  });

  it('defaults to a cadence coarse enough that the yield disappears into the batch', () => {
    // The constant is a measured tradeoff, not a round number picked for looks: at 1,024 the yield costs ~0.2%
    // of wall time while capping a blocking stretch in the low tens of ms. Pinned so a casual edit is deliberate.
    expect(YIELD_EVERY).toBe(1024);
    const tick = yieldEvery(clockWith({ yieldNow: () => Promise.resolve() }));
    for (let i = 1; i < YIELD_EVERY; i++) expect(tick()).toBeNull();
    expect(tick()).toBeInstanceOf(Promise);
  });
});

describe('SystemClock.yieldNow', () => {
  it('actually lets a pending I/O-phase callback run, which sleep(0) does not', async () => {
    // THE test. It distinguishes a real yield from a microtask by scheduling a `setImmediate` and asking whether
    // it got to run. Nothing about the promise's shape can tell you this — only its scheduling.
    const clock = new SystemClock();

    let ranDuringMicrotask = false;
    setImmediate(() => {
      ranDuringMicrotask = true;
    });
    await clock.sleep(0);
    expect(ranDuringMicrotask, 'sleep(0) is a microtask — it must NOT let the loop turn').toBe(
      false,
    );

    let ranDuringYield = false;
    setImmediate(() => {
      ranDuringYield = true;
    });
    await clock.yieldNow();
    expect(ranDuringYield, 'yieldNow must hand the loop back').toBe(true);
  });

  it('does not wait for a timer, so periodic yielding stays cheap', async () => {
    // `setTimeout(1)` also yields, and costs ~1 ms of dead wall-clock each time — measured at +10% over a 1M-id
    // load for no extra relief. 200 yields therefore have to come in far under the ~200 ms that would imply.
    const clock = new SystemClock();
    const started = Date.now();
    for (let i = 0; i < 200; i++) await clock.yieldNow();
    expect(Date.now() - started).toBeLessThan(100);
  });
});
