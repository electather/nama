---
condition: '(?i)\b(?:fallow-ignore(?:-(?:next-line|file))?|oxlint-disable(?:-next-line)?)\b'
scope: tool
interruptMode: always
---

Treat a lint-suppression directive as an exceptional, local tradeoff. First preserve the rule's intent by simplifying the implementation, splitting an independent concern, narrowing a test helper, or correcting the lint configuration when that is the real defect.

Add a suppression only when the inspected rule and the surrounding code show that the required shape cannot reasonably comply. Keep it to the smallest justified surface:

- Prefer `fallow-ignore-next-line` and `oxlint-disable-next-line` over file-wide directives.
- Use `fallow-ignore-file` only for a deliberately non-discoverable executable fixture or similarly isolated file; include the execution path that makes it necessary.
- Use file-wide `oxlint-disable` only for a self-contained integration scenario, disposable protocol fixture, or tightly coupled state machine whose required ordering or visibility would be harmed by a mechanical refactor.
- Name only the specific rules involved and put a concise, factual reason after `--`. The reason must explain why the code or file belongs outside that rule, not merely restate the directive.

Do not use a suppression to bypass ordinary production code quality, silence a newly introduced violation, avoid a focused refactor, or hide unrelated violations. Re-run the owning lint or check after the change; unused suppression directives are defects.