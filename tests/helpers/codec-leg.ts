/**
 * Which codec the running vitest project puts behind the store: `native` (every project but one) or `ts`, the
 * `ts-codec` project, whose setup flips the store package's internal codec switch (`tests/setup-codec-ts.ts`).
 */
import { inject } from 'vitest';

declare module 'vitest' {
  export interface ProvidedContext {
    /** The codec the project puts behind the store; absent in a project that leaves the default. */
    codec?: 'native' | 'ts';
  }
}

/** The codec this test file's project puts behind the store. */
export function codecLeg(): 'native' | 'ts' {
  return inject('codec') ?? 'native';
}
