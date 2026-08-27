import SwiftUI

struct MediaChildRow: View {
  @Environment(\.displayScale) private var displayScale
  @ScaledMetric(relativeTo: .body) private var artworkWidth = MediaChildLayout.artworkWidth

  let item: MediaSummary
  let childDidAppear: @MainActor (MediaIdentity) -> Void
  let artwork: MediaChildArtworkAccess

  var body: some View {
    NavigationLink(
      value: MediaDetailsSelection(
        identity: item.identity,
        kind: item.kind,
        title: item.title
      )
    ) {
      HStack(alignment: .top, spacing: MediaDetailsLayout.metadataSpacing) {
        MediaChildArtworkSurface(
          item: item,
          presentation: artwork.presentationState(item.identity).presentation,
          width: artworkWidth,
          height: artworkHeight
        )
        VStack(alignment: .leading, spacing: MediaDetailsLayout.creditDetailSpacing) {
          Text(item.title)
            .font(.headline)
            .multilineTextAlignment(.leading)
          if let position = item.episodePosition {
            Text("Season \(position.seasonNumber), Episode \(position.episodeNumber)")
              .font(.subheadline)
              .foregroundStyle(.secondary)
          }
          if let runtime = item.childRuntime {
            Text(runtime, format: .time(pattern: .hourMinute))
              .font(.subheadline)
              .foregroundStyle(.secondary)
          }
          if item.kind == .episode {
            MediaChildPlayabilityLabel(playability: item.playability)
          }
        }
        Spacer(minLength: 0)
      }
      .accessibilityElement(children: .combine)
    }
    .onAppear {
      artwork.didAppear(item, artworkSize)
      #if !os(tvOS)
        childDidAppear(item.identity)
      #endif
    }
    .onChange(of: artworkSize) { _, newSize in
      artwork.didAppear(item, newSize)
    }
    .onDisappear {
      artwork.didDisappear(item.identity)
    }
  }

  private var artworkHeight: CGFloat {
    item.kind == .season
      ? artworkWidth / MediaChildLayout.posterAspectRatio
      : artworkWidth / MediaChildLayout.thumbnailAspectRatio
  }

  private var artworkSize: ArtworkSizeBucket {
    item.kind == .episode
      ? .thumbnail(displayWidth: artworkWidth, scale: displayScale)
      : .poster(displayWidth: artworkWidth, scale: displayScale)
  }
}

private struct MediaChildArtworkSurface: View {
  let item: MediaSummary
  let presentation: HomeArtworkPresentation?
  let width: CGFloat
  let height: CGFloat

  var body: some View {
    RoundedRectangle(cornerRadius: MediaChildLayout.cornerRadius)
      .fill(.quaternary)
      .frame(width: width, height: height)
      .overlay {
        if let presentation {
          Image(decorative: presentation.image, scale: MediaDetailsLayout.imageScale)
            .resizable()
            .scaledToFill()
        } else {
          Image(systemName: item.kind.detailsSystemImage)
            .foregroundStyle(.secondary)
            .accessibilityHidden(true)
        }
      }
      .compositingGroup()
      .clipShape(.rect(cornerRadius: MediaChildLayout.cornerRadius))
  }
}

private struct MediaChildPlayabilityLabel: View {
  let playability: MediaPlayability

  var body: some View {
    switch playability {
    case .playable:
      Label("Playable", systemImage: "play.circle.fill")

    case .temporarilyUnavailable:
      Label("Temporarily unavailable", systemImage: "exclamationmark.circle")

    case .noAvailableSource, .unknown:
      Label("No playable source", systemImage: "nosign")
    }
  }
}

private enum MediaChildLayout {
  private static let posterHeightUnits: CGFloat = 3
  private static let posterWidthUnits: CGFloat = 2
  private static let thumbnailHeightUnits: CGFloat = 9
  private static let thumbnailWidthUnits: CGFloat = 16

  #if os(tvOS)
    static let artworkWidth: CGFloat = 160
  #else
    static let artworkWidth: CGFloat = 120
  #endif

  static let cornerRadius: CGFloat = 10

  static var posterAspectRatio: CGFloat {
    posterWidthUnits / posterHeightUnits
  }

  static var thumbnailAspectRatio: CGFloat {
    thumbnailWidthUnits / thumbnailHeightUnits
  }
}
