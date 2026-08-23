import Testing

func eventually(
  _ condition: @MainActor @Sendable () async -> Bool,
  sourceLocation: SourceLocation = #_sourceLocation
) async {
  let maximumTaskYields = 1_000
  for _ in 0..<maximumTaskYields {
    if await condition() {
      return
    }
    await Task.yield()
  }
  Issue.record("Condition did not become true", sourceLocation: sourceLocation)
}
