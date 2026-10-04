/**
 * Measuring what a stream keeps alive: buffers are registered as they are allocated, a garbage collection is forced,
 * and the ones still reachable are counted. A gate holds the newest read so that a consumer is really waiting inside
 * the stream, which is the state where a stream that kept the item it just handed out would show it.
 */
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';

setFlagsFromString('--expose-gc');
const gc = runInNewContext('gc') as () => void;

export const tick = (ms = 5): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Buffers registered as they are allocated, counted while still reachable. By default the buffer under the array is
 * watched, which is right where each allocation has a buffer of its own; `views` watches the array object instead, for
 * an allocator that carves its results out of one shared slab (a crypto library's output often is), where the buffer
 * would stay alive for as long as any neighbour did.
 */
export class Watched {
  private refs: WeakRef<object>[] = [];

  constructor(private readonly views = false) {}

  /** Registers a buffer and returns it, so it can wrap the place that allocates. */
  track<T extends Uint8Array>(bytes: T): T {
    this.refs.push(new WeakRef(this.views ? bytes : bytes.buffer));
    return bytes;
  }

  reset(): void {
    this.refs = [];
  }

  /** How many registered buffers are still reachable, after a forced collection. */
  async live(): Promise<number> {
    for (let i = 0; i < 3; i++) {
      await tick(1);
      gc();
    }
    return this.refs.filter((r) => r.deref() !== undefined).length;
  }
}

/** Reads wait on it while it is closed; a read that starts while it is open is not held. */
export class Gate {
  private held: Promise<void> = Promise.resolve();
  private release: () => void = () => {};

  close(): void {
    this.held = new Promise<void>((r) => (this.release = r));
  }

  open(): void {
    this.release();
    this.held = Promise.resolve();
  }

  /** Awaited by a read after it has allocated its buffer. */
  wait(): Promise<void> {
    return this.held;
  }
}

/**
 * Drives `next` in rounds. Each round closes the gate, asks for items until one does not arrive (the stream is
 * waiting inside its own request for the newest, gated, range), forces a collection and calls `measure`, then opens the
 * gate and takes the item. Returns the worst of what `measure` saw, and how many times the stream was caught waiting,
 * so a test can insist that it really was.
 */
export async function worstWhileWaiting(
  next: () => Promise<{ done?: boolean }>,
  gate: Gate,
  measure: () => Promise<number[]>,
  rounds: number,
): Promise<{ worst: number[]; waits: number }> {
  let worst: number[] = [];
  let waits = 0;
  for (let round = 0; round < rounds; round++) {
    gate.close();
    for (;;) {
      // The item is dropped here, not kept by this loop: only its arrival is looked at.
      const arrived = next().then(
        (step) => (step.done === true ? ('ended' as const) : ('arrived' as const)),
        () => 'failed' as const,
      );
      const outcome = await Promise.race([arrived, tick(5).then(() => 'waiting' as const)]);
      if (outcome === 'failed') throw new Error('the stream failed');
      if (outcome === 'ended') return { worst, waits };
      if (outcome === 'waiting') {
        const seen = await measure();
        worst = worst.length === 0 ? seen : seen.map((n, i) => Math.max(n, worst[i]!));
        waits++;
        gate.open();
        if ((await arrived) === 'ended') return { worst, waits };
        break;
      }
    }
  }
  gate.open();
  return { worst, waits };
}
