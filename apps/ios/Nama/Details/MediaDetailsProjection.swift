nonisolated enum MediaDetailsMetadata: Equatable, Identifiable, Sendable {
  enum Identity: Hashable, Sendable {
    case releaseDate
    case firstReleaseDate
    case lastReleaseDate
    case releaseYear
    case runtime
    case contentRating
    case primaryGenre
    case seasonCount
    case episodeCount
    case seasonNumber
    case episodeNumber
  }

  case releaseDate(MediaCalendarDate)
  case firstReleaseDate(MediaCalendarDate)
  case lastReleaseDate(MediaCalendarDate)
  case releaseYear(UInt32)
  case runtime(Duration)
  case contentRating(String)
  case primaryGenre(String)
  case seasonCount(UInt32)
  case episodeCount(UInt32)
  case seasonNumber(UInt32)
  case episodeNumber(UInt32)

  var id: Identity {
    switch self {
    case .releaseDate:
      .releaseDate

    case .firstReleaseDate:
      .firstReleaseDate

    case .lastReleaseDate:
      .lastReleaseDate

    case .releaseYear:
      .releaseYear

    case .runtime:
      .runtime

    case .contentRating:
      .contentRating

    case .primaryGenre:
      .primaryGenre

    case .seasonCount:
      .seasonCount

    case .episodeCount:
      .episodeCount

    case .seasonNumber:
      .seasonNumber

    case .episodeNumber:
      .episodeNumber
    }
  }
  var descriptiveMetadata: MediaDetailsDescriptiveMetadata? {
    switch self {
    case .releaseDate(let date):
      .releaseDate(date)

    case .firstReleaseDate(let date):
      .firstReleaseDate(date)

    case .lastReleaseDate(let date):
      .lastReleaseDate(date)

    case .releaseYear(let year):
      .releaseYear(year)

    case .runtime(let runtime):
      .runtime(runtime)

    case .contentRating(let rating):
      .contentRating(rating)

    case .primaryGenre(let genre):
      .primaryGenre(genre)

    case .seasonCount, .episodeCount, .seasonNumber, .episodeNumber:
      nil
    }
  }

  var countMetadata: MediaDetailsCountMetadata? {
    switch self {
    case .seasonCount(let count):
      .seasonCount(count)

    case .episodeCount(let count):
      .episodeCount(count)

    case .seasonNumber(let number):
      .seasonNumber(number)

    case .episodeNumber(let number):
      .episodeNumber(number)

    case .releaseDate, .firstReleaseDate, .lastReleaseDate, .releaseYear, .runtime,
      .contentRating, .primaryGenre:
      nil
    }
  }
}
nonisolated enum MediaDetailsDescriptiveMetadata {
  case releaseDate(MediaCalendarDate)
  case firstReleaseDate(MediaCalendarDate)
  case lastReleaseDate(MediaCalendarDate)
  case releaseYear(UInt32)
  case runtime(Duration)
  case contentRating(String)
  case primaryGenre(String)
}

nonisolated enum MediaDetailsCountMetadata {
  case seasonCount(UInt32)
  case episodeCount(UInt32)
  case seasonNumber(UInt32)
  case episodeNumber(UInt32)
}

nonisolated extension MediaDetails {
  var presentationMetadata: [MediaDetailsMetadata] {
    switch kindDetails {
    case .movie(let releaseDate):
      return playableMetadata(releaseDate: releaseDate, includesPosition: nil)

    case .show(
      let firstReleaseDate,
      let lastReleaseDate,
      let seasonCount,
      let episodeCount
    ):
      var metadata: [MediaDetailsMetadata] = []
      if let firstReleaseDate {
        metadata.append(.firstReleaseDate(firstReleaseDate))
      }
      if let lastReleaseDate {
        metadata.append(.lastReleaseDate(lastReleaseDate))
      }
      if let seasonCount {
        metadata.append(.seasonCount(seasonCount))
      }
      if let episodeCount {
        metadata.append(.episodeCount(episodeCount))
      }
      appendRatingAndGenre(to: &metadata)
      return metadata

    case .season(let seasonNumber, let episodeCount):
      var metadata: [MediaDetailsMetadata] = [.seasonNumber(seasonNumber)]
      if let episodeCount {
        metadata.append(.episodeCount(episodeCount))
      }
      return metadata

    case .episode(let seasonNumber, let episodeNumber, let releaseDate):
      return playableMetadata(
        releaseDate: releaseDate,
        includesPosition: (seasonNumber, episodeNumber)
      )
    }
  }

  private func playableMetadata(
    releaseDate: MediaCalendarDate?,
    includesPosition position: (season: UInt32, episode: UInt32)?
  ) -> [MediaDetailsMetadata] {
    var metadata: [MediaDetailsMetadata] = []
    if let position {
      metadata.append(.seasonNumber(position.season))
      metadata.append(.episodeNumber(position.episode))
    }
    if let releaseDate {
      metadata.append(.releaseDate(releaseDate))
    } else if let releaseYear {
      metadata.append(.releaseYear(releaseYear))
    }
    if let runtime {
      metadata.append(.runtime(runtime))
    }
    appendRatingAndGenre(to: &metadata)
    return metadata
  }

  private func appendRatingAndGenre(to metadata: inout [MediaDetailsMetadata]) {
    if let contentRating {
      metadata.append(.contentRating(contentRating))
    }
    if let primaryGenre {
      metadata.append(.primaryGenre(primaryGenre))
    }
  }
}

nonisolated extension MediaKind {
  var detailsSystemImage: String {
    switch self {
    case .movie:
      "film"

    case .show:
      "tv"

    case .season:
      "rectangle.stack"

    case .episode:
      "play.rectangle"
    }
  }
}

nonisolated extension MediaSummary {
  var childRuntime: Duration? {
    kind == .episode ? runtime : nil
  }

  var preferredChildArtwork: ArtworkReference? {
    let role: ArtworkRole = kind == .episode ? .thumbnail : .poster
    return artwork.first { reference in
      reference.role == role && reference.textPresence == .textless
    } ?? artwork.first { $0.role == role }
  }
}

nonisolated enum MediaChildrenTelevisionAction: Equatable, Sendable {
  case loadMore
  case loading
  case retry
  case reauthorize
}

nonisolated func mediaChildrenTelevisionAction(
  for state: MediaChildrenState
) -> MediaChildrenTelevisionAction? {
  switch state {
  case .content(_, let nextPageToken):
    nextPageToken == nil ? nil : .loadMore

  case .loadingMore:
    .loading

  case .pageFailed(_, _, let failure):
    failure == .authorizationUnavailable ? .reauthorize : .retry

  case .notApplicable, .loading:
    nil
  }
}

nonisolated func mediaChildrenTelevisionFocusIdentity(
  current: MediaIdentity?,
  retainedPosition: Int?,
  available: [MediaIdentity],
  refreshRecoveryIsActive: Bool
) -> MediaIdentity? {
  guard !refreshRecoveryIsActive else {
    return nil
  }
  guard let current else {
    return available.first
  }
  if available.contains(current) {
    return current
  }
  guard let retainedPosition else {
    return available.first
  }
  if available.indices.contains(retainedPosition) {
    return available[retainedPosition]
  }
  return available.last
}

nonisolated enum MediaDetailsTelevisionRefreshAction: Equatable, Sendable {
  case enabled
  case disabled
}

nonisolated func mediaDetailsTelevisionRefreshAction(
  canRefresh: Bool,
  isRefreshing: Bool
) -> MediaDetailsTelevisionRefreshAction? {
  guard canRefresh else {
    return nil
  }
  return isRefreshing ? .disabled : .enabled
}

nonisolated enum MediaDetailsTelevisionFocusAction: Equatable, Hashable, Sendable {
  case refreshRecovery
  case play
  case retry
  case sources
}

nonisolated func mediaDetailsTelevisionFocusAction(
  playability: MediaPlayability,
  hasSources: Bool,
  retryIsEnabled: Bool,
  refreshRecoveryIsActive: Bool
) -> MediaDetailsTelevisionFocusAction? {
  guard !refreshRecoveryIsActive else {
    return nil
  }
  if playability == .playable {
    return .play
  }
  if playability == .temporarilyUnavailable, retryIsEnabled {
    return .retry
  }
  return hasSources ? .sources : nil
}
