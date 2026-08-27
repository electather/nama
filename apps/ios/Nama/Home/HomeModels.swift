import Foundation

nonisolated struct HomeAuthorizationIdentity: Equatable, Hashable, Sendable {
  let endpoint: NamaEndpoint
  let accessTokenExpiresAt: Date
  let generation: UInt64

  init(
    endpoint: NamaEndpoint,
    accessTokenExpiresAt: Date,
    generation: UInt64
  ) {
    self.endpoint = endpoint
    self.accessTokenExpiresAt = accessTokenExpiresAt
    self.generation = generation
  }

  init?(
    currentEndpoint: NamaEndpoint,
    authorizationState: OAuthAuthorizationState,
    generation: UInt64
  ) {
    guard
      case .authorized(let authorization) = authorizationState,
      authorization.endpoint == currentEndpoint
    else {
      return nil
    }
    self.init(
      endpoint: authorization.endpoint,
      accessTokenExpiresAt: authorization.accessTokenExpiresAt,
      generation: generation
    )
  }
}

nonisolated struct HomeShelfIdentity: Equatable, Hashable, Sendable {
  let rawValue: String

  init(_ rawValue: String) {
    self.rawValue = rawValue
  }
}

nonisolated enum HomeShelfKind: Equatable, Sendable {
  case movies
  case shows
}

nonisolated struct HomeShelf: Equatable, Identifiable, Sendable {
  let identity: HomeShelfIdentity
  let title: String
  let kind: HomeShelfKind
  let items: [MediaSummary]

  var id: HomeShelfIdentity {
    identity
  }
}

nonisolated struct HomeSnapshot: Equatable, Sendable {
  let shelves: [HomeShelf]

  init(movies: HomeShelf?, shows: HomeShelf?) {
    shelves = [movies, shows].compactMap { shelf in
      guard let shelf, !shelf.items.isEmpty else {
        return nil
      }
      return shelf
    }
  }

  var movies: HomeShelf? {
    shelves.first { $0.kind == .movies }
  }

  var shows: HomeShelf? {
    shelves.first { $0.kind == .shows }
  }

  var isEmpty: Bool {
    shelves.isEmpty
  }
}

nonisolated enum HomeLoadingFailure: Error, Equatable, Sendable {
  case catalogNotReady(retryAfterSeconds: Int?)
  case authorizationUnavailable
  case networkUnavailable
  case namaUnavailable(requestID: String?)
  case incompatible
}

nonisolated enum HomeState: Equatable, Sendable {
  case loading
  case catalogNotReady(retryAfterSeconds: Int?)
  case empty
  case content(HomeSnapshot)
  case refreshing(HomeSnapshot)
  case refreshFailed(HomeSnapshot, HomeLoadingFailure)
  case failed(HomeLoadingFailure)
}

nonisolated protocol HomeLoading: Sendable {
  func load(for authorization: HomeAuthorizationIdentity) async throws -> HomeSnapshot
}
