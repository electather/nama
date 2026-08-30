import SwiftUI

nonisolated func mediaDetailsFormattedList(_ values: [String], locale: Locale) -> String {
  values.formatted(.list(type: .and).locale(locale))
}

struct MediaDetailsContentView: View {
  let details: MediaDetails
  let childrenState: MediaChildrenState
  let isRefreshing: Bool
  let canRefresh: Bool
  let refreshFailure: MediaDetailsFailure?
  let refresh: @MainActor () -> Void
  let play: @MainActor () -> Void
  let loadMoreChildren: @MainActor () -> Void
  let childDidAppear: @MainActor (MediaIdentity) -> Void
  let reauthorize: @MainActor () async -> Void
  let artwork: MediaDetailsArtworkPresentationAccess
  let childArtwork: MediaChildArtworkAccess
  let creditArtwork: MediaCreditArtworkAccess

  var body: some View {
    ScrollView {
      MediaDetailsContentSections(
        details: details,
        childrenState: childrenState,
        isRefreshing: isRefreshing,
        canRefresh: canRefresh,
        refreshFailure: refreshFailure,
        refresh: refresh,
        play: play,
        loadMoreChildren: loadMoreChildren,
        childDidAppear: childDidAppear,
        reauthorize: reauthorize,
        artwork: artwork,
        childArtwork: childArtwork,
        creditArtwork: creditArtwork
      )
      .frame(maxWidth: MediaDetailsLayout.contentMaximumWidth, alignment: .leading)
      .padding(MediaDetailsLayout.contentPadding)
    }
  }
}

private struct MediaDetailsContentSections: View {
  let details: MediaDetails
  let childrenState: MediaChildrenState
  let isRefreshing: Bool
  let canRefresh: Bool
  let refreshFailure: MediaDetailsFailure?
  let refresh: @MainActor () -> Void
  let play: @MainActor () -> Void
  let loadMoreChildren: @MainActor () -> Void
  let childDidAppear: @MainActor (MediaIdentity) -> Void
  let reauthorize: @MainActor () async -> Void
  let artwork: MediaDetailsArtworkPresentationAccess
  let childArtwork: MediaChildArtworkAccess
  let creditArtwork: MediaCreditArtworkAccess

  var body: some View {
    VStack(alignment: .leading, spacing: MediaDetailsLayout.sectionSpacing) {
      MediaDetailsRefreshStatusView(
        isRefreshing: isRefreshing,
        failure: refreshFailure,
        retry: refresh,
        reauthorize: reauthorize
      )
      MediaDetailsHeroView(details: details, artwork: artwork)
      MediaDetailsPrimaryActionView(
        details: details,
        childrenState: childrenState,
        isRefreshing: isRefreshing,
        refreshFailure: refreshFailure,
        refresh: refresh,
        play: play,
        loadMoreChildren: loadMoreChildren,
        childDidAppear: childDidAppear,
        reauthorize: reauthorize,
        childArtwork: childArtwork
      )
      MediaDetailsSupportingContentView(details: details, creditArtwork: creditArtwork)
      #if os(tvOS)
        if canRefresh {
          Button("Refresh", systemImage: "arrow.clockwise", action: refresh)
            .buttonStyle(.bordered)
            .disabled(isRefreshing)
        }
      #endif
    }
  }
}

private struct MediaDetailsPrimaryActionView: View {
  let details: MediaDetails
  let childrenState: MediaChildrenState
  let isRefreshing: Bool
  let refreshFailure: MediaDetailsFailure?
  let refresh: @MainActor () -> Void
  let play: @MainActor () -> Void
  let loadMoreChildren: @MainActor () -> Void
  let childDidAppear: @MainActor (MediaIdentity) -> Void
  let reauthorize: @MainActor () async -> Void
  let childArtwork: MediaChildArtworkAccess

  @ViewBuilder
  var body: some View {
    switch details.kindDetails {
    case .movie, .episode:
      MediaDetailsPlayabilityView(
        playability: details.playability,
        sourcesSelection: details.sourcesSelection,
        isRefreshing: isRefreshing,
        canRetryUnavailableSource: mediaDetailsCanRetryUnavailableSource(after: refreshFailure),
        play: play,
        retry: refresh
      )

    case .show, .season:
      MediaDetailsChildrenView(
        parentKind: details.kindDetails.mediaKind,
        state: childrenState,
        loadMore: loadMoreChildren,
        childDidAppear: childDidAppear,
        reauthorize: reauthorize,
        artwork: childArtwork
      )
    }
  }
}

private struct MediaDetailsRefreshStatusView: View {
  let isRefreshing: Bool
  let failure: MediaDetailsFailure?
  let retry: @MainActor () -> Void
  let reauthorize: @MainActor () async -> Void

  @ViewBuilder
  var body: some View {
    if let failure {
      MediaDetailsRefreshFailureView(
        failure: failure,
        retry: retry,
        reauthorize: reauthorize
      )
    }
    if isRefreshing {
      ProgressView("Refreshing Details…")
    }
  }
}

private struct MediaDetailsHeroView: View {
  @Environment(\.horizontalSizeClass) private var horizontalSizeClass

  let details: MediaDetails
  let artwork: MediaDetailsArtworkPresentationAccess

  var body: some View {
    let systemImage = details.kindDetails.mediaKind.detailsSystemImage
    VStack(alignment: .leading, spacing: MediaDetailsLayout.heroSpacing) {
      MediaBackdropView(
        title: details.title,
        reference: details.preferredBackdropArtwork?.identity,
        presentation: artwork.presentation(.backdrop),
        systemImage: systemImage,
        artwork: artwork
      )
      detailsLayout {
        MediaPosterView(
          title: details.title,
          reference: details.preferredPosterArtwork?.identity,
          presentation: artwork.presentation(.poster),
          systemImage: systemImage,
          artwork: artwork
        )
        MediaDetailsIdentityView(details: details)
      }
    }
  }

  private var detailsLayout: AnyLayout {
    if horizontalSizeClass == .compact {
      AnyLayout(
        VStackLayout(
          alignment: .leading,
          spacing: MediaDetailsLayout.heroSpacing
        )
      )
    } else {
      AnyLayout(
        HStackLayout(
          alignment: .top,
          spacing: MediaDetailsLayout.heroSpacing
        )
      )
    }
  }
}

private struct MediaBackdropView: View {
  @Environment(\.displayScale) private var displayScale
  @State private var displayWidth = 0.0

  let title: String
  let reference: ArtworkIdentity?
  let presentation: HomeArtworkPresentation?
  let systemImage: String
  let artwork: MediaDetailsArtworkPresentationAccess

  var body: some View {
    MediaArtworkSurface(
      title: title,
      presentation: presentation,
      systemImage: systemImage
    )
    .aspectRatio(MediaDetailsLayout.backdropAspectRatio, contentMode: .fit)
    .onGeometryChange(for: CGFloat.self) { proxy in
      proxy.size.width
    } action: { width in
      displayWidth = width
      loadArtwork()
    }
    .onChange(of: displayScale) { _, _ in loadArtwork() }
    .onChange(of: reference) { _, _ in loadArtwork() }
    .onDisappear {
      artwork.didDisappear(.backdrop)
    }
  }

  private func loadArtwork() {
    guard displayWidth > 0 else {
      return
    }
    artwork.didAppear(
      .backdrop,
      .backdrop(displayWidth: displayWidth, scale: displayScale)
    )
  }
}

private struct MediaPosterView: View {
  @Environment(\.displayScale) private var displayScale
  @ScaledMetric(relativeTo: .title) private var posterWidth = MediaDetailsLayout.posterWidth

  let title: String
  let reference: ArtworkIdentity?
  let presentation: HomeArtworkPresentation?
  let systemImage: String
  let artwork: MediaDetailsArtworkPresentationAccess

  var body: some View {
    MediaArtworkSurface(
      title: title,
      presentation: presentation,
      systemImage: systemImage
    )
    .frame(
      width: posterWidth,
      height: posterWidth / MediaDetailsLayout.posterAspectRatio
    )
    .onAppear(perform: loadArtwork)
    .onChange(of: posterWidth) { _, _ in loadArtwork() }
    .onChange(of: displayScale) { _, _ in loadArtwork() }
    .onChange(of: reference) { _, _ in loadArtwork() }
    .onDisappear {
      artwork.didDisappear(.poster)
    }
  }

  private func loadArtwork() {
    artwork.didAppear(
      .poster,
      .poster(displayWidth: posterWidth, scale: displayScale)
    )
  }
}

private struct MediaArtworkSurface: View {
  let title: String
  let presentation: HomeArtworkPresentation?
  let systemImage: String

  var body: some View {
    ZStack {
      RoundedRectangle(cornerRadius: MediaDetailsLayout.artworkCornerRadius)
        .fill(.quaternary)
      if let presentation {
        Image(decorative: presentation.image, scale: MediaDetailsLayout.imageScale)
          .resizable()
          .scaledToFill()
      } else {
        VStack(spacing: MediaDetailsLayout.metadataSpacing) {
          Image(systemName: systemImage)
            .font(.title)
            .accessibilityHidden(true)
          Text(title)
            .font(.headline)
            .multilineTextAlignment(.center)
            .lineLimit(MediaDetailsLayout.artworkTitleLineLimit)
            .padding(.horizontal)
        }
        .foregroundStyle(.secondary)
      }
    }
    .compositingGroup()
    .clipShape(.rect(cornerRadius: MediaDetailsLayout.artworkCornerRadius))
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("Artwork for \(title)")
  }
}

private struct MediaDetailsIdentityView: View {
  let details: MediaDetails

  var body: some View {
    VStack(alignment: .leading, spacing: MediaDetailsLayout.metadataSpacing) {
      MediaDetailsParentNavigationView(parents: details.parents)
      Text(details.title)
        .font(.largeTitle.bold())
        .accessibilityAddTraits(.isHeader)
      MediaDetailsMetadataView(metadata: details.presentationMetadata)
    }
    .frame(maxWidth: MediaDetailsLayout.proseMaximumWidth, alignment: .leading)
  }
}

struct MediaDetailsDescriptionView: View {
  let tagline: String?
  let synopsis: String?

  var body: some View {
    if tagline != nil || synopsis != nil {
      VStack(alignment: .leading, spacing: MediaDetailsLayout.metadataSpacing) {
        if let tagline {
          Text(tagline)
            .font(.title3)
            .italic()
        }
        if let synopsis {
          Text("Synopsis")
            .font(.title2.bold())
            .accessibilityAddTraits(.isHeader)
          Text(synopsis)
            .font(.body)
        }
      }
      .frame(maxWidth: MediaDetailsLayout.proseMaximumWidth, alignment: .leading)
    }
  }
}

struct MediaDetailsSupportingMetadataView: View {
  @Environment(\.locale) private var locale

  let genres: [String]
  let studios: [String]

  var body: some View {
    if !genres.isEmpty || !studios.isEmpty {
      VStack(alignment: .leading, spacing: MediaDetailsLayout.metadataSpacing) {
        Text("About")
          .font(.title2.bold())
          .accessibilityAddTraits(.isHeader)
        if !genres.isEmpty {
          LabeledContent("Genres", value: mediaDetailsFormattedList(genres, locale: locale))
        }
        if !studios.isEmpty {
          LabeledContent("Studios", value: mediaDetailsFormattedList(studios, locale: locale))
        }
      }
      .frame(maxWidth: MediaDetailsLayout.proseMaximumWidth, alignment: .leading)
    }
  }
}
