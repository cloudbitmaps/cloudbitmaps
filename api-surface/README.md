# `api-surface/` — the public type signatures, snapshotted

One file records every public type signature, and one lists the changes to it that were agreed. `scripts/api-surface.cjs`
reads and writes them; [CONTRIBUTING](../CONTRIBUTING.md#commands-the-gate) says when it runs.

| file | what it holds |
|---|---|
| `surface.json` | One entry per exported symbol of every public entry point (each package's `exports` map, subpaths included), and one per public member of a class, interface or enum, with its full signature text and each overload. A type that a public signature names and no entry exports is recorded too, with its members and the types they name, under a `(referenced)` key; a type from outside the workspace is not expanded. Sorted, with no path in it. Regenerate with `pnpm api:surface` after an intended change; `pnpm api:surface:check` fails if the built declarations are not this file. |
| `allowed.json` | A JSON array of `{ "entry", "reason" }` rows, empty in the normal state. An entry that the base branch's snapshot lists and this branch removes or changes fails `--against` unless a row names it. `entry` is the exact key, or a prefix ending in `*` that holds a package and at least the start of a symbol (a bare `*` is refused), and a row without a reason fails. A row excuses a change only if the base branch's `allowed.json` does not already have a row for that entry, so a row left over from an earlier change excuses nothing and can be deleted at any time. A parameter rename is a change and needs a row. |

**What the gate does not see.** A change in behaviour behind an unchanged signature is for tests. Overloads are compared in
declared order, so one appended after the last reads as an addition and passes. A type from outside the workspace is
known by its name in the signatures that use it. Private members are not public and are not recorded. A TypeScript
upgrade that changes how declarations print needs one `pnpm api:surface`.
