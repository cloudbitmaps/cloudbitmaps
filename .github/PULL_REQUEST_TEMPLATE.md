## What & why

<!-- The change and the reason. Link issues: `Closes #123` — or `see #123` to reference without auto-closing. -->

## How it was tested

<!-- Commands run + cases covered. New behavior ships with tests in the same commit. -->

## Checklist

- [ ] Full gate green locally: `lint` · `lint:arch` · `format:check` · `typecheck` · `test` · `build` · `smoke`
- [ ] Touches a driver? `pnpm test:integration` green against the docker-compose backends
- [ ] Docs updated in the same change (see [CONTRIBUTING → Documentation](https://github.com/cloudbitmaps/cloudbitmaps/blob/main/CONTRIBUTING.md#documentation--keeping-it-current)):
      README / `docs/guide/` / `CHANGELOG.md` (top of `[Unreleased]`, newest-first) / roadmap
- [ ] Consequential + hard to reverse (public exports, `.crbm` format, a dependency)? Say so in the PR body —
      a maintainer records it as a numbered ADR in the decision log
- [ ] Hot path (`add` / `has` / `remove` / `count` / `intersect`) not taxed for a feature most users won't use
- [ ] No secrets or personal data; nothing logs keys, PII, or bitmap contents
- [ ] I've read and agree to follow the [Code of Conduct](https://github.com/cloudbitmaps/cloudbitmaps/blob/main/CODE_OF_CONDUCT.md)
