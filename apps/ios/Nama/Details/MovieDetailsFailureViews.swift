import SwiftUI

struct MovieDetailsCatalogNotReadyView: View {
  let title: String
  let retryAfterSeconds: Int?
  let retry: @MainActor () -> Void

  var body: some View {
    ContentUnavailableView {
      Label("Your library is being prepared", systemImage: "clock.arrow.circlepath")
    } description: {
      VStack(spacing: MovieDetailsLayout.metadataSpacing) {
        Text(title)
          .font(.headline)
        MovieDetailsRetryGuidance(retryAfterSeconds: retryAfterSeconds)
      }
    } actions: {
      Button("Retry", action: retry)
        .buttonStyle(.borderedProminent)
    }
  }
}
struct MovieDetailsRefreshFailureView: View {
  let failure: MovieDetailsFailure
  let retry: @MainActor () -> Void
  let reauthorize: @MainActor () async -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: MovieDetailsLayout.metadataSpacing) {
      Label("Refresh failed", systemImage: "exclamationmark.triangle")
        .font(.headline)
      Text(movieDetailsFailureMessage(failure))
      if let retryAfterSeconds = movieDetailsRetryAfterSeconds(failure) {
        MovieDetailsRetryGuidance(retryAfterSeconds: retryAfterSeconds)
      }
      MovieDetailsFailureRecoveryButton(
        failure: failure,
        retry: retry,
        reauthorize: reauthorize
      )
    }
    .padding()
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(.quaternary, in: .rect(cornerRadius: MovieDetailsLayout.artworkCornerRadius))
  }
}

struct MovieDetailsFailureView: View {
  let title: String
  let failure: MovieDetailsFailure
  let retry: @MainActor () -> Void
  let reauthorize: @MainActor () async -> Void

  var body: some View {
    ContentUnavailableView {
      Label(movieDetailsFailureTitle(failure), systemImage: movieDetailsFailureSymbol(failure))
    } description: {
      VStack(spacing: MovieDetailsLayout.metadataSpacing) {
        Text(title)
          .font(.headline)
        Text(movieDetailsFailureMessage(failure))
        if case .namaUnavailable(let requestID?, _) = failure {
          Text("Request ID: \(requestID)")
            .font(.caption.monospaced())
        }
        if let retryAfterSeconds = movieDetailsRetryAfterSeconds(failure) {
          MovieDetailsRetryGuidance(retryAfterSeconds: retryAfterSeconds)
        }
      }
    } actions: {
      MovieDetailsFailureRecoveryButton(
        failure: failure,
        retry: retry,
        reauthorize: reauthorize
      )
    }
  }
}

private struct MovieDetailsFailureRecoveryButton: View {
  let failure: MovieDetailsFailure
  let retry: @MainActor () -> Void
  let reauthorize: @MainActor () async -> Void

  var body: some View {
    if failure == .authorizationUnavailable {
      Button("Authorize Again") {
        Task {
          await reauthorize()
        }
      }
      .buttonStyle(.borderedProminent)
    } else {
      Button("Try Again", action: retry)
        .buttonStyle(.borderedProminent)
    }
  }
}

private struct MovieDetailsRetryGuidance: View {
  let retryAfterSeconds: Int?

  var body: some View {
    if let retryAfterSeconds {
      Text("Try again in about \(retryAfterSeconds) seconds.")
    } else {
      Text("Try again shortly.")
    }
  }
}

private func movieDetailsFailureTitle(_ failure: MovieDetailsFailure) -> LocalizedStringKey {
  switch failure {
  case .notFound:
    "Movie not found"

  case .catalogNotReady:
    "Library is being prepared"

  case .transportUnavailable, .namaUnavailable:
    "Details are unavailable"

  case .authorizationUnavailable:
    "Authorization required"

  case .incompatible:
    "Update required"
  }
}

private func movieDetailsFailureSymbol(_ failure: MovieDetailsFailure) -> String {
  switch failure {
  case .notFound:
    "film.stack"

  case .catalogNotReady:
    "clock.arrow.circlepath"

  case .transportUnavailable, .namaUnavailable:
    "exclamationmark.triangle"

  case .authorizationUnavailable:
    "person.crop.circle.badge.exclamationmark"

  case .incompatible:
    "arrow.trianglehead.2.clockwise.rotate.90"
  }
}

private func movieDetailsFailureMessage(_ failure: MovieDetailsFailure) -> LocalizedStringKey {
  switch failure {
  case .notFound:
    "This Movie is no longer available in your library."

  case .catalogNotReady:
    "Movie Details will be available after Nama finishes preparing your library."

  case .transportUnavailable:
    "Check this device’s connection, then try again."

  case .authorizationUnavailable:
    "Authorization is no longer available. Authorize again to continue."

  case .incompatible:
    "This app and Nama cannot load Movie Details together. Check for updates."

  case .namaUnavailable:
    "Nama could not load Movie Details. Try again."
  }
}

private func movieDetailsRetryAfterSeconds(_ failure: MovieDetailsFailure) -> Int? {
  switch failure {
  case .catalogNotReady(let retryAfterSeconds):
    retryAfterSeconds

  case .namaUnavailable(_, let retryAfterSeconds):
    retryAfterSeconds

  case .notFound, .transportUnavailable, .authorizationUnavailable, .incompatible:
    nil
  }
}
