import CoreGraphics
import Foundation
import Observation

nonisolated struct HomeArtworkHeader: Equatable, Sendable {
  let name: String
  let value: String
}

nonisolated struct HomeArtworkResolvedLocator: Equatable, Sendable {
  let url: String
  let headers: [HomeArtworkHeader]
  let allowedRedirectOrigins: [String]
  let refreshAt: Date
  let accessExpiresAt: Date?
  let width: UInt32?
  let height: UInt32?
}

nonisolated protocol HomeArtworkResolving: Sendable {
  func resolve(
    _ reference: ArtworkReference,
    size: ArtworkSizeBucket,
    authorization: HomeAuthorizationIdentity
  ) async throws -> HomeArtworkResolvedLocator
}

nonisolated struct HomeArtworkPresentation: @unchecked Sendable {
  let image: CGImage
}

@MainActor
@Observable
final class HomeArtworkPresentationState {
  private(set) var presentation: HomeArtworkPresentation?

  func replace(with presentation: HomeArtworkPresentation?) {
    self.presentation = presentation
  }
}

nonisolated protocol HomeArtworkLoading: Sendable {
  func authorizationDidChange(to authorization: HomeAuthorizationIdentity) async

  func image(
    for reference: ArtworkReference,
    size: ArtworkSizeBucket,
    authorization: HomeAuthorizationIdentity
  ) async -> HomeArtworkPresentation?
}
