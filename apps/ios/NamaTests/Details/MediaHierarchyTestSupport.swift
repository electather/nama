import Foundation

@testable import Nama

actor ManualHierarchyDetailsLoader: MediaDetailsLoading, MediaChildrenLoading {
  private struct PendingDetails {
    let continuation: CheckedContinuation<MediaDetails, any Error>
  }

  private struct PendingChildren {
    let pageToken: String?
    let continuation: CheckedContinuation<MediaChildrenPage, any Error>
  }

  private var pendingDetails: [PendingDetails] = []
  private var pendingChildren: [PendingChildren] = []
  private var cancelledChildren = 0

  var detailsCallCount: Int { pendingDetails.count }
  var childrenCallCount: Int { pendingChildren.count }
  var childrenCancellationCount: Int { cancelledChildren }

  func load(
    _: MediaDetailsSelection,
    authorization _: HomeAuthorizationIdentity
  ) async throws -> MediaDetails {
    try await withCheckedThrowingContinuation { continuation in
      pendingDetails.append(PendingDetails(continuation: continuation))
    }
  }

  func loadChildren(
    for _: MediaDetailsSelection,
    pageToken: String?,
    authorization _: HomeAuthorizationIdentity
  ) async throws -> MediaChildrenPage {
    try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation { continuation in
        pendingChildren.append(
          PendingChildren(pageToken: pageToken, continuation: continuation)
        )
      }
    } onCancel: {
      Task { await self.recordChildrenCancellation() }
    }
  }

  func resolveDetails(call index: Int, with result: Result<MediaDetails, any Error>) {
    pendingDetails[index].continuation.resume(with: result)
  }

  func resolveChildren(call index: Int, with result: Result<MediaChildrenPage, any Error>) {
    pendingChildren[index].continuation.resume(with: result)
  }

  func childrenPageToken(call index: Int) -> String? {
    pendingChildren[index].pageToken
  }

  private func recordChildrenCancellation() {
    cancelledChildren += 1
  }
}

func hierarchySelection(
  _ identity: String,
  kind: MediaKind,
  title: String
) -> MediaDetailsSelection {
  MediaDetailsSelection(identity: MediaIdentity(identity), kind: kind, title: title)
}

func hierarchyDetails(
  _ selection: MediaDetailsSelection,
  kindDetails: MediaDetailsKind,
  playability: MediaPlayability = .noAvailableSource,
  runtime: Duration? = nil
) -> MediaDetails {
  let source =
    playability == .playable
    ? MediaSourceSummary(
      identity: MediaSourceIdentity("source-default"),
      label: nil,
      isDefault: true,
      availability: .available,
      container: nil,
      videoQuality: nil,
      audioQuality: nil
    )
    : nil
  return MediaDetails(
    identity: selection.identity,
    title: requiredMediaSelectionTitle(selection),
    releaseYear: nil,
    runtime: runtime,
    contentRating: nil,
    primaryGenre: nil,
    tagline: nil,
    synopsis: nil,
    genres: [],
    studios: [],
    credits: [],
    artwork: [],
    parents: [],
    playability: playability,
    defaultSource: source,
    sourceSummaries: source.map { [$0] } ?? [],
    kindDetails: kindDetails
  )
}

func hierarchyShowDetails(_ selection: MediaDetailsSelection) -> MediaDetails {
  hierarchyDetails(
    selection,
    kindDetails: .show(
      firstReleaseDate: nil,
      lastReleaseDate: nil,
      seasonCount: nil,
      episodeCount: nil
    )
  )
}

func hierarchyChild(
  _ identity: String,
  kind: MediaKind,
  title: String,
  season: UInt32? = nil,
  episode: UInt32? = nil
) -> MediaSummary {
  MediaSummary(
    identity: MediaIdentity(identity),
    kind: kind,
    title: title,
    releaseYear: nil,
    runtime: nil,
    contentRating: nil,
    primaryGenre: nil,
    artwork: [],
    playability: .noAvailableSource,
    defaultSource: nil,
    episodePosition: season.flatMap { seasonNumber in
      episode.map { episodeNumber in
        MediaEpisodePosition(seasonNumber: seasonNumber, episodeNumber: episodeNumber)
      }
    }
  )
}
