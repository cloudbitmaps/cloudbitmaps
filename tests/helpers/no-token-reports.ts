/**
 * A registry of someone else's that does not report the token of each write: it leaves `reportsWriteTokens` off, so a
 * publish settles a write that conflicted or got no answer by the object the pointer names, as it does for any
 * registry that cannot say whose write landed.
 */
import type { IRegistryDriver } from '@/core/ports';

export function withoutTokenReports(base: IRegistryDriver): IRegistryDriver {
  const out = Object.create(base) as IRegistryDriver;
  Object.defineProperty(out, 'reportsWriteTokens', { value: false });
  return out;
}
