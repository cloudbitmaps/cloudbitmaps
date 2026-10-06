# `api-surface/` — the public type signatures, snapshotted

One file records every public type signature, and one lists the changes to it that were agreed. `scripts/api-surface.cjs`
reads and writes them; [CONTRIBUTING](../CONTRIBUTING.md#commands-the-gate) says when it runs.

| file | what it holds |
|---|---|
| `surface.json` | One entry per exported symbol of every public entry point (each package's `exports` map, subpaths included), and one per public member of a class, interface or enum, with its full signature text and each overload. A type that a public signature names and no entry exports is recorded too, with its members and the types they name, under a `(referenced)` key; a type from outside the workspace is not expanded. Sorted, with no path in it. Regenerate with `pnpm api:surface` after an intended change; `pnpm api:surface:check` fails if the built declarations are not this file. |
| `allowed.json` | A JSON array of `{ "entry", "reason" }` rows, empty in the normal state. An entry that the base branch's snapshot lists and this branch removes or changes fails `--against` unless a row names it. `entry` is the exact key, or a prefix ending in `*` that holds a package and at least the start of a symbol's name (a bare `*`, or a prefix that stops before a name, is refused), and a row without a reason fails. A row excuses a change only if the base branch's `allowed.json` does not already have the same row, entry and reason, so a row left over from an earlier change excuses nothing and can be deleted at any time; a later change to the same entry needs a row with a reason of its own. A parameter rename is a change and needs a row. |

**Addition or change.** A new export, a new class member, an optional member (`name?:`, `name?()`) of an interface or object type, and any member of a type that is itself new are additions: they pass `--against`, and `--check` still asks for the regenerated snapshot. A required member added to an interface or object type the base already has (a property or method without `?`, or an index, call or construct signature) is a change, because it breaks every caller that implements or constructs that type, and it needs a row. `surface.json` records which members are required under `required`, decided from the declaration, not from the printed text.

**What the gate does not see.** A change in behaviour behind an unchanged signature is for tests. Overloads are compared in
declared order, so one appended after the last reads as an addition and passes. A type from outside the workspace is
known by its name in the signatures that use it. Private members are not public and are not recorded. A member added to a
class is an addition even when it is abstract, though it binds a subclass. A TypeScript upgrade that changes how declarations
print needs one `pnpm api:surface`.
