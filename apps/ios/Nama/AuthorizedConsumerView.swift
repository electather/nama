import SwiftUI

#if os(iOS)
  import UIKit
#endif

struct AuthorizedConsumerRootView: View {
  @Environment(\.scenePhase) private var scenePhase
  @SceneStorage("consumer.top-level") private var storedTopLevel =
    ConsumerTopLevelDestination.home.rawValue
  @SceneStorage("consumer.library-kind") private var storedLibraryKind =
    LibraryKind.movies.rawValue
  @SceneStorage("consumer.library-sort") private var storedLibrarySort =
    LibrarySort.title.rawValue
  @SceneStorage("consumer.selected-media") private var storedSelectedMediaID = ""
  @State private var retryGeneration = 0
  @State private var didRestoreScene = false
  @State private var navigation = ConsumerSceneNavigation(restoration: .default)

  let authorization: OAuthAuthorizationFeature
  let home: HomeFeature
  let library: LibraryFeature
  let detailsLoader: any MediaChildrenLoading & MediaDetailsLoading
  let artworkLoader: any HomeArtworkLoading
  let emitPlayIntent: @MainActor (MediaPlayIntent) -> Void
  let endpoint: NamaEndpoint
  let changeEndpoint: @MainActor () async -> Void

  var body: some View {
    Group {
      if let homeAuthorization {
        AuthorizedTopLevelView(
          navigation: navigation,
          home: home,
          library: library,
          authorization: homeAuthorization,
          detailsLoader: detailsLoader,
          artworkLoader: artworkLoader,
          emitPlayIntent: emitPlayIntent,
          changeEndpoint: changeEndpoint
        ) {
          await discardRejectedAuthorization(for: homeAuthorization)
        }
      } else {
        OAuthAuthorizationView(
          feature: authorization,
          endpoint: endpoint,
          changeEndpoint: changeEndpoint
        ) {
          retryGeneration &+= 1
        }
      }
    }
    .onAppear {
      restoreSceneIfNeeded()
    }
    .onChange(of: navigation.restoration) { _, restoration in
      persist(restoration)
    }
    .onChange(of: scenePhase) { _, phase in
      guard phase == .active else {
        library.deactivate()
        return
      }
      activateLibraryIfVisible()
    }
    .onChange(of: homeAuthorization) { oldAuthorization, newAuthorization in
      guard oldAuthorization != newAuthorization else {
        return
      }
      library.deactivate()
      activateLibraryIfVisible(identity: newAuthorization)
    }
    .task(
      id: OAuthAuthorizationTaskID(
        endpoint: endpoint,
        retryGeneration: retryGeneration,
        isActive: scenePhase == .active
      )
    ) {
      guard scenePhase == .active else {
        return
      }
      await authorization.run(endpoint)
    }
  }

  private func restoreSceneIfNeeded() {
    guard !didRestoreScene else {
      return
    }
    didRestoreScene = true
    navigation.restore(
      ConsumerSceneRestoration(
        topLevelRawValue: storedTopLevel,
        libraryKindRawValue: storedLibraryKind,
        librarySortRawValue: storedLibrarySort,
        selectedMediaID: storedSelectedMediaID
      )
    )
  }

  private func persist(_ restoration: ConsumerSceneRestoration) {
    storedTopLevel = restoration.topLevelRawValue
    storedLibraryKind = restoration.libraryKindRawValue
    storedLibrarySort = restoration.librarySortRawValue
    storedSelectedMediaID = restoration.selectedMediaID ?? ""
  }

  private func activateLibraryIfVisible(
    identity: HomeAuthorizationIdentity? = nil
  ) {
    guard
      scenePhase == .active,
      navigation.topLevel == .library,
      let activeAuthorization = identity ?? homeAuthorization
    else {
      return
    }
    library.updateQuery(navigation.libraryQuery)
    library.activate(activeAuthorization)
  }

  private func discardRejectedAuthorization(
    for authorizationIdentity: HomeAuthorizationIdentity
  ) async {
    guard
      case .authorized(let rejected) = authorization.state,
      authorization.session.generation == authorizationIdentity.generation
    else {
      return
    }
    switch await authorization.discardRejectedAuthorization(
      rejected,
      generation: authorizationIdentity.generation
    ) {
    case .discarded:
      retryGeneration &+= 1

    case .storageUnavailable, .stale:
      return
    }
  }

  private var homeAuthorization: HomeAuthorizationIdentity? {
    HomeAuthorizationIdentity(
      currentEndpoint: endpoint,
      authorizationState: authorization.state,
      generation: authorization.session.generation
    )
  }
}

struct AuthorizedTopLevelView: View {
  let navigation: ConsumerSceneNavigation
  let home: HomeFeature
  let library: LibraryFeature
  let authorization: HomeAuthorizationIdentity
  let detailsLoader: any MediaChildrenLoading & MediaDetailsLoading
  let artworkLoader: any HomeArtworkLoading
  let emitPlayIntent: @MainActor (MediaPlayIntent) -> Void
  let changeEndpoint: @MainActor () async -> Void
  let reauthorize: @MainActor () async -> Void

  @ViewBuilder
  var body: some View {
    switch consumerNavigationLayout(for: currentPlatformFamily) {
    case .tabs:
      TabView(selection: topLevelBinding) {
        Tab("Home", systemImage: "house", value: ConsumerTopLevelDestination.home) {
          destinationStack(.home)
        }
        Tab("Library", systemImage: "rectangle.stack", value: ConsumerTopLevelDestination.library) {
          destinationStack(.library)
        }
      }

    case .split:
      NavigationSplitView {
        List(selection: optionalTopLevelBinding) {
          ForEach(ConsumerTopLevelDestination.allCases, id: \.self) { destination in
            Label(destination.title, systemImage: destination.systemImage)
              .tag(destination)
          }
        }
        #if !os(tvOS)
          .listStyle(.sidebar)
        #endif
        .navigationTitle("Nama")
      } detail: {
        destinationStack(navigation.topLevel)
      }
    }
  }

  private func destinationStack(
    _ destination: ConsumerTopLevelDestination
  ) -> some View {
    NavigationStack(path: pathBinding(for: destination)) {
      destinationContent(destination)
        .navigationDestination(for: MediaDetailsSelection.self) { selection in
          MediaDetailsDestination(
            selection: selection,
            authorization: authorization,
            loader: detailsLoader,
            artworkLoader: artworkLoader,
            emitPlayIntent: emitPlayIntent,
            reauthorize: reauthorize
          )
        }
    }
  }

  @ViewBuilder
  private func destinationContent(_ destination: ConsumerTopLevelDestination) -> some View {
    switch destination {
    case .home:
      HomeView(
        feature: home,
        authorization: authorization,
        changeEndpoint: changeEndpoint,
        reauthorize: reauthorize,
        selectMedia: { selection in
          navigation.select(selection, from: .home)
        },
        seeAll: navigation.showLibrary
      )

    case .library:
      LibraryView(
        feature: library,
        authorization: authorization,
        query: navigation.libraryQuery,
        updateKind: navigation.updateLibraryKind,
        updateSort: navigation.updateLibrarySort,
        selectMedia: { selection in
          navigation.select(selection, from: .library)
        },
        changeEndpoint: changeEndpoint,
        reauthorize: reauthorize
      )
    }
  }

  private var topLevelBinding: Binding<ConsumerTopLevelDestination> {
    Binding(
      get: { navigation.topLevel },
      set: { destination in navigation.topLevel = destination }
    )
  }

  private var optionalTopLevelBinding: Binding<ConsumerTopLevelDestination?> {
    Binding(
      get: { navigation.topLevel },
      set: { destination in
        if let destination {
          navigation.topLevel = destination
        }
      }
    )
  }

  private func pathBinding(
    for destination: ConsumerTopLevelDestination
  ) -> Binding<[MediaDetailsSelection]> {
    switch destination {
    case .home:
      Binding(
        get: { navigation.homePath },
        set: { path in navigation.homePath = path }
      )

    case .library:
      Binding(
        get: { navigation.libraryPath },
        set: { path in navigation.libraryPath = path }
      )
    }
  }

  private var currentPlatformFamily: ConsumerPlatformFamily {
    #if os(tvOS)
      .television
    #elseif os(macOS)
      .mac
    #else
      UIDevice.current.userInterfaceIdiom == .pad ? .pad : .phone
    #endif
  }
}

extension ConsumerTopLevelDestination {
  var title: LocalizedStringKey {
    switch self {
    case .home:
      "Home"

    case .library:
      "Library"
    }
  }

  var systemImage: String {
    switch self {
    case .home:
      "house"

    case .library:
      "rectangle.stack"
    }
  }
}
