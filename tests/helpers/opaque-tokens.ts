/**
 * A registry of someone else's: one whose tokens carry no incarnation id. It wraps a shipped registry and hands out
 * each of its tokens as `v<n>`, a value of its own, never reused, so nothing outside can tell two incarnations of a name
 * apart by a token. A row's `pointerId` is the token of a write too, and is handed out the same way.
 */
import type {
  IRegistryDriver,
  NewRegistryRecord,
  RegistryPatch,
  RegistryRecord,
  RegistryWriteOptions,
  SegmentRef,
  Token,
} from '@/core/ports';

export function opaqueTokens(base: IRegistryDriver): IRegistryDriver {
  const outer = new Map<Token, Token>();
  const inner = new Map<Token, Token>();
  let next = 0;
  const out = (token: Token): Token => {
    let mine = outer.get(token);
    if (mine === undefined) {
      next += 1;
      mine = `v${next}`;
      outer.set(token, mine);
      inner.set(mine, token);
    }
    return mine;
  };
  // A token this registry never handed out stands for no write of the base, so a write against it loses.
  const into = (token: Token): Token => inner.get(token) ?? `unknown:${token}`;
  const row = (r: RegistryRecord | null): RegistryRecord | null =>
    r === null ? null : { ...r, token: out(r.token), pointerId: out(r.pointerId) };
  return {
    capabilities: () => base.capabilities(),
    get: async (ref: SegmentRef) => row(await base.get(ref)),
    async create(ref: SegmentRef, record: NewRegistryRecord, options?: RegistryWriteOptions) {
      return {
        token: out(
          (await base.create(ref, record, options?.held === null ? { held: null } : undefined))
            .token,
        ),
      };
    },
    async compareAndSwap(ref: SegmentRef, expected: Token, patch: RegistryPatch) {
      return { token: out((await base.compareAndSwap(ref, into(expected), patch)).token) };
    },
    async *list(namespace?: string) {
      for await (const r of base.list(namespace)) yield row(r)!;
    },
    delete: (ref: SegmentRef, expected?: Token) =>
      base.delete(ref, expected === undefined ? undefined : into(expected)),
  };
}
