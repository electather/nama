import SwiftUI

struct MovieDetailsRefreshFailureView: View {
  let failure: MovieDetailsFailure
  let retry: @MainActor () -> Void
  let reauthorize: @MainActor () async -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: MovieDetailsLayout.metadataSpacing) {
      Label("Refresh failed", systemImage: "exclamationmark.triangle")
        .font(.headline)
      Text(movieDetailsFailureMessage(failure))
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
        if case .namaUnavailable(let requestID?) = failure {
          Text("Request ID: \(requestID)")
            .font(.caption.monospaced())
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

private func movieDetailsFailureTitle(_ failure: MovieDetailsFailure) -> LocalizedStringKey {
  switch failure {
  case .notFound:
    "Movie not found"

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
