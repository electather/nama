import SwiftUI

struct MediaDetailsPlayabilityView: View {
  #if os(tvOS)
    @FocusState private var focusedAction: MediaDetailsTelevisionFocusAction?
  #endif

  let playability: MediaPlayability
  let sourcesSelection: MediaSourcesSelection?
  let isRefreshing: Bool
  let canRetryUnavailableSource: Bool
  let play: @MainActor () -> Void
  let retry: @MainActor () -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: MediaDetailsLayout.metadataSpacing) {
      playabilityContent
      if let sourcesSelection {
        NavigationLink(value: sourcesSelection) {
          Label("Sources", systemImage: "rectangle.stack")
        }
        .buttonStyle(.bordered)
        #if os(tvOS)
          .focused($focusedAction, equals: .sources)
        #endif
      }
    }
    #if os(tvOS)
      .task(id: defaultFocusAction) {
        focusedAction = defaultFocusAction
      }
    #endif
  }

  @ViewBuilder
  private var playabilityContent: some View {
    switch playability {
    case .playable:
      Button("Play", systemImage: "play.fill", action: play)
        .buttonStyle(.borderedProminent)
        .controlSize(.extraLarge)
        #if os(tvOS)
          .focused($focusedAction, equals: .play)
        #endif

    case .temporarilyUnavailable:
      VStack(alignment: .leading, spacing: MediaDetailsLayout.metadataSpacing) {
        Label("Temporarily unavailable", systemImage: "exclamationmark.circle")
          .font(.headline)
        Text("The default source cannot be reached right now.")
          .foregroundStyle(.secondary)
        if canRetryUnavailableSource {
          Button("Retry", action: retry)
            .buttonStyle(.borderedProminent)
            .disabled(isRefreshing)
            #if os(tvOS)
              .focused($focusedAction, equals: .retry)
            #endif
        }
      }

    case .noAvailableSource, .unknown:
      Label("No playable source", systemImage: "nosign")
        .font(.headline)
        .foregroundStyle(.secondary)
    }
  }

  #if os(tvOS)
    private var defaultFocusAction: MediaDetailsTelevisionFocusAction? {
      mediaDetailsTelevisionFocusAction(
        playability: playability,
        hasSources: sourcesSelection != nil,
        retryIsEnabled: canRetryUnavailableSource && !isRefreshing
      )
    }
  #endif
}
