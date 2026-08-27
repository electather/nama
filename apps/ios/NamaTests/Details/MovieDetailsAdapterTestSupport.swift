import Foundation

@testable import Nama

actor SuspendedMovieDetailsTokenStore: OAuthTokenStoring {
  private var snapshot: OAuthTokenStoreSnapshot = .missing
  private var loadContinuation: CheckedContinuation<OAuthTokenStoreSnapshot, Never>?
  private(set) var loadCallCount = 0

  func load() async -> OAuthTokenStoreSnapshot {
    loadCallCount += 1
    return await withCheckedContinuation { continuation in
      loadContinuation = continuation
    }
  }

  func resolve(with newSnapshot: OAuthTokenStoreSnapshot) {
    snapshot = newSnapshot
    loadContinuation?.resume(returning: newSnapshot)
    loadContinuation = nil
  }

  func replace(with candidate: EndpointBoundOAuthTokenRecord) {
    snapshot = .record(candidate)
  }

  func restore(
    _ previous: EndpointBoundOAuthTokenRecord?,
    ifCurrent candidate: EndpointBoundOAuthTokenRecord
  ) {
    guard snapshot == .record(candidate) else {
      return
    }
    snapshot = previous.map(OAuthTokenStoreSnapshot.record) ?? .missing
  }

  func remove(ifCurrent record: EndpointBoundOAuthTokenRecord) {
    if snapshot == .record(record) {
      snapshot = .missing
    }
  }

  func quarantine(_ data: Data) {
    snapshot = .damaged(data)
  }
}
