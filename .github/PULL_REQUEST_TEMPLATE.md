## What & why

<!--
The change and the reason it exists. Lead with the problem, not the diff.
Link issues: `Closes #123` — or `see #123` to reference without auto-closing.
-->

## How it was tested

<!--
Commands run and cases covered. No untested behavior.
Name the tests that would fail if the change were reverted — "the gate is green" is not a test plan.
-->

## Checklist

- [ ] Full gate green locally: `lint` · `lint:arch` · `format:check` · `typecheck` · `test` · `build`
- [ ] **Adversarial review gate run** — multiple parallel subagents, one per lens, against the whole component end to end; real findings fixed here or recorded with a severity and a deferral
- [ ] New behavior ships with tests in the same commit; anything touching a [hard invariant](../CLAUDE.md#hard-correctness-invariants) has a named test
- [ ] Docs updated in the same change — guide · API reference · README · `CHANGELOG.md` (`[Unreleased]`) · `docs/ROADMAP.md`
- [ ] Nothing here points somewhere a reader cannot follow — no private links, no bare internal citations (code comments included: they ship in the `.d.ts`)
- [ ] No secrets or personal data; no AI-attribution in commits or this description
