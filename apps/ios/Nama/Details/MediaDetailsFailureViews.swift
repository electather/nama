import SwiftUI

nonisolated func mediaDetailsCanRetryUnavailableSource(
  after failure: MediaDetailsFailure?
) -> Bool {
  failure != .authorizationUnavailable
}

struct MediaDetailsRefreshFailureView: View {
  let failure: MediaDetailsFailure
  let retry: @MainActor () -> Void
  let reauthorize: @MainActor () async -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: MediaDetailsLayout.metadataSpacing) {
      Label("Refresh failed", systemImage: "exclamationmark.triangle")
        .font(.headline)
      Text(mediaDetailsFailureMessage(failure))
      MediaDetailsRetryGuidance(failure: failure)
      MediaDetailsFailureRecoveryButton(
        failure: failure,
        retry: retry,
        reauthorize: reauthorize,
        requestsTelevisionFocus: true
      )
    }
    .padding()
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(.quaternary, in: .rect(cornerRadius: MediaDetailsLayout.artworkCornerRadius))
  }
}

struct MediaDetailsFailureView: View {
  let title: String?
  let failure: MediaDetailsFailure
  let retry: @MainActor () -> Void
  let reauthorize: @MainActor () async -> Void

  var body: some View {
    ContentUnavailableView {
      Label(mediaDetailsFailureTitle(failure), systemImage: mediaDetailsFailureSymbol(failure))
    } description: {
      VStack(spacing: MediaDetailsLayout.metadataSpacing) {
        Group {
          if let title {
            Text(verbatim: title)
          } else {
            Text("Details")
          }
        }
        .font(.headline)
        Text(mediaDetailsFailureMessage(failure))
        MediaDetailsRetryGuidance(failure: failure)
        if case .namaUnavailable(let requestID?, _) = failure {
          Text("Request ID: \(requestID)")
            .font(.caption.monospaced())
        }
      }
    } actions: {
      MediaDetailsFailureRecoveryButton(
        failure: failure,
        retry: retry,
        reauthorize: reauthorize,
        requestsTelevisionFocus: false
      )
    }
  }
}

struct MediaDetailsRetryGuidance: View {
  let failure: MediaDetailsFailure

  @ViewBuilder
  var body: some View {
    switch failure {
    case .catalogNotReady(let retryAfterSeconds), .namaUnavailable(_, let retryAfterSeconds):
      if let retryAfterSeconds {
        Text("Try again in about \(retryAfterSeconds) seconds.")
      } else {
        Text("Try again shortly.")
      }

    case .notFound, .pageTokenInvalid, .transportUnavailable, .authorizationUnavailable,
      .incompatible:
      EmptyView()
    }
  }
}

private struct MediaDetailsFailureRecoveryButton: View {
  #if os(tvOS)
    @FocusState private var focusedAction: MediaDetailsTelevisionFocusAction?
  #endif

  let failure: MediaDetailsFailure
  let retry: @MainActor () -> Void
  let reauthorize: @MainActor () async -> Void
  let requestsTelevisionFocus: Bool

  var body: some View {
    Group {
      if failure == .authorizationUnavailable {
        Button("Authorize Again") {
          Task {
            await reauthorize()
          }
        }
        .buttonStyle(.borderedProminent)
        #if os(tvOS)
          .focused($focusedAction, equals: .refreshRecovery)
        #endif
      } else {
        Button("Try Again", action: retry)
          .buttonStyle(.borderedProminent)
          #if os(tvOS)
            .focused($focusedAction, equals: .refreshRecovery)
          #endif
      }
    }
    #if os(tvOS)
      .task(id: failure) {
        if requestsTelevisionFocus {
          focusedAction = .refreshRecovery
        }
      }
    #endif
  }
}

private func mediaDetailsFailureTitle(_ failure: MediaDetailsFailure) -> LocalizedStringKey {
  switch failure {
  case .notFound:
    "Item not found"

  case .catalogNotReady:
    "Library is being prepared"

  case .pageTokenInvalid:
    "Page expired"

  case .transportUnavailable, .namaUnavailable:
    "Details are unavailable"

  case .authorizationUnavailable:
    "Authorization required"

  case .incompatible:
    "Update required"
  }
}

private func mediaDetailsFailureSymbol(_ failure: MediaDetailsFailure) -> String {
  switch failure {
  case .notFound:
    "rectangle.stack"

  case .catalogNotReady:
    "clock"

  case .pageTokenInvalid:
    "arrow.clockwise"

  case .transportUnavailable, .namaUnavailable:
    "exclamationmark.triangle"

  case .authorizationUnavailable:
    "person.crop.circle.badge.exclamationmark"

  case .incompatible:
    "arrow.trianglehead.2.clockwise.rotate.90"
  }
}

private func mediaDetailsFailureMessage(_ failure: MediaDetailsFailure) -> LocalizedStringKey {
  switch failure {
  case .notFound:
    "This item is no longer available in your library."

  case .catalogNotReady:
    "Your library is being prepared."

  case .pageTokenInvalid:
    "This page expired. Try loading it again."

  case .transportUnavailable:
    "Check this device’s connection, then try again."

  case .authorizationUnavailable:
    "Authorization is no longer available. Authorize again to continue."

  case .incompatible:
    "This app and Nama cannot load Details together. Check for updates."

  case .namaUnavailable:
    "Nama could not load Details. Try again."
  }
}
