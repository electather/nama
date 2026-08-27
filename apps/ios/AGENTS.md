# Universal Apple application

## Authorities

Before changing this subtree, read:

1. [`PRODUCT.md`](PRODUCT.md) for the current product surface;
2. [`../../docs/architecture/ios-app.md`](../../docs/architecture/ios-app.md)
   for application architecture and status;
3. [`../../docs/architecture/api-contracts.md`](../../docs/architecture/api-contracts.md)
   for public client behavior; and
4. the relevant subsystem note, ADR, and nearest nested `AGENTS.md`.

Architecture, ADRs, contracts, and Protobuf remain authoritative. Keep nested
guidance to module-local code facts and exceptions; update the authority instead
of copying its rules into `AGENTS.md`.

## Skills

Load only the branches required by the task:

- SwiftUI implementation or review: `swiftui-expert-skill`, beginning with
  `references/latest-apis.md`.
- Observation, navigation, environment, composition, or rendering:
  `swiftui-patterns`.
- Module interfaces, seams, or dependency direction: `codebase-design`.
- Visual design, interaction, accessibility, focus, or UI polish:
  `impeccable`; use `swiftui-design` only when its workflow is available.
- Feature or bug work: `test-driven-development`.
- Post-verification documentation reconciliation:
  `distilling-implementation-docs`.
- Agent-guidance changes: `writing-for-agents`.

## Workflow

- Put source and its test coverage under the owning module paths. Keep Xcode
  groups aligned when files move.
- Use Swift Testing with deterministic adapters. New behavior starts with the
  focused failing test; tests never wait on real time or live services.
- Run Swift Testing filters at the suite level; a method-level
  `xcodebuild -only-testing` filter can match nothing while exiting
  successfully.
- Run `mise run check:swift` and `mise run check:ios` for handwritten Swift
  changes.
