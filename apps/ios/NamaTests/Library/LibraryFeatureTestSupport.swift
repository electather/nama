import Foundation

@testable import Nama

private enum LibraryFeatureFixture {
  static let tokenExpiry: TimeInterval = 4_600
}

struct LibraryPageCall: Equatable, Sendable {
  let query: LibraryQuery
  let pageToken: String?
}

actor ManualLibraryPageLoader: LibraryPageLoading {
  private(set) var calls: [LibraryPageCall] = []
  private var continuations: [CheckedContinuation<LibraryPage, any Error>] = []

  func loadPage(
    query: LibraryQuery,
    pageToken: String?,
    authorization _: HomeAuthorizationIdentity
  ) async throws -> LibraryPage {
    calls.append(LibraryPageCall(query: query, pageToken: pageToken))
    return try await withCheckedThrowingContinuation { continuation in
      continuations.append(continuation)
    }
  }

  func resolve(call index: Int, with result: Result<LibraryPage, LibraryLoadingFailure>) {
    continuations[index].resume(with: result.mapError { $0 as any Error })
  }
}

actor ImmediateLibraryPageLoader: LibraryPageLoading {
  let result: Result<LibraryPage, LibraryLoadingFailure>

  init(result: Result<LibraryPage, LibraryLoadingFailure>) {
    self.result = result
  }

  func loadPage(
    query _: LibraryQuery,
    pageToken _: String?,
    authorization _: HomeAuthorizationIdentity
  ) throws -> LibraryPage {
    try result.get()
  }
}

actor IgnoringLibraryArtworkLoader: HomeArtworkLoading {
  func authorizationDidChange(to _: HomeAuthorizationIdentity) {
    // This adapter has no cache to invalidate.
  }

  func image(
    for _: ArtworkReference,
    size _: ArtworkSizeBucket,
    authorization _: HomeAuthorizationIdentity
  ) -> HomeArtworkPresentation? {
    nil
  }
}

func libraryAuthorization(generation: UInt64) throws -> HomeAuthorizationIdentity {
  HomeAuthorizationIdentity(
    endpoint: try NamaEndpoint("https://nama.example.test"),
    accessTokenExpiresAt: Date(timeIntervalSince1970: LibraryFeatureFixture.tokenExpiry),
    generation: generation
  )
}

func libraryItem(_ id: String, kind: MediaKind, title: String) -> MediaSummary {
  MediaSummary(
    identity: MediaIdentity(id),
    kind: kind,
    title: title,
    releaseYear: nil,
    runtime: nil,
    contentRating: nil,
    primaryGenre: nil,
    artwork: [],
    playability: .playable,
    defaultSource: nil
  )
}
