import SwiftUI

struct LibrarySearchResultsView: View {
  let snapshot: LibrarySearchSnapshot
  let isRefreshing: Bool
  let isLoadingMore: Bool
  let refreshFailure: LibraryLoadingFailure?
  let pageFailure: LibraryLoadingFailure?
  let selectMedia: @MainActor (MediaDetailsSelection) -> Void
  let refresh: @MainActor () -> Void
  let loadMore: @MainActor () -> Void
  let retryPage: @MainActor () -> Void
  let itemDidAppear: @MainActor (MediaIdentity) -> Void
  let reauthorize: @MainActor () async -> Void
  let artwork: LibraryArtworkPresentationAccess

  var body: some View {
    ScrollView {
      LazyVStack(alignment: .leading, spacing: LibraryLayout.sectionSpacing) {
        if let refreshFailure {
          LibrarySearchInlineFailureView(
            failure: refreshFailure,
            action: refresh,
            reauthorize: reauthorize
          )
        }
        if isRefreshing {
          ProgressView("Refreshing…")
        }
        ForEach(snapshot.items) { item in
          LibrarySearchResultRow(
            item: item,
            select: selectMedia,
            didAppear: itemDidAppear,
            artwork: artwork
          )
        }
        LibrarySearchPageStatus(
          snapshot: snapshot,
          isLoading: isLoadingMore,
          failure: pageFailure,
          loadMore: loadMore,
          retry: retryPage,
          reauthorize: reauthorize
        )
      }
      .padding(LibraryLayout.contentPadding)
    }
  }
}

private struct LibrarySearchResultRow: View {
  @Environment(\.displayScale) private var displayScale
  @ScaledMetric(relativeTo: .body) private var artworkWidth = LibrarySearchLayout.artworkWidth

  let item: MediaSummary
  let select: @MainActor (MediaDetailsSelection) -> Void
  let didAppear: @MainActor (MediaIdentity) -> Void
  let artwork: LibraryArtworkPresentationAccess

  var body: some View {
    Button {
      select(homeDetailsSelection(for: item))
    } label: {
      HStack(alignment: .top, spacing: LibraryLayout.cardSpacing) {
        artworkSurface
        VStack(alignment: .leading, spacing: LibraryLayout.metadataSpacing) {
          Text(verbatim: item.title)
            .font(.headline)
            .multilineTextAlignment(.leading)
          Text(verbatim: librarySearchKindAndYear(item))
            .font(.subheadline)
            .foregroundStyle(.secondary)
          if let position = item.episodePosition {
            Text("Season \(position.seasonNumber), Episode \(position.episodeNumber)")
              .font(.subheadline)
              .foregroundStyle(.secondary)
          }
          LibrarySearchPlayabilityLabel(playability: item.playability)
        }
        Spacer(minLength: 0)
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .contentShape(.rect)
      .accessibilityElement(children: .combine)
    }
    .buttonStyle(.plain)
    .onAppear {
      artwork.didAppear(item.identity, artworkSize)
      #if !os(tvOS)
        didAppear(item.identity)
      #endif
    }
    .onChange(of: artworkSize) { _, newSize in
      artwork.didAppear(item.identity, newSize)
    }
    .onDisappear {
      artwork.didDisappear(item.identity)
    }
  }

  private var artworkSurface: some View {
    RoundedRectangle(cornerRadius: LibrarySearchLayout.cornerRadius)
      .fill(.quaternary)
      .frame(width: artworkWidth, height: artworkHeight)
      .overlay {
        if let presentation = artwork.presentationState(item.identity)?.presentation {
          Image(decorative: presentation.image, scale: 1)
            .resizable()
            .scaledToFill()
        } else {
          Image(systemName: item.kind.detailsSystemImage)
            .foregroundStyle(.secondary)
            .accessibilityHidden(true)
        }
      }
      .compositingGroup()
      .clipShape(.rect(cornerRadius: LibrarySearchLayout.cornerRadius))
  }

  private var artworkHeight: CGFloat {
    item.kind == .episode
      ? artworkWidth / LibrarySearchLayout.thumbnailAspectRatio
      : artworkWidth / LibrarySearchLayout.posterAspectRatio
  }

  private var artworkSize: ArtworkSizeBucket {
    item.kind == .episode
      ? .thumbnail(displayWidth: artworkWidth, scale: displayScale)
      : .poster(displayWidth: artworkWidth, scale: displayScale)
  }
}

private struct LibrarySearchPlayabilityLabel: View {
  let playability: MediaPlayability

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

private struct LibrarySearchPageStatus: View {
  let snapshot: LibrarySearchSnapshot
  let isLoading: Bool
  let failure: LibraryLoadingFailure?
  let loadMore: @MainActor () -> Void
  let retry: @MainActor () -> Void
  let reauthorize: @MainActor () async -> Void

  @ViewBuilder
  var body: some View {
    #if os(tvOS)
      Button(action: performPageAction) {
        if snapshot.isTerminal {
          Label("All results loaded", systemImage: "checkmark.circle")
        } else if isLoading {
          ProgressView()
        } else {
          Text(pageActionTitle)
        }
      }
      .id("library.search.load-more")
      .accessibilityLabel(snapshot.isTerminal ? "All results loaded" : pageActionTitle)
    #else
      if snapshot.isTerminal {
        Label("All results loaded", systemImage: "checkmark.circle")
          .foregroundStyle(.secondary)
          .frame(maxWidth: .infinity)
      } else if isLoading {
        ProgressView("Loading more…")
          .frame(maxWidth: .infinity)
      } else if let failure {
        LibrarySearchInlineFailureView(
          failure: failure,
          action: retry,
          reauthorize: reauthorize
        )
      }
    #endif
  }

  private var pageActionTitle: LocalizedStringKey {
    if isLoading {
      return "Loading more"
    }
    if failure == .authorizationUnavailable {
      return "Authorize Again"
    }
    return failure == nil ? "Load More" : "Try Again"
  }

  private func performPageAction() {
    guard !snapshot.isTerminal else {
      return
    }
    if failure == .authorizationUnavailable {
      Task {
        await reauthorize()
      }
    } else if failure == nil {
      loadMore()
    } else {
      retry()
    }
  }
}

private struct LibrarySearchInlineFailureView: View {
  let failure: LibraryLoadingFailure
  let action: @MainActor () -> Void
  let reauthorize: @MainActor () async -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: LibraryLayout.metadataSpacing) {
      Label(librarySearchFailureMessage(failure), systemImage: "exclamationmark.triangle")
      if failure == .authorizationUnavailable {
        Button("Authorize Again") {
          Task {
            await reauthorize()
          }
        }
      } else {
        Button("Try Again", action: action)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding()
    .background(.quaternary, in: .rect(cornerRadius: LibraryLayout.posterCornerRadius))
  }
}

struct LibrarySearchInitialFailureView: View {
  let failure: LibraryLoadingFailure
  let retry: @MainActor () -> Void
  let reauthorize: @MainActor () async -> Void

  var body: some View {
    ContentUnavailableView {
      Label("Search is unavailable", systemImage: "exclamationmark.triangle")
    } description: {
      Text(librarySearchFailureMessage(failure))
    } actions: {
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
}

func librarySearchCanRefresh(_ state: LibrarySearchState) -> Bool {
  switch state {
  case .content, .refreshing, .refreshFailed, .loadingMore, .pageFailed:
    true

  case .idle, .loading, .noResults, .failed:
    false
  }
}

func librarySearchIsRefreshing(_ state: LibrarySearchState) -> Bool {
  if case .refreshing = state {
    return true
  }
  return false
}

private func librarySearchFailureMessage(
  _ failure: LibraryLoadingFailure
) -> LocalizedStringKey {
  switch failure {
  case .catalogNotReady:
    "Your library is still being prepared."

  case .pageTokenInvalid:
    "This result page expired. Try again to continue from confirmed results."

  case .authorizationUnavailable:
    "Authorize again to search your library."

  case .networkUnavailable:
    "Check this device’s connection and try again."

  case .namaUnavailable:
    "Nama could not complete the search. Try again."

  case .incompatible:
    "This version of Nama cannot read the Search response."
  }
}

private func librarySearchKindAndYear(_ item: MediaSummary) -> String {
  let kind =
    switch item.kind {
    case .movie:
      "Movie"

    case .show:
      "Show"

    case .season:
      "Season"

    case .episode:
      "Episode"
    }
  guard let releaseYear = item.releaseYear else {
    return kind
  }
  return "\(kind) · \(releaseYear)"
}

private enum LibrarySearchLayout {
  private static let posterHeightUnits: CGFloat = 3
  private static let posterWidthUnits: CGFloat = 2
  private static let thumbnailHeightUnits: CGFloat = 9
  private static let thumbnailWidthUnits: CGFloat = 16

  #if os(tvOS)
    static let artworkWidth: CGFloat = 180
  #else
    static let artworkWidth: CGFloat = 120
  #endif

  static let cornerRadius: CGFloat = 10
  static let posterAspectRatio = posterWidthUnits / posterHeightUnits
  static let thumbnailAspectRatio = thumbnailWidthUnits / thumbnailHeightUnits
}
