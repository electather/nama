import SwiftUI

private enum HomeArtworkLayout {
  static let shelfSpacing: CGFloat = 12
  static let itemSpacing: CGFloat = 16
  static let cardWidth: CGFloat = 148
  static let cardSpacing: CGFloat = 8
  static let cornerRadius: CGFloat = 12
  static let imageScale: CGFloat = 1
  static let posterHeightNumerator: CGFloat = 3
  static let posterHeightDenominator: CGFloat = 2
  static let titleLineLimit = 3
  static let metadataSpacing: CGFloat = 6
}

@MainActor
struct HomeArtworkPresentationAccess {
  let presentationState: (HomeMediaIdentity) -> HomeArtworkPresentationState?
  let didAppear: (HomeMediaIdentity, HomeShelfIdentity, HomeArtworkSizeBucket) -> Void
  let didDisappear: (HomeMediaIdentity, HomeShelfIdentity) -> Void

  static var empty: Self {
    Self(
      presentationState: { _ in nil },
      didAppear: { _, _, _ in
        // Preview presentations do not schedule artwork.
      },
      didDisappear: { _, _ in
        // Preview presentations do not schedule artwork.
      }
    )
  }
}

struct HomeShelfView: View {
  let shelf: HomeShelf
  let artwork: HomeArtworkPresentationAccess

  var body: some View {
    VStack(alignment: .leading, spacing: HomeArtworkLayout.shelfSpacing) {
      Text(verbatim: shelf.title)
        .font(.title2.bold())
      ScrollView(.horizontal) {
        LazyHStack(alignment: .top, spacing: HomeArtworkLayout.itemSpacing) {
          ForEach(shelf.items) { item in
            HomeMediaCard(
              item: item,
              shelf: shelf.identity,
              artwork: artwork
            )
          }
        }
      }
      .scrollIndicators(.hidden)
    }
  }
}

private struct HomeMediaCard: View {
  @Environment(\.displayScale) private var displayScale
  @ScaledMetric(relativeTo: .body) private var cardWidth = HomeArtworkLayout.cardWidth

  let item: HomeMediaSummary
  let shelf: HomeShelfIdentity
  let artwork: HomeArtworkPresentationAccess

  var body: some View {
    VStack(alignment: .leading, spacing: HomeArtworkLayout.cardSpacing) {
      HomePosterView(
        item: item,
        artwork: artwork.presentationState(item.identity)?.presentation,
        cardWidth: cardWidth
      )
      Text(verbatim: item.title)
        .font(.headline)
        .lineLimit(HomeArtworkLayout.titleLineLimit, reservesSpace: true)
      HStack(spacing: HomeArtworkLayout.metadataSpacing) {
        if let releaseYear = item.releaseYear {
          Text(releaseYear, format: .number.grouping(.never))
        }
        if let label = item.defaultSource?.label {
          Text(verbatim: label)
            .lineLimit(1)
        }
      }
      .font(.subheadline)
      .foregroundStyle(.secondary)
      HomePlayabilityLabel(playability: item.playability)
    }
    .frame(width: cardWidth, alignment: .leading)
    .accessibilityElement(children: .combine)
    .onAppear {
      artwork.didAppear(item.identity, shelf, artworkSize)
    }
    .onChange(of: artworkSize) { _, newSize in
      artwork.didAppear(item.identity, shelf, newSize)
    }
    .onDisappear {
      artwork.didDisappear(item.identity, shelf)
    }
  }

  private var artworkSize: HomeArtworkSizeBucket {
    .poster(displayWidth: cardWidth, scale: displayScale)
  }
}

private struct HomePosterView: View {
  let item: HomeMediaSummary
  let artwork: HomeArtworkPresentation?
  let cardWidth: CGFloat

  var body: some View {
    ZStack {
      RoundedRectangle(cornerRadius: HomeArtworkLayout.cornerRadius)
        .fill(.quaternary)
      if let artwork {
        Image(decorative: artwork.image, scale: HomeArtworkLayout.imageScale)
          .resizable()
          .scaledToFill()
      } else {
        Image(systemName: item.kind == .movie ? "film" : "tv")
          .font(.title)
          .foregroundStyle(.secondary)
          .accessibilityHidden(true)
      }
    }
    .frame(
      width: cardWidth,
      height: cardWidth * HomeArtworkLayout.posterHeightNumerator
        / HomeArtworkLayout.posterHeightDenominator
    )
    .clipShape(.rect(cornerRadius: HomeArtworkLayout.cornerRadius))
  }
}

private struct HomePlayabilityLabel: View {
  let playability: HomePlayability

  var body: some View {
    switch playability {
    case .playable:
      Label("Playable", systemImage: "play.circle.fill")
        .foregroundStyle(.secondary)

    case .temporarilyUnavailable:
      Label("Temporarily unavailable", systemImage: "exclamationmark.circle")
        .foregroundStyle(.secondary)

    case .noAvailableSource, .unknown:
      Label("No playable source", systemImage: "nosign")
        .foregroundStyle(.secondary)
    }
  }
}
