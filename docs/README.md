# CloudRoaring docs

Two audiences, two trees:

| You are… | Go to |
|---|---|
| **using CloudRoaring** (or evaluating it) | [**`guide/`**](guide/) — user-facing docs: getting started, how-tos, kept accurate to what's actually shipped — plus the [**public roadmap**](ROADMAP.md) and [**benchmarks**](benchmarks.md) |
| **contributing / understanding the design** | **`internal/`** — the design specs, threat/cost models, phase plans, research, decision log, and roadmap (project planning; the source of project state) |

How we work (branching, the per-phase + adversarial-review process, the doc rules, code style) is in
[**`CONTRIBUTING.md`**](../CONTRIBUTING.md) at the repo root.

New here? Start with the [**getting-started guide**](guide/getting-started.md). Curious where the
project is headed? [**`ROADMAP.md`**](ROADMAP.md) is the user-facing view — what's shipped, the validated
envelope, and what's next — and the **usage walkthrough** shows the full end-to-end
experience. Contributors: [**`ROADMAP.md`**](ROADMAP.md) is the public view of what has shipped and
the living source of project state; the public page is its curated subset, kept in sync in the same change.

Prefer something visual? The **shareable site** in [**`../site/`**](../site/) — [`index.html`](../site/index.html)
(overview), [`usage.html`](../site/usage.html) (how-to, flows & use cases), and
[`architecture.html`](../site/architecture.html) (a phase-by-phase deep-dive with diagrams) — is a
self-contained, Pages-ready walkthrough of what CloudRoaring is and how it's built. Open the files
locally or serve `site/` as a static site.
