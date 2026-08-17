# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read in role order

1. **`CONTEXT.md`** — authoritative domain language for the single Nama context.
2. **`docs/architecture.md`** and the relevant `docs/architecture/` subsystem note — authoritative current and target system shape.
3. The relevant contract, such as **`docs/architecture/api-contracts.md`** — authoritative required behavior.
4. The applicable file under **`proto/`** — authoritative concrete wire definitions, field numbers, annotations, and generated APIs.
5. The relevant accepted **`docs/adr/`** record — authoritative architectural choice and rationale.

When sources materially conflict, surface the exact conflict and retain each source's role rather than silently reconciling it.

## File structure

Nama uses a single-context layout:

```text
/
├── CONTEXT.md                         ← domain glossary
├── docs/
│   ├── adr/                           ← accepted choices and rationale
│   ├── architecture.md                ← system-wide architecture entry point and ADR index
│   └── architecture/                  ← living subsystem architecture and contracts
├── apps/
├── plugins/
└── proto/                             ← concrete wire definitions
```

## Use the glossary's vocabulary

When output names a domain concept—in an issue title, refactor proposal, hypothesis, or test name—use the term defined in `CONTEXT.md`. Do not drift to synonyms the glossary explicitly avoids.

If the required concept is absent, reconsider whether the output is inventing language the project does not use. If the gap is real, note it for `/domain-modeling`.

## Flag authority conflicts

If output contradicts an authoritative source, surface the exact conflict rather than silently overriding it:

> _Contradicts `CONTEXT.md`, `docs/adr/<record>.md`, `docs/architecture/<record>.md`, a contract, or `proto/<path>` — but worth reopening because…_
