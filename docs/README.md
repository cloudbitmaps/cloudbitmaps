# CloudBitmaps docs

Two audiences, two trees:

| You are… | Go to |
|---|---|
| **using CloudBitmaps** (or evaluating it) | [**`guide/`**](guide/) — getting started, how-tos, and the [complete API reference](guide/api-reference.md), kept accurate to what is actually shipped |
| **deciding whether to adopt it** | the [**roadmap**](ROADMAP.md) — what has shipped, what is proven to what degree, and what has been deliberately ruled out — and the [**benchmarks**](benchmarks.md), with their method and what they do *not* establish |
| **contributing** | [**`CONTRIBUTING.md`**](../CONTRIBUTING.md) — branching, the gate every change must pass, the adversarial-review step, the doc rules and code style |
| **understanding *why* the design is shaped this way** | the code. Every module leads with a header explaining the decision it encodes and what the alternative cost; the [hard correctness invariants](../CLAUDE.md#hard-correctness-invariants) name the protocol rules and each one has named tests |

Everything you need is in this repository. Where a decision matters to someone reading or extending the code,
it is written down **here** — in the module header, in these docs, or in the changelog entry that made the
change — and nothing points you at a document you cannot open. If you find a claim you cannot check from the
repo alone, that is a bug worth
[opening an issue](https://github.com/cloudbitmaps/cloudbitmaps/issues) about.

New here? Start with the [**getting-started guide**](guide/getting-started.md).

Prefer something visual? The **shareable site** in [**`../site/`**](../site/) — [`index.html`](../site/index.html)
(overview), [`usage.html`](../site/usage.html) (how-to, flows & use cases), and
[`architecture.html`](../site/architecture.html) (a phase-by-phase deep-dive with diagrams) — is a
self-contained, Pages-ready walkthrough of what CloudBitmaps is and how it's built. Open the files
locally or serve `site/` as a static site.
