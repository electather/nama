import SwiftUI

struct HomeRefreshFailureView: View {
  let failure: HomeLoadingFailure
  let retry: @MainActor () -> Void
  let reauthorize: @MainActor () async -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      Label("Refresh failed", systemImage: "exclamationmark.triangle")
        .font(.headline)
      Text(failure.message)
      if case .catalogNotReady(let retryAfterSeconds) = failure {
        HomeRetryGuidance(retryAfterSeconds: retryAfterSeconds)
      }
      HomeFailureRecoveryButton(
        failure: failure,
        retry: retry,
        reauthorize: reauthorize
      )
    }
    .padding()
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(.quaternary, in: .rect(cornerRadius: 12))
  }
}

struct HomeRetryGuidance: View {
  let retryAfterSeconds: Int?

  var body: some View {
    if let retryAfterSeconds {
      Text("Try again in about \(retryAfterSeconds) seconds.")
    } else {
      Text("Try again shortly.")
    }
  }
}

struct HomeFailureView: View {
  let failure: HomeLoadingFailure
  let retry: @MainActor () -> Void
  let reauthorize: @MainActor () async -> Void

  var body: some View {
    ContentUnavailableView {
      Label("Home is unavailable", systemImage: "exclamationmark.triangle")
    } description: {
      VStack(spacing: 8) {
        Text(failure.message)
        if case .namaUnavailable(let requestID?) = failure {
          Text("Request ID: \(requestID)")
            .font(.caption)
        }
      }
    } actions: {
      HomeFailureRecoveryButton(
        failure: failure,
        retry: retry,
        reauthorize: reauthorize
      )
    }
  }
}

private struct HomeFailureRecoveryButton: View {
  let failure: HomeLoadingFailure
  let retry: @MainActor () -> Void
  let reauthorize: @MainActor () async -> Void

  var body: some View {
    if let title = failure.reauthorizationActionTitle {
      Button(title) {
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

private extension HomeLoadingFailure {
  var message: LocalizedStringKey {
    switch self {
    case .catalogNotReady:
      "Your library is being prepared."
    case .authorizationUnavailable:
      "Authorization is no longer available. Authorize again to continue."
    case .networkUnavailable:
      "Check this device’s connection, then try again."
    case .namaUnavailable:
      "Nama could not load Home. Try again."
    case .incompatible:
      "This app and Nama cannot load Home together. Check for updates."
    }
  }

  var reauthorizationActionTitle: LocalizedStringKey? {
    switch self {
    case .authorizationUnavailable:
      "Authorize Again"
    case .catalogNotReady, .networkUnavailable, .namaUnavailable, .incompatible:
      nil
    }
  }
}
