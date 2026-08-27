import SwiftUI

enum MovieDetailsLayout {
  static let artworkCornerRadius: CGFloat = 16
  static let artworkTitleLineLimit = 3
  private static let backdropWidthUnits: CGFloat = 16
  private static let backdropHeightUnits: CGFloat = 9
  private static let posterWidthUnits: CGFloat = 2
  private static let posterHeightUnits: CGFloat = 3
  static let creditDetailSpacing: CGFloat = 4
  static let creditSpacing: CGFloat = 12
  static let heroSpacing: CGFloat = 24
  static let imageScale: CGFloat = 1
  static let metadataSpacing: CGFloat = 10
  static let proseMaximumWidth: CGFloat = 760
  static let sectionSpacing: CGFloat = 32

  #if os(tvOS)
    static let contentMaximumWidth: CGFloat = 900
    static let contentPadding: CGFloat = 64
    static let posterWidth: CGFloat = 260
  #else
    static let contentMaximumWidth: CGFloat = 1_200
    static let contentPadding: CGFloat = 24
    static let posterWidth: CGFloat = 190
  #endif

  static var backdropAspectRatio: CGFloat {
    backdropWidthUnits / backdropHeightUnits
  }

  static var posterAspectRatio: CGFloat {
    posterWidthUnits / posterHeightUnits
  }
}

struct MovieDetailsView: View {
  @Environment(\.scenePhase) private var scenePhase

  let feature: MovieDetailsFeature
  let selection: MovieDetailsSelection
  let authorization: HomeAuthorizationIdentity
  let emitPlayIntent: @MainActor (MoviePlayIntent) -> Void
  let reauthorize: @MainActor () async -> Void

  var body: some View {
    MovieDetailsPresentationView(
      state: feature.state,
      retry: feature.retry,
      refresh: feature.refresh,
      play: emitPlay,
      reauthorize: reauthorize,
      artwork: MovieDetailsArtworkPresentationAccess(
        presentation: feature.artworkPresentation,
        didAppear: feature.artworkDidAppear,
        didDisappear: feature.artworkDidDisappear
      )
    )
    .onAppear(perform: activateIfNeeded)
    .onChange(of: selection) { _, _ in
      activateIfNeeded()
    }
    .onChange(of: authorization) { _, _ in
      activateIfNeeded()
    }
    .onChange(of: scenePhase) { _, phase in
      if phase == .active {
        activateIfNeeded()
      } else {
        feature.deactivate(selection)
      }
    }
    .onDisappear {
      feature.deactivate(selection)
    }
  }

  private func activateIfNeeded() {
    guard scenePhase == .active else {
      return
    }
    feature.select(selection, authorization: authorization)
  }

  private func emitPlay() {
    guard let intent = feature.play() else {
      return
    }
    emitPlayIntent(intent)
  }
}

@MainActor
struct MovieDetailsArtworkPresentationAccess {
  let presentation: (MovieDetailsArtworkSlot) -> HomeArtworkPresentation?
  let didAppear: (MovieDetailsArtworkSlot, HomeArtworkSizeBucket) -> Void
  let didDisappear: (MovieDetailsArtworkSlot) -> Void

  static var empty: Self {
    Self(
      presentation: { _ in nil },
      didAppear: { _, _ in
        // Preview artwork access intentionally starts no loading work.
      },
      didDisappear: { _ in
        // Preview artwork access owns no work to cancel.
      }
    )
  }
}

struct MovieDetailsPresentationView: View {
  let state: MovieDetailsState
  let retry: @MainActor () -> Void
  let refresh: @MainActor () -> Void
  let play: @MainActor () -> Void
  let reauthorize: @MainActor () async -> Void
  let artwork: MovieDetailsArtworkPresentationAccess

  var body: some View {
    MovieDetailsStateContent(
      state: state,
      retry: retry,
      refresh: refresh,
      play: play,
      reauthorize: reauthorize,
      artwork: artwork
    )
    .navigationTitle("Movie Details")
    .toolbar {
      ToolbarItem(placement: .primaryAction) {
        if movieDetailsCanRefresh(state) {
          Button("Refresh", systemImage: "arrow.clockwise", action: refresh)
            .disabled(movieDetailsIsRefreshing(state))
        }
      }
    }
  }
}

private struct MovieDetailsStateContent: View {
  let state: MovieDetailsState
  let retry: @MainActor () -> Void
  let refresh: @MainActor () -> Void
  let play: @MainActor () -> Void
  let reauthorize: @MainActor () async -> Void
  let artwork: MovieDetailsArtworkPresentationAccess

  @ViewBuilder
  var body: some View {
    switch state {
    case .idle:
      MovieDetailsLoadingView(title: "Movie")

    case .loading(let selection):
      MovieDetailsLoadingView(title: selection.title)

    case .content(let details):
      MovieDetailsContentView(
        details: details,
        isRefreshing: false,
        refreshFailure: nil,
        refresh: refresh,
        play: play,
        reauthorize: reauthorize,
        artwork: artwork
      )

    case .refreshing(let details):
      MovieDetailsContentView(
        details: details,
        isRefreshing: true,
        refreshFailure: nil,
        refresh: refresh,
        play: play,
        reauthorize: reauthorize,
        artwork: artwork
      )

    case .refreshFailed(let details, let failure):
      MovieDetailsContentView(
        details: details,
        isRefreshing: false,
        refreshFailure: failure,
        refresh: refresh,
        play: play,
        reauthorize: reauthorize,
        artwork: artwork
      )

    case .failed(let selection, let failure):
      MovieDetailsFailureView(
        title: selection.title,
        failure: failure,
        retry: retry,
        reauthorize: reauthorize
      )
    }
  }
}

private struct MovieDetailsLoadingView: View {
  let title: String

  var body: some View {
    ScrollView {
      LazyVStack(alignment: .leading, spacing: MovieDetailsLayout.sectionSpacing) {
        RoundedRectangle(cornerRadius: MovieDetailsLayout.artworkCornerRadius)
          .fill(.quaternary)
          .aspectRatio(MovieDetailsLayout.backdropAspectRatio, contentMode: .fit)
        Text(title)
          .font(.largeTitle.bold())
          .unredacted()
        VStack(alignment: .leading, spacing: MovieDetailsLayout.metadataSpacing) {
          Text("Movie metadata loading")
          Text("Movie synopsis loading across several readable lines of content.")
          Text("Movie credits loading")
        }
        .redacted(reason: .placeholder)
      }
      .frame(maxWidth: MovieDetailsLayout.contentMaximumWidth, alignment: .leading)
      .padding(MovieDetailsLayout.contentPadding)
    }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("Loading details for \(title)")
    #if os(tvOS) || os(macOS)
      .focusable()
      .focusEffectDisabled()
    #endif
  }
}

func movieDetailsCanRefresh(_ state: MovieDetailsState) -> Bool {
  switch state {
  case .content, .refreshing:
    true

  case .refreshFailed(_, let failure):
    failure != .authorizationUnavailable

  case .idle, .loading, .failed:
    false
  }
}

private func movieDetailsIsRefreshing(_ state: MovieDetailsState) -> Bool {
  if case .refreshing = state {
    true
  } else {
    false
  }
}
