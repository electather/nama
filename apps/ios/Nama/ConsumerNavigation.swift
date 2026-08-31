import Observation

nonisolated enum ConsumerTopLevelDestination: String, CaseIterable, Equatable, Hashable, Sendable {
  case home = "consumer.home"
  case library = "consumer.library"
}

nonisolated enum ConsumerNavigationDestination: Equatable, Hashable, Sendable {
  case details(MediaDetailsSelection)
  case sources(MediaSourcesSelection)

  var detailsSelection: MediaDetailsSelection? {
    guard case .details(let selection) = self else {
      return nil
    }
    return selection
  }
}

nonisolated enum ConsumerPlatformFamily: Equatable, Sendable {
  case phone
  case pad
  case television
  case mac
}

nonisolated enum ConsumerNavigationLayout: Equatable, Sendable {
  case tabs
  case split
}

nonisolated func consumerNavigationLayout(
  for platform: ConsumerPlatformFamily
) -> ConsumerNavigationLayout {
  switch platform {
  case .phone, .television:
    .tabs

  case .pad, .mac:
    .split
  }
}

nonisolated struct ConsumerSceneRestoration: Equatable, Sendable {
  private static let maximumMediaIDLength = 256

  let topLevel: ConsumerTopLevelDestination
  let libraryQuery: LibraryQuery
  let selectedMediaID: String?

  init(
    topLevelRawValue: String?,
    libraryKindRawValue: String?,
    librarySortRawValue: String?,
    selectedMediaID: String?
  ) {
    topLevel = topLevelRawValue.flatMap(ConsumerTopLevelDestination.init(rawValue:)) ?? .home
    let kind = libraryKindRawValue.flatMap(LibraryKind.init(rawValue:)) ?? .movies
    let sort = librarySortRawValue.flatMap(LibrarySort.init(rawValue:)) ?? .title
    libraryQuery = LibraryQuery(kind: kind, sort: sort)
    self.selectedMediaID = Self.validMediaID(selectedMediaID)
  }

  private init(
    topLevel: ConsumerTopLevelDestination,
    libraryQuery: LibraryQuery,
    selectedMediaID: String?
  ) {
    self.topLevel = topLevel
    self.libraryQuery = libraryQuery
    self.selectedMediaID = Self.validMediaID(selectedMediaID)
  }

  static let `default` = Self(
    topLevel: .home,
    libraryQuery: .initial,
    selectedMediaID: nil
  )

  var topLevelRawValue: String {
    topLevel.rawValue
  }

  var libraryKindRawValue: String {
    libraryQuery.kind.rawValue
  }

  var librarySortRawValue: String {
    libraryQuery.sort.rawValue
  }

  private static func validMediaID(_ value: String?) -> String? {
    guard
      let value,
      !value.isEmpty,
      value.utf8.count <= maximumMediaIDLength
    else {
      return nil
    }
    return value
  }
}

@MainActor
@Observable
final class ConsumerSceneNavigation {
  var topLevel: ConsumerTopLevelDestination
  private(set) var libraryQuery: LibraryQuery
  var homePath: [ConsumerNavigationDestination]
  var libraryPath: [ConsumerNavigationDestination]

  init(restoration: ConsumerSceneRestoration) {
    topLevel = restoration.topLevel
    libraryQuery = restoration.libraryQuery
    let restoredPath: [ConsumerNavigationDestination] =
      restoration.selectedMediaID.map { mediaID in
        [.details(MediaDetailsSelection(restoredIdentity: MediaIdentity(mediaID)))]
      } ?? []
    switch restoration.topLevel {
    case .home:
      homePath = restoredPath
      libraryPath = []

    case .library:
      homePath = []
      libraryPath = restoredPath
    }
  }

  func restore(_ restoration: ConsumerSceneRestoration) {
    topLevel = restoration.topLevel
    libraryQuery = restoration.libraryQuery
    homePath.removeAll(keepingCapacity: false)
    libraryPath.removeAll(keepingCapacity: false)
    guard let mediaID = restoration.selectedMediaID else {
      return
    }
    let selection = ConsumerNavigationDestination.details(
      MediaDetailsSelection(restoredIdentity: MediaIdentity(mediaID))
    )
    switch restoration.topLevel {
    case .home:
      homePath = [selection]

    case .library:
      libraryPath = [selection]
    }
  }

  func showLibrary(for shelf: HomeShelfKind) {
    libraryQuery = LibraryQuery(
      kind: shelf == .movies ? .movies : .shows,
      sort: .dateAdded
    )
    libraryPath.removeAll(keepingCapacity: false)
    topLevel = .library
  }

  func updateLibraryKind(_ kind: LibraryKind) {
    guard libraryQuery.kind != kind else {
      return
    }
    libraryQuery = LibraryQuery(kind: kind, sort: libraryQuery.sort)
    libraryPath.removeAll(keepingCapacity: false)
  }

  func updateLibrarySort(_ sort: LibrarySort) {
    guard libraryQuery.sort != sort else {
      return
    }
    libraryQuery = LibraryQuery(kind: libraryQuery.kind, sort: sort)
    libraryPath.removeAll(keepingCapacity: false)
  }

  func select(
    _ selection: MediaDetailsSelection,
    from destination: ConsumerTopLevelDestination
  ) {
    switch destination {
    case .home:
      homePath.append(.details(selection))

    case .library:
      libraryPath.append(.details(selection))
    }
  }

  var restoration: ConsumerSceneRestoration {
    let activePath =
      switch topLevel {
      case .home:
        homePath

      case .library:
        libraryPath
      }
    return ConsumerSceneRestoration(
      topLevelRawValue: topLevel.rawValue,
      libraryKindRawValue: libraryQuery.kind.rawValue,
      librarySortRawValue: libraryQuery.sort.rawValue,
      selectedMediaID: activePath.lazy.reversed().compactMap(\.detailsSelection).first?.identity
        .rawValue
    )
  }
}
