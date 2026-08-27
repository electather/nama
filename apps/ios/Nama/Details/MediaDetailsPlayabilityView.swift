import SwiftUI

struct MediaDetailsPlayabilityView: View {
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
      }
    }
  }

  @ViewBuilder
  private var playabilityContent: some View {
    switch playability {
    case .playable:
      Button("Play", systemImage: "play.fill", action: play)
        .buttonStyle(.borderedProminent)
        .controlSize(.extraLarge)

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
        }
      }

    case .noAvailableSource, .unknown:
      Label("No playable source", systemImage: "nosign")
        .font(.headline)
        .foregroundStyle(.secondary)
    }
  }
}
