import Testing

func eventually(
  _ condition: @escaping @MainActor @Sendable () async -> Bool,
  sourceLocation: SourceLocation = #_sourceLocation
) async {
  for _ in 0..<1_000 {
    if await condition() {
      return
    }
    await Task.yield()
  }
  Issue.record("Condition did not become true", sourceLocation: sourceLocation)
}
