import SwiftUI

struct LibraryInlineFailureView: View {
  let failure: LibraryLoadingFailure
  let actionTitle: LocalizedStringKey
  let action: @MainActor () -> Void
  let reauthorize: @MainActor () async -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: LibraryLayout.metadataSpacing) {
      Label(libraryFailureMessage(failure), systemImage: "exclamationmark.triangle")
      if failure == .authorizationUnavailable {
        Button("Authorize Again") {
          Task {
            await reauthorize()
          }
        }
      } else {
        Button(actionTitle, action: action)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding()
    .background(.quaternary, in: .rect(cornerRadius: LibraryLayout.posterCornerRadius))
  }
}

struct LibraryInitialFailureView: View {
  let failure: LibraryLoadingFailure
  let retry: @MainActor () -> Void
  let reauthorize: @MainActor () async -> Void

  var body: some View {
    ContentUnavailableView {
      Label("Library is unavailable", systemImage: "exclamationmark.triangle")
    } description: {
      Text(libraryFailureMessage(failure))
    } actions: {
      if failure == .authorizationUnavailable {
        Button("Authorize Again") {
          Task {
            await reauthorize()
          }
        }
        .buttonStyle(.borderedProminent)
      } else {
        Button("Retry", action: retry)
          .buttonStyle(.borderedProminent)
      }
    }
  }
}

func libraryFailureMessage(_ failure: LibraryLoadingFailure) -> LocalizedStringKey {
  switch failure {
  case .catalogNotReady:
    "Your library is still being prepared."

  case .pageTokenInvalid:
    "This page expired. Retry to continue from confirmed items."

  case .authorizationUnavailable:
    "Authorize again to browse your library."

  case .networkUnavailable:
    "Check this device’s connection and try again."

  case .namaUnavailable:
    "Nama could not complete the request. Try again."

  case .incompatible:
    "This version of Nama cannot read the Library response."
  }
}

func libraryCanRefresh(_ state: LibraryState) -> Bool {
  switch state {
  case .empty, .content, .refreshing, .refreshFailed, .loadingMore, .pageFailed:
    true

  case .loading, .catalogNotReady, .failed:
    false
  }
}

func libraryIsRefreshing(_ state: LibraryState) -> Bool {
  if case .refreshing = state {
    return true
  }
  return false
}
