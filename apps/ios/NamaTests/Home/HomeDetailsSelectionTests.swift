import Testing

@testable import Nama

@Suite("Home Details selection")
struct HomeDetailsSelectionTests {
  @Test(
    "Movies and Shows preserve opaque canonical identity",
    arguments: [MediaKind.movie, .show]
  )
  func supportedKindSelection(_ kind: MediaKind) {
    let item = MediaSummary(
      identity: MediaIdentity("opaque-home-media"),
      kind: kind,
      title: "A Canonical Home Title",
      releaseYear: nil,
      runtime: nil,
      contentRating: nil,
      primaryGenre: nil,
      artwork: [],
      playability: .noAvailableSource,
      defaultSource: nil
    )

    #expect(
      homeDetailsSelection(for: item)
        == MediaDetailsSelection(
          identity: MediaIdentity("opaque-home-media"),
          kind: kind,
          title: "A Canonical Home Title"
        )
    )
  }
}
