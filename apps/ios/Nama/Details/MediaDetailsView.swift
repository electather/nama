import SwiftUI

enum MediaDetailsLayout {
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

struct MediaDetailsView: View {
  @Environment(\.scenePhase) private var scenePhase

  #if os(tvOS)
    @Environment(\.dismiss) private var dismiss
  #endif

  let feature: MediaDetailsFeature
  let selection: MediaDetailsSelection
  let authorization: HomeAuthorizationIdentity
  let emitPlayIntent: @MainActor (MediaPlayIntent) -> Void
  let reauthorize: @MainActor () async -> Void

  var body: some View {
    MediaDetailsPresentationView(
      state: feature.state,
      idleTitle: selection.title,
      childrenState: feature.childrenState,
      retry: feature.retry,
      refresh: feature.refresh,
      play: emitPlay,
      loadMoreChildren: feature.loadMoreChildren,
      childDidAppear: feature.childDidAppear,
      reauthorize: reauthorize,
      artwork: MediaDetailsArtworkPresentationAccess(
        presentation: feature.artworkPresentation,
        didAppear: feature.artworkDidAppear,
        didDisappear: feature.artworkDidDisappear
      ),
      childArtwork: MediaChildArtworkAccess(
        presentationState: feature.childArtworkPresentationState,
        didAppear: feature.childArtworkDidAppear,
        didDisappear: feature.childArtworkDidDisappear
      ),
      creditArtwork: MediaCreditArtworkAccess(
        presentationState: feature.creditArtworkPresentationState,
        didAppear: feature.creditArtworkDidAppear,
        didDisappear: feature.creditArtworkDidDisappear
      )
    )
    #if os(tvOS)
      .toolbar {
        ToolbarItem(placement: .navigation) {
          Button("Back", systemImage: "chevron.backward") {
            dismiss()
          }
        }
      }
    #endif
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
struct MediaDetailsArtworkPresentationAccess {
  let presentation: (MediaDetailsArtworkSlot) -> HomeArtworkPresentation?
  let didAppear: (MediaDetailsArtworkSlot, ArtworkSizeBucket) -> Void
  let didDisappear: (MediaDetailsArtworkSlot) -> Void

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

@MainActor
struct MediaChildArtworkAccess {
  private static let emptyState = HomeArtworkPresentationState()

  let presentationState: (MediaIdentity) -> HomeArtworkPresentationState
  let didAppear: (MediaSummary, ArtworkSizeBucket) -> Void
  let didDisappear: (MediaIdentity) -> Void

  static var empty: Self {
    Self(
      presentationState: { _ in emptyState },
      didAppear: { _, _ in
        // Preview artwork access intentionally starts no loading work.
      },
      didDisappear: { _ in
        // Preview artwork access owns no work to cancel.
      }
    )
  }
}

@MainActor
struct MediaCreditArtworkAccess {
  private static let emptyState = HomeArtworkPresentationState()

  let presentationState: (MediaCreditIdentity) -> HomeArtworkPresentationState
  let didAppear: (MediaCredit, ArtworkSizeBucket) -> Void
  let didDisappear: (MediaCreditIdentity) -> Void

  static var empty: Self {
    Self(
      presentationState: { _ in emptyState },
      didAppear: { _, _ in
        // Preview artwork access intentionally starts no loading work.
      },
      didDisappear: { _ in
        // Preview artwork access owns no work to cancel.
      }
    )
  }
}

struct MediaDetailsPresentationView: View {
  let state: MediaDetailsState
  let idleTitle: String?
  let childrenState: MediaChildrenState
  let retry: @MainActor () -> Void
  let refresh: @MainActor () -> Void
  let play: @MainActor () -> Void
  let loadMoreChildren: @MainActor () -> Void
  let childDidAppear: @MainActor (MediaIdentity) -> Void
  let reauthorize: @MainActor () async -> Void
  let artwork: MediaDetailsArtworkPresentationAccess
  let childArtwork: MediaChildArtworkAccess
  let creditArtwork: MediaCreditArtworkAccess

  var body: some View {
    MediaDetailsStateContent(
      state: state,
      idleTitle: idleTitle,
      childrenState: childrenState,
      retry: retry,
      refresh: refresh,
      play: play,
      loadMoreChildren: loadMoreChildren,
      childDidAppear: childDidAppear,
      reauthorize: reauthorize,
      artwork: artwork,
      childArtwork: childArtwork,
      creditArtwork: creditArtwork
    )
    .navigationTitle(mediaDetailsNavigationTitle(state))
    #if !os(tvOS)
      .toolbar {
        ToolbarItem(placement: .primaryAction) {
          if mediaDetailsCanRefresh(state) {
            Button("Refresh", systemImage: "arrow.clockwise", action: refresh)
            .disabled(mediaDetailsIsRefreshing(state))
          }
        }
      }
    #endif
  }
}

private struct MediaDetailsStateContent: View {
  let state: MediaDetailsState
  let idleTitle: String?
  let childrenState: MediaChildrenState
  let retry: @MainActor () -> Void
  let refresh: @MainActor () -> Void
  let play: @MainActor () -> Void
  let loadMoreChildren: @MainActor () -> Void
  let childDidAppear: @MainActor (MediaIdentity) -> Void
  let reauthorize: @MainActor () async -> Void
  let artwork: MediaDetailsArtworkPresentationAccess
  let childArtwork: MediaChildArtworkAccess
  let creditArtwork: MediaCreditArtworkAccess

  @ViewBuilder
  var body: some View {
    switch state {
    case .idle:
      MediaDetailsLoadingView(title: idleTitle)

    case .loading(let selection):
      MediaDetailsLoadingView(title: selection.title)

    case .content(let details):
      MediaDetailsContentView(
        details: details,
        childrenState: childrenState,
        isRefreshing: false,
        refreshFailure: nil,
        refresh: refresh,
        play: play,
        loadMoreChildren: loadMoreChildren,
        childDidAppear: childDidAppear,
        reauthorize: reauthorize,
        artwork: artwork,
        childArtwork: childArtwork,
        creditArtwork: creditArtwork
      )

    case .refreshing(let details):
      MediaDetailsContentView(
        details: details,
        childrenState: childrenState,
        isRefreshing: true,
        refreshFailure: nil,
        refresh: refresh,
        play: play,
        loadMoreChildren: loadMoreChildren,
        childDidAppear: childDidAppear,
        reauthorize: reauthorize,
        artwork: artwork,
        childArtwork: childArtwork,
        creditArtwork: creditArtwork
      )

    case .refreshFailed(let details, let failure):
      MediaDetailsContentView(
        details: details,
        childrenState: childrenState,
        isRefreshing: false,
        refreshFailure: failure,
        refresh: refresh,
        play: play,
        loadMoreChildren: loadMoreChildren,
        childDidAppear: childDidAppear,
        reauthorize: reauthorize,
        artwork: artwork,
        childArtwork: childArtwork,
        creditArtwork: creditArtwork
      )

    case .failed(let selection, let failure):
      MediaDetailsFailureView(
        title: selection.title,
        failure: failure,
        retry: retry,
        reauthorize: reauthorize
      )
    }
  }
}

private struct MediaDetailsLoadingView: View {
  let title: String?

  var body: some View {
    ScrollView {
      LazyVStack(alignment: .leading, spacing: MediaDetailsLayout.sectionSpacing) {
        RoundedRectangle(cornerRadius: MediaDetailsLayout.artworkCornerRadius)
          .fill(.quaternary)
          .aspectRatio(MediaDetailsLayout.backdropAspectRatio, contentMode: .fit)
        Group {
          if let title {
            Text(verbatim: title)
          } else {
            Text("Details")
          }
        }
        .font(.largeTitle.bold())
        .unredacted()
        VStack(alignment: .leading, spacing: MediaDetailsLayout.metadataSpacing) {
          Text("Details metadata loading")
          Text("Synopsis loading across several readable lines of content.")
          Text("Supporting details loading")
        }
        .redacted(reason: .placeholder)
      }
      .frame(maxWidth: MediaDetailsLayout.contentMaximumWidth, alignment: .leading)
      .padding(MediaDetailsLayout.contentPadding)
    }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(accessibilityTitle)
    #if os(tvOS) || os(macOS)
      .focusable()
      .focusEffectDisabled()
    #endif
  }

  private var accessibilityTitle: Text {
    if let title {
      Text("Loading details for \(title)")
    } else {
      Text("Loading details")
    }
  }
}

private func mediaDetailsNavigationTitle(_ state: MediaDetailsState) -> LocalizedStringKey {
  let kind: MediaKind? =
    switch state {
    case .loading(let selection), .failed(let selection, _):
      selection.kind

    case .content(let details), .refreshing(let details), .refreshFailed(let details, _):
      details.kindDetails.mediaKind

    case .idle:
      nil
    }
  return switch kind {
  case .movie:
    "Movie Details"

  case .show:
    "Show Details"

  case .season:
    "Season Details"

  case .episode:
    "Episode Details"

  case nil:
    "Details"
  }
}

func mediaDetailsCanRefresh(_ state: MediaDetailsState) -> Bool {
  switch state {
  case .content, .refreshing:
    true

  case .refreshFailed(_, let failure):
    failure != .authorizationUnavailable

  case .idle, .loading, .failed:
    false
  }
}

private func mediaDetailsIsRefreshing(_ state: MediaDetailsState) -> Bool {
  if case .refreshing = state {
    true
  } else {
    false
  }
}
