import NamaAPI

nonisolated extension NamaLibraryClient {
  static func mapHomeResponse(
    _ response: Nama_Api_V1_GetHomeResponse
  ) throws -> HomeSnapshot {
    guard response.sections.count <= HomeResponseBounds.maximumSections else {
      throw MediaResponseMappingError.invalid
    }
    var movies: HomeShelf?
    var shows: HomeShelf?

    for section in response.sections {
      switch section.kind {
      case .movies:
        guard movies == nil else {
          throw MediaResponseMappingError.invalid
        }
        movies = try map(section, kind: .movies, itemKind: .movie)

      case .shows:
        guard shows == nil else {
          throw MediaResponseMappingError.invalid
        }
        shows = try map(section, kind: .shows, itemKind: .show)

      case .continueWatching, .UNRECOGNIZED:
        continue

      case .unspecified:
        throw MediaResponseMappingError.invalid
      }
    }

    return HomeSnapshot(movies: movies, shows: shows)
  }

  private static func map(
    _ section: Nama_Api_V1_HomeSection,
    kind: HomeShelfKind,
    itemKind: MediaKind
  ) throws -> HomeShelf? {
    guard
      mediaStringIsBounded(section.id),
      mediaStringIsBounded(section.title),
      section.items.count <= HomeResponseBounds.maximumSectionItems
    else {
      throw MediaResponseMappingError.invalid
    }
    let items = try section.items.map { item in
      try mapMediaSummary(item, expectedKind: itemKind)
    }
    guard !items.isEmpty else {
      return nil
    }
    return HomeShelf(
      identity: HomeShelfIdentity(section.id),
      title: section.title,
      kind: kind,
      items: items
    )
  }
}

nonisolated private enum HomeResponseBounds {
  static let maximumSections = 3
  static let maximumSectionItems = 50
}
