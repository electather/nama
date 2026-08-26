import SwiftUI

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
      reauthorize: reauthorize
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

  var body: some View {
    NavigationStack {
      HomeStateContent(
        state: state,
        retry: retry,
        refresh: refresh,
        reauthorize: reauthorize
      )
      .navigationTitle("Home")
      .toolbar {
        ToolbarItem(placement: .primaryAction) {
          if state.canRefresh {
            Button("Refresh", systemImage: "arrow.clockwise", action: refresh)
              .disabled(state.isRefreshing)
          }
        }
        ToolbarItem(placement: .secondaryAction) {
          Button("Change Endpoint", systemImage: "network") {
            Task {
              await changeEndpoint()
            }
          }
        }
      }
    }
  }
}

private struct HomeStateContent: View {
  let state: HomeState
  let retry: @MainActor () -> Void
  let refresh: @MainActor () -> Void
  let reauthorize: @MainActor () async -> Void

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
        reauthorize: reauthorize
      )

    case .refreshing(let snapshot):
      HomeContentView(
        snapshot: snapshot,
        isRefreshing: true,
        refreshFailure: nil,
        refresh: refresh,
        reauthorize: reauthorize
      )

    case .refreshFailed(let snapshot, let failure):
      HomeContentView(
        snapshot: snapshot,
        isRefreshing: false,
        refreshFailure: failure,
        refresh: refresh,
        reauthorize: reauthorize
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
      LazyVStack(alignment: .leading, spacing: 32) {
        ProgressView("Loading Home…")
        HomeLoadingShelf(title: "Movies")
        HomeLoadingShelf(title: "Shows")
      }
      .padding(24)
    }
  }
}

private struct HomeLoadingShelf: View {
  @ScaledMetric(relativeTo: .body) private var cardWidth: CGFloat = 148

  let title: LocalizedStringKey

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      Text(title)
        .font(.title2.bold())
      ScrollView(.horizontal) {
        LazyHStack(alignment: .top, spacing: 16) {
          ForEach(0..<5, id: \.self) { _ in
            VStack(alignment: .leading, spacing: 8) {
              RoundedRectangle(cornerRadius: 12)
                .fill(.quaternary)
                .aspectRatio(2 / 3, contentMode: .fit)
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

  var body: some View {
    ScrollView {
      LazyVStack(alignment: .leading, spacing: 32) {
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
          HomeShelfView(shelf: movies)
        }
        if let shows = snapshot.shows {
          HomeShelfView(shelf: shows)
        }
      }
      .padding(24)
    }
  }
}

private struct HomeShelfView: View {
  let shelf: HomeShelf

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      Text(verbatim: shelf.title)
        .font(.title2.bold())
      ScrollView(.horizontal) {
        LazyHStack(alignment: .top, spacing: 16) {
          ForEach(shelf.items) { item in
            HomeMediaCard(item: item)
          }
        }
      }
      .scrollIndicators(.hidden)
    }
  }
}

private struct HomeMediaCard: View {
  @ScaledMetric(relativeTo: .body) private var cardWidth: CGFloat = 148

  let item: HomeMediaSummary

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      RoundedRectangle(cornerRadius: 12)
        .fill(.quaternary)
        .aspectRatio(2 / 3, contentMode: .fit)
        .overlay {
          Image(systemName: item.kind == .movie ? "film" : "tv")
            .font(.title)
            .foregroundStyle(.secondary)
            .accessibilityHidden(true)
        }
      Text(verbatim: item.title)
        .font(.headline)
        .lineLimit(3, reservesSpace: true)
      HStack(spacing: 6) {
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

private extension HomeState {
  var canRefresh: Bool {
    switch self {
    case .empty, .content, .refreshing:
      true
    case .refreshFailed(_, .authorizationUnavailable):
      false
    case .refreshFailed(_, _):
      true
    case .loading, .catalogNotReady, .failed:
      false
    }
  }

  var isRefreshing: Bool {
    if case .refreshing = self {
      return true
    }
    return false
  }
}
