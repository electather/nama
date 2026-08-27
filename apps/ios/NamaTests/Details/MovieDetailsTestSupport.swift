import Foundation

@testable import Nama

enum MovieDetailsFeatureFixture {
  static let backdropDisplayScale = 2.0
  static let backdropDisplayWidth = 1_000.0
  static let backdropPixelHeight: UInt32 = 1_080
  static let backdropPixelWidth: UInt32 = 1_920
  static let castCount = 10
  static let initialCastLimit = 8
  static let posterDisplayScale = 2.0
  static let posterDisplayWidth = 148.0
  static let releaseYear: UInt32 = 2_026
  static let runtimeSeconds: Int64 = 7_200
  static let tokenExpiry: TimeInterval = 4_600
}

actor ManualMovieDetailsLoader: MovieDetailsLoading {
  private struct PendingLoad {
    let selection: MovieDetailsSelection
    let authorization: HomeAuthorizationIdentity
    let continuation: CheckedContinuation<MovieDetails, any Error>
  }

  private var pendingLoads: [PendingLoad] = []
  private var cancelledLoads = 0

  var callCount: Int {
    pendingLoads.count
  }

  var cancellationCount: Int {
    cancelledLoads
  }

  func load(
    _ selection: MovieDetailsSelection,
    authorization: HomeAuthorizationIdentity
  ) async throws -> MovieDetails {
    try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation { continuation in
        pendingLoads.append(
          PendingLoad(
            selection: selection,
            authorization: authorization,
            continuation: continuation
          )
        )
      }
    } onCancel: {
      Task {
        await self.recordCancellation()
      }
    }
  }

  func resolve(call index: Int, with result: Result<MovieDetails, any Error>) {
    pendingLoads[index].continuation.resume(with: result)
  }

  private func recordCancellation() {
    cancelledLoads += 1
  }
}

actor MissingMovieDetailsArtworkLoader: HomeArtworkLoading {
  private(set) var callCount = 0

  func authorizationDidChange(to _: HomeAuthorizationIdentity) {
    // This fixture has no authorization-scoped state.
  }

  func image(
    for _: ArtworkReference,
    size _: ArtworkSizeBucket,
    authorization _: HomeAuthorizationIdentity
  ) -> HomeArtworkPresentation? {
    callCount += 1
    return nil
  }
}

actor ManualMovieDetailsArtworkLoader: HomeArtworkLoading {
  private var continuations: [CheckedContinuation<HomeArtworkPresentation?, Never>] = []

  var callCount: Int {
    continuations.count
  }

  func authorizationDidChange(to _: HomeAuthorizationIdentity) {
    // This fixture has no authorization-scoped state.
  }

  func image(
    for _: ArtworkReference,
    size _: ArtworkSizeBucket,
    authorization _: HomeAuthorizationIdentity
  ) async -> HomeArtworkPresentation? {
    await withCheckedContinuation { continuation in
      continuations.append(continuation)
    }
  }

  func resolve(call index: Int, with presentation: HomeArtworkPresentation?) {
    continuations[index].resume(returning: presentation)
  }
}

func movieDetailsSelection(identity: String, title: String) -> MovieDetailsSelection {
  MovieDetailsSelection(identity: MediaIdentity(identity), title: title)
}

func movieDetailsAuthorization(generation: UInt64) throws -> HomeAuthorizationIdentity {
  HomeAuthorizationIdentity(
    endpoint: try NamaEndpoint("https://nama.example.test"),
    accessTokenExpiresAt: Date(timeIntervalSince1970: MovieDetailsFeatureFixture.tokenExpiry),
    generation: generation
  )
}

func movieDetailsFixture(
  selection: MovieDetailsSelection,
  playability: MediaPlayability = .playable,
  credits: [MovieCredit] = movieDetailsDefaultCredits(),
  artwork: [ArtworkReference] = []
) -> MovieDetails {
  MovieDetails(
    identity: selection.identity,
    title: selection.title,
    releaseYear: MovieDetailsFeatureFixture.releaseYear,
    runtime: .seconds(MovieDetailsFeatureFixture.runtimeSeconds),
    contentRating: "PG-13",
    primaryGenre: "Drama",
    tagline: "Everything changes at midnight.",
    synopsis: "A stored canonical movie synopsis.",
    genres: ["Drama", "Mystery"],
    studios: ["North Star Pictures"],
    credits: credits,
    artwork: artwork,
    playability: playability,
    defaultSource: playability == .playable
      ? MediaSourceSummary(
        identity: MediaSourceIdentity("source-default"),
        label: "4K HDR",
        isDefault: true,
        availability: .available,
        container: "mkv",
        videoQuality: nil,
        audioQuality: nil
      )
      : nil
  )
}

func movieArtwork(
  identity: String,
  role: ArtworkRole,
  textPresence: ArtworkTextPresence
) -> ArtworkReference {
  ArtworkReference(
    identity: ArtworkIdentity(identity),
    role: role,
    width: nil,
    height: nil,
    locale: nil,
    textPresence: textPresence
  )
}

private func movieDetailsDefaultCredits() -> [MovieCredit] {
  [
    MovieCredit(
      name: "Ada Director",
      role: .director,
      characterName: nil,
    ),
    MovieCredit(
      name: "Sam Actor",
      role: .actor,
      characterName: "The Traveler",
    ),
  ]
}
