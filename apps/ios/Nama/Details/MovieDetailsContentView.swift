import SwiftUI

struct MovieDetailsContentView: View {
  let details: MovieDetails
  let isRefreshing: Bool
  let refreshFailure: MovieDetailsFailure?
  let refresh: @MainActor () -> Void
  let play: @MainActor () -> Void
  let reauthorize: @MainActor () async -> Void
  let artwork: MovieDetailsArtworkPresentationAccess

  var body: some View {
    ScrollView {
      MovieDetailsContentSections(
        details: details,
        isRefreshing: isRefreshing,
        refreshFailure: refreshFailure,
        refresh: refresh,
        play: play,
        reauthorize: reauthorize,
        artwork: artwork
      )
      .frame(maxWidth: MovieDetailsLayout.contentMaximumWidth, alignment: .leading)
      .padding(MovieDetailsLayout.contentPadding)
    }
  }
}

private struct MovieDetailsContentSections: View {
  let details: MovieDetails
  let isRefreshing: Bool
  let refreshFailure: MovieDetailsFailure?
  let refresh: @MainActor () -> Void
  let play: @MainActor () -> Void
  let reauthorize: @MainActor () async -> Void
  let artwork: MovieDetailsArtworkPresentationAccess

  var body: some View {
    LazyVStack(alignment: .leading, spacing: MovieDetailsLayout.sectionSpacing) {
      MovieDetailsRefreshStatusView(
        isRefreshing: isRefreshing,
        failure: refreshFailure,
        retry: refresh,
        reauthorize: reauthorize
      )
      MovieDetailsHeroView(details: details, artwork: artwork)
      MovieDetailsPlayabilityView(
        playability: details.playability,
        isRefreshing: isRefreshing,
        play: play,
        retry: refresh
      )
      MovieDetailsDescriptionView(
        tagline: details.tagline,
        synopsis: details.synopsis
      )
      MovieDetailsSupportingMetadataView(
        genres: details.genres,
        studios: details.studios
      )
      MovieDetailsCreditsView(
        directors: details.directors,
        writers: details.writers,
        initialCast: details.initialCast,
        allCredits: details.credits
      )
    }
  }
}

private struct MovieDetailsRefreshStatusView: View {
  let isRefreshing: Bool
  let failure: MovieDetailsFailure?
  let retry: @MainActor () -> Void
  let reauthorize: @MainActor () async -> Void

  @ViewBuilder
  var body: some View {
    if let failure {
      MovieDetailsRefreshFailureView(
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

private struct MovieDetailsHeroView: View {
  @Environment(\.horizontalSizeClass) private var horizontalSizeClass

  let details: MovieDetails
  let artwork: MovieDetailsArtworkPresentationAccess

  var body: some View {
    VStack(alignment: .leading, spacing: MovieDetailsLayout.heroSpacing) {
      MovieBackdropView(
        title: details.title,
        reference: details.preferredBackdropArtwork?.identity,
        presentation: artwork.presentation(.backdrop),
        artwork: artwork
      )
      detailsLayout {
        MoviePosterView(
          title: details.title,
          reference: details.preferredPosterArtwork?.identity,
          presentation: artwork.presentation(.poster),
          artwork: artwork
        )
        MovieDetailsIdentityView(details: details)
      }
    }
  }

  private var detailsLayout: AnyLayout {
    if horizontalSizeClass == .compact {
      AnyLayout(
        VStackLayout(
          alignment: .leading,
          spacing: MovieDetailsLayout.heroSpacing
        )
      )
    } else {
      AnyLayout(
        HStackLayout(
          alignment: .top,
          spacing: MovieDetailsLayout.heroSpacing
        )
      )
    }
  }
}

private struct MovieBackdropView: View {
  @Environment(\.displayScale) private var displayScale
  @State private var displayWidth = 0.0

  let title: String
  let reference: HomeArtworkIdentity?
  let presentation: HomeArtworkPresentation?
  let artwork: MovieDetailsArtworkPresentationAccess

  var body: some View {
    MovieArtworkSurface(
      title: title,
      presentation: presentation,
      systemImage: "film"
    )
    .aspectRatio(MovieDetailsLayout.backdropAspectRatio, contentMode: .fit)
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

private struct MoviePosterView: View {
  @Environment(\.displayScale) private var displayScale
  @ScaledMetric(relativeTo: .title) private var posterWidth = MovieDetailsLayout.posterWidth

  let title: String
  let reference: HomeArtworkIdentity?
  let presentation: HomeArtworkPresentation?
  let artwork: MovieDetailsArtworkPresentationAccess

  var body: some View {
    MovieArtworkSurface(
      title: title,
      presentation: presentation,
      systemImage: "film"
    )
    .frame(
      width: posterWidth,
      height: posterWidth / MovieDetailsLayout.posterAspectRatio
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

private struct MovieArtworkSurface: View {
  let title: String
  let presentation: HomeArtworkPresentation?
  let systemImage: String

  var body: some View {
    ZStack {
      RoundedRectangle(cornerRadius: MovieDetailsLayout.artworkCornerRadius)
        .fill(.quaternary)
      if let presentation {
        Image(decorative: presentation.image, scale: MovieDetailsLayout.imageScale)
          .resizable()
          .scaledToFill()
      } else {
        VStack(spacing: MovieDetailsLayout.metadataSpacing) {
          Image(systemName: systemImage)
            .font(.title)
            .accessibilityHidden(true)
          Text(title)
            .font(.headline)
            .multilineTextAlignment(.center)
            .lineLimit(MovieDetailsLayout.artworkTitleLineLimit)
            .padding(.horizontal)
        }
        .foregroundStyle(.secondary)
      }
    }
    .compositingGroup()
    .clipShape(.rect(cornerRadius: MovieDetailsLayout.artworkCornerRadius))
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("Artwork for \(title)")
  }
}

private struct MovieDetailsIdentityView: View {
  let details: MovieDetails

  var body: some View {
    VStack(alignment: .leading, spacing: MovieDetailsLayout.metadataSpacing) {
      Text(details.title)
        .font(.largeTitle.bold())
        .accessibilityAddTraits(.isHeader)
      MovieDetailsConciseMetadataView(
        releaseYear: details.releaseYear,
        runtime: details.runtime,
        contentRating: details.contentRating,
        primaryGenre: details.primaryGenre
      )
    }
    .frame(maxWidth: MovieDetailsLayout.proseMaximumWidth, alignment: .leading)
  }
}

private struct MovieDetailsConciseMetadataView: View {
  let releaseYear: UInt32?
  let runtime: Duration?
  let contentRating: String?
  let primaryGenre: String?

  var body: some View {
    ViewThatFits(in: .horizontal) {
      HStack(spacing: MovieDetailsLayout.metadataSpacing) {
        metadataValues
      }
      VStack(alignment: .leading, spacing: MovieDetailsLayout.metadataSpacing) {
        metadataValues
      }
    }
    .font(.headline)
    .foregroundStyle(.secondary)
  }

  @ViewBuilder
  private var metadataValues: some View {
    if let releaseYear {
      Text(releaseYear, format: .number.grouping(.never))
    }
    if let runtime {
      Text(runtime, format: .time(pattern: .hourMinute))
    }
    if let contentRating {
      Text(contentRating)
    }
    if let primaryGenre {
      Text(primaryGenre)
    }
  }
}

private struct MovieDetailsPlayabilityView: View {
  let playability: HomePlayability
  let isRefreshing: Bool
  let play: @MainActor () -> Void
  let retry: @MainActor () -> Void

  var body: some View {
    switch playability {
    case .playable:
      Button("Play", systemImage: "play.fill", action: play)
        .buttonStyle(.borderedProminent)
        .controlSize(.extraLarge)

    case .temporarilyUnavailable:
      VStack(alignment: .leading, spacing: MovieDetailsLayout.metadataSpacing) {
        Label("Temporarily unavailable", systemImage: "exclamationmark.circle")
          .font(.headline)
        Text("The default source cannot be reached right now.")
          .foregroundStyle(.secondary)
        Button("Retry", action: retry)
          .buttonStyle(.borderedProminent)
          .disabled(isRefreshing)
      }

    case .noAvailableSource, .unknown:
      Label("No playable source", systemImage: "nosign")
        .font(.headline)
        .foregroundStyle(.secondary)
    }
  }
}

private struct MovieDetailsDescriptionView: View {
  let tagline: String?
  let synopsis: String?

  var body: some View {
    if tagline != nil || synopsis != nil {
      VStack(alignment: .leading, spacing: MovieDetailsLayout.metadataSpacing) {
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
      .frame(maxWidth: MovieDetailsLayout.proseMaximumWidth, alignment: .leading)
    }
  }
}

private struct MovieDetailsSupportingMetadataView: View {
  let genres: [String]
  let studios: [String]

  var body: some View {
    if !genres.isEmpty || !studios.isEmpty {
      VStack(alignment: .leading, spacing: MovieDetailsLayout.metadataSpacing) {
        Text("About")
          .font(.title2.bold())
          .accessibilityAddTraits(.isHeader)
        if !genres.isEmpty {
          LabeledContent("Genres", value: genres.joined(separator: ", "))
        }
        if !studios.isEmpty {
          LabeledContent("Studios", value: studios.joined(separator: ", "))
        }
      }
      .frame(maxWidth: MovieDetailsLayout.proseMaximumWidth, alignment: .leading)
    }
  }
}
