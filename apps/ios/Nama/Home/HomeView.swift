import SwiftUI

private enum HomeLayout {
  static let cardContentSpacing: CGFloat = 8
  static let cardCornerRadius: CGFloat = 12
  static let cardSpacing: CGFloat = 16

  #if os(tvOS)
    static let cardWidth: CGFloat = 300
  #else
    static let cardWidth: CGFloat = 148
  #endif

  static let contentPadding: CGFloat = 24
  static let loadingCardCount = 5
  static let metadataSpacing: CGFloat = 6
  static let posterHeightUnits: CGFloat = 3
  static let posterWidthUnits: CGFloat = 2
  static let posterAspectRatio = posterWidthUnits / posterHeightUnits
  static let sectionSpacing: CGFloat = 32
  static let shelfSpacing: CGFloat = 12
  static let sourceLabelLineLimit = 1
  static let titleLineLimit = 3
}

struct HomeView: View {
  @Environment(\.scenePhase) private var scenePhase

  let feature: HomeFeature
  let authorization: HomeAuthorizationIdentity
  let changeEndpoint: @MainActor () async -> Void
  let reauthorize: @MainActor () async -> Void

  var body: some View {
    HomePresentationView(
      state: feature.state,
      retry: feature.retry,
      refresh: feature.refresh,
      changeEndpoint: changeEndpoint,
      reauthorize: reauthorize,
      artwork: HomeArtworkPresentationAccess(
        presentationState: feature.artworkPresentationState,
        didAppear: feature.artworkDidAppear,
        didDisappear: feature.artworkDidDisappear
      )
    )
    .onAppear {
      if scenePhase == .active {
        feature.activate(authorization)
      }
    }
    .onChange(of: authorization) { _, newAuthorization in
      if scenePhase == .active {
        feature.activate(newAuthorization)
      } else {
        feature.deactivate()
      }
    }
    .onChange(of: scenePhase) { _, phase in
      if phase == .active {
        feature.activate(authorization)
      } else {
        feature.deactivate()
      }
    }
    .onDisappear {
      feature.deactivate()
    }
  }
}

struct HomePresentationView: View {
  let state: HomeState
  let retry: @MainActor () -> Void
  let refresh: @MainActor () -> Void
  let changeEndpoint: @MainActor () async -> Void
  let reauthorize: @MainActor () async -> Void
  let artwork: HomeArtworkPresentationAccess

  init(
    state: HomeState,
    retry: @escaping @MainActor () -> Void,
    refresh: @escaping @MainActor () -> Void,
    changeEndpoint: @escaping @MainActor () async -> Void,
    reauthorize: @escaping @MainActor () async -> Void,
    artwork: HomeArtworkPresentationAccess = .empty
  ) {
    self.state = state
    self.retry = retry
    self.refresh = refresh
    self.changeEndpoint = changeEndpoint
    self.reauthorize = reauthorize
    self.artwork = artwork
  }

  var body: some View {
    NavigationStack {
      HomeStateContent(
        state: state,
        retry: retry,
        refresh: refresh,
        reauthorize: reauthorize,
        artwork: artwork
      )
      .navigationTitle("Home")
      .toolbar {
        ToolbarItem(placement: .primaryAction) {
          if homeCanRefresh(state) {
            Button("Refresh", systemImage: "arrow.clockwise", action: refresh)
              .disabled(homeIsRefreshing(state))
          }
        }
        ToolbarItem(placement: changeEndpointPlacement) {
          Button("Change Endpoint", systemImage: "network") {
            Task {
              await changeEndpoint()
            }
          }
        }
      }
    }
  }

  private var changeEndpointPlacement: ToolbarItemPlacement {
    #if os(tvOS)
      .automatic
    #else
      .secondaryAction
    #endif
  }
}

private struct HomeStateContent: View {
  let state: HomeState
  let retry: @MainActor () -> Void
  let refresh: @MainActor () -> Void
  let reauthorize: @MainActor () async -> Void
  let artwork: HomeArtworkPresentationAccess

  @ViewBuilder
  var body: some View {
    switch state {
    case .loading:
      HomeLoadingView()

    case .catalogNotReady(let retryAfterSeconds):
      HomeCatalogNotReadyView(
        retryAfterSeconds: retryAfterSeconds,
        retry: retry
      )

    case .empty:
      ContentUnavailableView {
        Label("Your library is empty", systemImage: "rectangle.stack")
      } description: {
        Text("Refresh to check for newly available movies and shows.")
      } actions: {
        Button("Refresh", action: refresh)
          .buttonStyle(.borderedProminent)
      }

    case .content(let snapshot):
      HomeContentView(
        snapshot: snapshot,
        isRefreshing: false,
        refreshFailure: nil,
        refresh: refresh,
        reauthorize: reauthorize,
        artwork: artwork
      )

    case .refreshing(let snapshot):
      HomeContentView(
        snapshot: snapshot,
        isRefreshing: true,
        refreshFailure: nil,
        refresh: refresh,
        reauthorize: reauthorize,
        artwork: artwork
      )

    case .refreshFailed(let snapshot, let failure):
      HomeContentView(
        snapshot: snapshot,
        isRefreshing: false,
        refreshFailure: failure,
        refresh: refresh,
        reauthorize: reauthorize,
        artwork: artwork
      )

    case .failed(let failure):
      HomeFailureView(
        failure: failure,
        retry: retry,
        reauthorize: reauthorize
      )
    }
  }
}

private struct HomeLoadingView: View {
  var body: some View {
    ScrollView {
      LazyVStack(alignment: .leading, spacing: HomeLayout.sectionSpacing) {
        ProgressView("Loading Home…")
        HomeLoadingShelf(title: "Movies")
        HomeLoadingShelf(title: "Shows")
      }
      .padding(HomeLayout.contentPadding)
    }
  }
}

private struct HomeLoadingShelf: View {
  @ScaledMetric(relativeTo: .body) private var cardWidth = HomeLayout.cardWidth

  let title: LocalizedStringKey

  var body: some View {
    VStack(alignment: .leading, spacing: HomeLayout.shelfSpacing) {
      Text(title)
        .font(.title2.bold())
      ScrollView(.horizontal) {
        LazyHStack(alignment: .top, spacing: HomeLayout.cardSpacing) {
          ForEach(0..<HomeLayout.loadingCardCount, id: \.self) { _ in
            VStack(alignment: .leading, spacing: HomeLayout.cardContentSpacing) {
              RoundedRectangle(cornerRadius: HomeLayout.cardCornerRadius)
                .fill(.quaternary)
                .aspectRatio(HomeLayout.posterAspectRatio, contentMode: .fit)
              Text("Loading title")
                .font(.headline)
              Text("Loading details")
                .font(.subheadline)
            }
            .frame(width: cardWidth, alignment: .leading)
            .redacted(reason: .placeholder)
          }
        }
      }
      .scrollIndicators(.hidden)
    }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("Loading library section")
  }
}

private struct HomeCatalogNotReadyView: View {
  let retryAfterSeconds: Int?
  let retry: @MainActor () -> Void

  var body: some View {
    ContentUnavailableView {
      Label("Your library is being prepared", systemImage: "clock.arrow.circlepath")
    } description: {
      HomeRetryGuidance(retryAfterSeconds: retryAfterSeconds)
    } actions: {
      Button("Retry", action: retry)
        .buttonStyle(.borderedProminent)
    }
  }
}

private struct HomeContentView: View {
  let snapshot: HomeSnapshot
  let isRefreshing: Bool
  let refreshFailure: HomeLoadingFailure?
  let refresh: @MainActor () -> Void
  let reauthorize: @MainActor () async -> Void
  let artwork: HomeArtworkPresentationAccess

  var body: some View {
    ScrollView {
      LazyVStack(alignment: .leading, spacing: HomeLayout.sectionSpacing) {
        if let refreshFailure {
          HomeRefreshFailureView(
            failure: refreshFailure,
            retry: refresh,
            reauthorize: reauthorize
          )
        }
        if isRefreshing {
          ProgressView("Refreshing…")
        }
        if let movies = snapshot.movies {
          HomeShelfView(shelf: movies, artwork: artwork)
        }
        if let shows = snapshot.shows {
          HomeShelfView(shelf: shows, artwork: artwork)
        }
      }
      .padding(HomeLayout.contentPadding)
    }
  }
}

private func homeCanRefresh(_ state: HomeState) -> Bool {
  switch state {
  case .empty, .content, .refreshing:
    true

  case .refreshFailed(_, let failure):
    failure != .authorizationUnavailable

  case .loading, .catalogNotReady, .failed:
    false
  }
}

private func homeIsRefreshing(_ state: HomeState) -> Bool {
  if case .refreshing = state {
    return true
  }
  return false
}
