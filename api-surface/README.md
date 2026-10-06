# `api-surface/` — the public type signatures, snapshotted

One file records every public type signature, and one lists the changes to it that were agreed. `scripts/api-surface.cjs`
reads and writes them; [CONTRIBUTING](../CONTRIBUTING.md#commands-the-gate) says when it runs.

| file | what it holds |
|---|---|
| `surface.json` | One entry per exported symbol of every public entry point (each package's `exports` map, subpaths included), and one per member of a class, interface or enum, with its full signature text and each overload. Sorted, with no path in it. Regenerate with `pnpm api:surface` after an intended change; `pnpm api:surface:check` fails if the built declarations are not this file. |
| `allowed.json` | A JSON array of `{ "entry", "reason" }` rows, empty in the normal state. An entry that the base branch's snapshot lists and this branch removes or changes fails `--against` unless a row names it (`entry` is the exact key, or a prefix ending in `*`), and a row without a reason fails too. A row excuses only a change this branch makes; once the change has merged it excuses nothing and can be deleted. |
