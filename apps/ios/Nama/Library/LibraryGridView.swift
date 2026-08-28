import SwiftUI

private func libraryGridColumns() -> [GridItem] {
  let column = GridItem(
    .adaptive(
      minimum: LibraryLayout.cardMinimumWidth,
      maximum: LibraryLayout.cardMaximumWidth
    ),
    spacing: LibraryLayout.cardSpacing,
    alignment: .top
  )
  return [column]
}

struct LibraryContentView: View {
  let snapshot: LibrarySnapshot
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

  private let columns = libraryGridColumns()

  var body: some View {
    ScrollView {
      LazyVStack(alignment: .leading, spacing: LibraryLayout.sectionSpacing) {
        refreshStatus
        mediaGrid
        LibraryPageStatus(
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

  @ViewBuilder
  private var refreshStatus: some View {
    if let refreshFailure {
      LibraryInlineFailureView(
        failure: refreshFailure,
        actionTitle: "Try Again",
        action: refresh,
        reauthorize: reauthorize
      )
    }
    if isRefreshing {
      ProgressView("Refreshing…")
    }
  }

  private var mediaGrid: some View {
    LazyVGrid(columns: columns, spacing: LibraryLayout.gridSpacing) {
      ForEach(snapshot.items) { item in
        LibraryMediaCard(
          item: item,
          select: selectMedia,
          didAppear: itemDidAppear,
          artwork: artwork
        )
      }
    }
  }
}

private struct LibraryMediaCard: View {
  @Environment(\.displayScale) private var displayScale
  @ScaledMetric(relativeTo: .body) private var requestedArtworkWidth =
    LibraryLayout.cardMaximumWidth

  let item: MediaSummary
  let select: @MainActor (MediaDetailsSelection) -> Void
  let didAppear: @MainActor (MediaIdentity) -> Void
  let artwork: LibraryArtworkPresentationAccess

  var body: some View {
    Button {
      select(homeDetailsSelection(for: item))
    } label: {
      VStack(alignment: .leading, spacing: LibraryLayout.metadataSpacing) {
        LibraryPoster(
          item: item,
          presentation: artwork.presentationState(item.identity)?.presentation
        )
        Text(verbatim: item.title)
          .font(.headline)
          .multilineTextAlignment(.leading)
          .lineLimit(LibraryLayout.titleLineLimit, reservesSpace: true)
        if let releaseYear = item.releaseYear {
          Text(releaseYear, format: .number.grouping(.never))
            .font(.subheadline)
            .foregroundStyle(.secondary)
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .contentShape(.rect)
    }
    .buttonStyle(.plain)
    .accessibilityLabel(item.title)
    .onAppear {
      artwork.didAppear(item.identity, artworkSize)
      requestAnotherPageIfNeeded()
    }
    .onChange(of: artworkSize) { _, newSize in
      artwork.didAppear(item.identity, newSize)
    }
    .onDisappear {
      artwork.didDisappear(item.identity)
    }
  }

  private var artworkSize: ArtworkSizeBucket {
    .poster(displayWidth: requestedArtworkWidth, scale: displayScale)
  }

  private func requestAnotherPageIfNeeded() {
    #if !os(tvOS)
      didAppear(item.identity)
    #endif
  }
}

private struct LibraryPoster: View {
  let item: MediaSummary
  let presentation: HomeArtworkPresentation?

  var body: some View {
    ZStack {
      RoundedRectangle(cornerRadius: LibraryLayout.posterCornerRadius)
        .fill(.quaternary)
      if let presentation {
        Image(decorative: presentation.image, scale: 1)
          .resizable()
          .scaledToFill()
      } else {
        Image(systemName: item.kind == .movie ? "film" : "tv")
          .font(.title)
          .foregroundStyle(.secondary)
          .accessibilityHidden(true)
      }
    }
    .aspectRatio(LibraryLayout.posterAspectRatio, contentMode: .fit)
    .clipShape(.rect(cornerRadius: LibraryLayout.posterCornerRadius))
  }
}

private struct LibraryPageStatus: View {
  let snapshot: LibrarySnapshot
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
          Label(terminalTitle, systemImage: "checkmark.circle")
        } else if isLoading {
          ProgressView()
        } else {
          Text(pageActionTitle)
        }
      }
      .id("library.load-more")
      .accessibilityLabel(snapshot.isTerminal ? terminalTitle : pageActionTitle)
    #else
      if snapshot.isTerminal {
        Label(terminalTitle, systemImage: "checkmark.circle")
          .foregroundStyle(.secondary)
          .frame(maxWidth: .infinity)
      } else if isLoading {
        ProgressView("Loading more…")
          .frame(maxWidth: .infinity)
      } else if let failure {
        LibraryInlineFailureView(
          failure: failure,
          actionTitle: "Retry Page",
          action: retry,
          reauthorize: reauthorize
        )
      }
    #endif
  }

  private var terminalTitle: LocalizedStringKey {
    snapshot.query.kind == .movies ? "All movies loaded" : "All shows loaded"
  }

  private var pageActionTitle: LocalizedStringKey {
    if isLoading {
      return "Loading more"
    }
    if failure == .authorizationUnavailable {
      return "Authorize Again"
    }
    return failure == nil ? "Load More" : "Retry Page"
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

struct LibraryLoadingView: View {
  private let columns = libraryGridColumns()

  var body: some View {
    ScrollView {
      LazyVGrid(columns: columns, spacing: LibraryLayout.gridSpacing) {
        ForEach(0..<LibraryLayout.loadingItemCount, id: \.self) { _ in
          VStack(alignment: .leading, spacing: LibraryLayout.metadataSpacing) {
            RoundedRectangle(cornerRadius: LibraryLayout.posterCornerRadius)
              .fill(.quaternary)
              .aspectRatio(LibraryLayout.posterAspectRatio, contentMode: .fit)
            Text("Loading title")
              .font(.headline)
            Text("Loading year")
              .font(.subheadline)
          }
          .redacted(reason: .placeholder)
        }
      }
      .padding(LibraryLayout.contentPadding)
    }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("Loading Library")
  }
}
