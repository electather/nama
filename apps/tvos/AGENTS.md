# tvOS guidance

Read [tvOS application](../../docs/architecture/tvos-app.md) and [playback](../../docs/architecture/playback.md) before changing this subtree.

## Required SwiftUI skills

Before working on SwiftUI in this subtree, agents must use the applicable project skill(s):

- Use `swiftui-design` for UI design, redesign, visual polish, or design review.
- Use `swiftui-expert-skill` when writing, reviewing, or refactoring SwiftUI views, including state flow, focus, accessibility, API availability, performance, or previews.
- Use `swiftui-patterns` when designing or changing SwiftUI state ownership, view composition, navigation, environment injection, lists, or render performance.
- Use all applicable skills when a task spans their scopes. Do not use them for non-SwiftUI work such as generated bindings, fixture-server changes, or isolated engine integration.
- Apply their Apple-platform guidance to tvOS 17+ and preserve this subtree's architecture decisions where a general SwiftUI recommendation conflicts with them.

- Use generated public clients behind app-owned models; do not import provider-private types.
- Keep AetherEngine behind the single Nama-owned player adapter.
- Media flows directly from the provider through safe contract locators; credentials stay in Keychain and out of logs.
