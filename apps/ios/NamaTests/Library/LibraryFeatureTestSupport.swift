import Foundation

@testable import Nama

enum LibraryFeatureFixture {
  static let tokenExpiry: TimeInterval = 4_600
  private static let searchDebounceMilliseconds = 300
  static let searchDebounceDuration = Duration.milliseconds(searchDebounceMilliseconds)
}

struct LibraryPageCall: Equatable, Sendable {
  let query: LibraryQuery
  let pageToken: String?
}

actor ManualLibraryPageLoader: LibraryPageLoading, LibrarySearchPageLoading {
  private(set) var calls: [LibraryPageCall] = []
  private(set) var searchCalls: [LibrarySearchCall] = []
  private var continuations: [CheckedContinuation<LibraryPage, any Error>] = []
  private var searchContinuations: [CheckedContinuation<LibrarySearchPage, any Error>] = []

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

  func loadSearchPage(
    query: String,
    pageToken: String?,
    authorization: HomeAuthorizationIdentity
  ) async throws -> LibrarySearchPage {
    searchCalls.append(
      LibrarySearchCall(
        query: query,
        pageToken: pageToken,
        authorization: authorization
      )
    )
    return try await withCheckedThrowingContinuation { continuation in
      searchContinuations.append(continuation)
    }
  }

  func resolveSearch(
    call index: Int,
    with result: Result<LibrarySearchPage, LibraryLoadingFailure>
  ) {
    searchContinuations[index].resume(with: result.mapError { $0 as any Error })
  }
}

actor ImmediateLibraryPageLoader: LibraryPageLoading, LibrarySearchPageLoading {
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

  func loadSearchPage(
    query _: String,
    pageToken _: String?,
    authorization _: HomeAuthorizationIdentity
  ) throws -> LibrarySearchPage {
    let page = try result.get()
    return LibrarySearchPage(items: page.items, nextPageToken: page.nextPageToken)
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

struct LibrarySearchCall: Equatable, Sendable {
  let query: String
  let pageToken: String?
  let authorization: HomeAuthorizationIdentity
}

actor ManualLibrarySearchPageLoader: LibrarySearchPageLoading {
  private(set) var calls: [LibrarySearchCall] = []
  private(set) var cancellationCount = 0
  private var continuations: [CheckedContinuation<LibrarySearchPage, any Error>] = []

  func loadSearchPage(
    query: String,
    pageToken: String?,
    authorization: HomeAuthorizationIdentity
  ) async throws -> LibrarySearchPage {
    calls.append(
      LibrarySearchCall(
        query: query,
        pageToken: pageToken,
        authorization: authorization
      )
    )
    return try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation { continuation in
        continuations.append(continuation)
      }
    } onCancel: {
      Task {
        await self.recordCancellation()
      }
    }
  }

  func resolve(
    call index: Int,
    with result: Result<LibrarySearchPage, LibraryLoadingFailure>
  ) {
    continuations[index].resume(with: result.mapError { $0 as any Error })
  }
  private func recordCancellation() {
    cancellationCount += 1
  }
}

actor ManualLibrarySearchSleeper {
  private(set) var requestedDurations: [Duration] = []
  private(set) var cancellationCount = 0
  private var continuations: [AsyncStream<Void>.Continuation] = []

  func sleep(for duration: Duration) async throws {
    requestedDurations.append(duration)
    let (stream, continuation) = AsyncStream<Void>.makeStream()
    continuations.append(continuation)
    try await withTaskCancellationHandler {
      for await _ in stream {
        return
      }
      try Task.checkCancellation()
    } onCancel: {
      Task {
        await self.recordCancellation()
      }
    }
  }

  func releaseNext() {
    guard let continuation = continuations.first else {
      return
    }
    continuations.removeFirst()
    continuation.yield()
    continuation.finish()
  }

  func releaseLatest() {
    guard let continuation = continuations.last else {
      return
    }
    continuations.removeLast()
    continuation.yield()
    continuation.finish()
  }

  private func recordCancellation() {
    cancellationCount += 1
  }
}

func librarySearchItem(
  _ id: String,
  kind: MediaKind,
  title: String,
  releaseYear: UInt32? = nil,
  playability: MediaPlayability = .playable,
  episodePosition: MediaEpisodePosition? = nil,
  artwork: [ArtworkReference] = []
) -> MediaSummary {
  MediaSummary(
    identity: MediaIdentity(id),
    kind: kind,
    title: title,
    releaseYear: releaseYear,
    runtime: nil,
    contentRating: nil,
    primaryGenre: nil,
    artwork: artwork,
    playability: playability,
    defaultSource: nil,
    episodePosition: episodePosition
  )
}
