import Testing

@testable import Nama

@Suite("Canonical child artwork feature")
@MainActor
struct MediaChildArtworkFeatureTests {
  @Test(
    "child rows select kind-appropriate safe artwork",
    arguments: [
      (MediaKind.season, ArtworkRole.poster),
      (.episode, .thumbnail),
    ]
  )
  func kindAppropriateArtwork(kind: MediaKind, expectedRole: ArtworkRole) async throws {
    let hierarchyLoader = ManualHierarchyDetailsLoader()
    let artworkLoader = RecordingChildArtworkLoader()
    let feature = MediaDetailsFeature(loader: hierarchyLoader, artworkLoader: artworkLoader)
    let parentKind: MediaKind = kind == .season ? .show : .season
    let selection = hierarchySelection("parent-artwork", kind: parentKind, title: "Parent")
    let authorization = try movieDetailsAuthorization(generation: 1)
    let details = hierarchyDetails(
      selection,
      kindDetails: parentKind == .show
        ? .show(
          firstReleaseDate: nil,
          lastReleaseDate: nil,
          seasonCount: nil,
          episodeCount: nil
        )
        : .season(seasonNumber: 1, episodeCount: nil)
    )
    let child = artworkChild(kind: kind)

    feature.select(selection, authorization: authorization)
    await eventually { await hierarchyLoader.detailsCallCount == 1 }
    await hierarchyLoader.resolveDetails(call: 0, with: .success(details))
    await eventually { await hierarchyLoader.childrenCallCount == 1 }
    await hierarchyLoader.resolveChildren(
      call: 0,
      with: .success(MediaChildrenPage(items: [child], nextPageToken: nil))
    )
    await eventually { feature.state == .content(details) }

    let state = feature.childArtworkPresentationState(for: child.identity)
    feature.childArtworkDidAppear(
      child,
      size: .poster(displayWidth: 120, scale: 2)
    )

    await eventually { await artworkLoader.callCount == 1 }
    #expect(await artworkLoader.reference(call: 0)?.role == expectedRole)
    await eventually { state.presentation != nil }
  }

  @Test("missing child artwork retains the title fallback without loading")
  func missingArtworkStartsNoWork() async throws {
    let hierarchyLoader = ManualHierarchyDetailsLoader()
    let artworkLoader = RecordingChildArtworkLoader()
    let feature = MediaDetailsFeature(loader: hierarchyLoader, artworkLoader: artworkLoader)
    let selection = hierarchySelection("show-missing-artwork", kind: .show, title: "Show")
    let authorization = try movieDetailsAuthorization(generation: 1)
    let details = hierarchyShowDetails(selection)
    let child = hierarchyChild("season-missing-artwork", kind: .season, title: "Season")

    feature.select(selection, authorization: authorization)
    await eventually { await hierarchyLoader.detailsCallCount == 1 }
    await hierarchyLoader.resolveDetails(call: 0, with: .success(details))
    await eventually { await hierarchyLoader.childrenCallCount == 1 }
    await hierarchyLoader.resolveChildren(
      call: 0,
      with: .success(MediaChildrenPage(items: [child], nextPageToken: nil))
    )
    await eventually { feature.state == .content(details) }

    let state = feature.childArtworkPresentationState(for: child.identity)
    feature.childArtworkDidAppear(
      child,
      size: .poster(displayWidth: 120, scale: 2)
    )
    await Task.yield()

    #expect(await artworkLoader.callCount == 0)
    #expect(state.presentation == nil)
  }

  @Test("Cast rows load portrait artwork through the safe artwork boundary")
  func castPortraitArtworkLoads() async throws {
    let detailsLoader = ManualHierarchyDetailsLoader()
    let artworkLoader = RecordingChildArtworkLoader()
    let feature = MediaDetailsFeature(loader: detailsLoader, artworkLoader: artworkLoader)
    let selection = movieDetailsSelection(identity: "movie-portrait", title: "Portrait Movie")
    let authorization = try movieDetailsAuthorization(generation: 1)
    let credit = MediaCredit(
      identity: MediaCreditIdentity(7),
      name: "Portrait Actor",
      role: .actor,
      characterName: nil,
      portraitArtwork: movieArtwork(
        identity: "portrait-credit",
        role: .portrait,
        textPresence: .textless
      )
    )
    let details = movieDetailsFixture(selection: selection, credits: [credit])

    feature.select(selection, authorization: authorization)
    await eventually { await detailsLoader.detailsCallCount == 1 }
    await detailsLoader.resolveDetails(call: 0, with: .success(details))
    await eventually { feature.state == .content(details) }

    let state = feature.creditArtworkPresentationState(for: credit.identity)
    feature.creditArtworkDidAppear(
      credit,
      size: .poster(displayWidth: 140, scale: 2)
    )

    await eventually { await artworkLoader.callCount == 1 }
    #expect(await artworkLoader.reference(call: 0)?.role == .portrait)
    await eventually { state.presentation != nil }
  }

  @Test("leaving Details rejects obsolete child artwork completion")
  func deactivationRejectsStaleArtwork() async throws {
    let hierarchyLoader = ManualHierarchyDetailsLoader()
    let artworkLoader = ManualMovieDetailsArtworkLoader()
    let feature = MediaDetailsFeature(loader: hierarchyLoader, artworkLoader: artworkLoader)
    let selection = hierarchySelection("show-stale-artwork", kind: .show, title: "Show")
    let authorization = try movieDetailsAuthorization(generation: 1)
    let details = hierarchyShowDetails(selection)
    let child = artworkChild(kind: .season)

    feature.select(selection, authorization: authorization)
    await eventually { await hierarchyLoader.detailsCallCount == 1 }
    await hierarchyLoader.resolveDetails(call: 0, with: .success(details))
    await eventually { await hierarchyLoader.childrenCallCount == 1 }
    await hierarchyLoader.resolveChildren(
      call: 0,
      with: .success(MediaChildrenPage(items: [child], nextPageToken: nil))
    )
    await eventually { feature.state == .content(details) }

    let state = feature.childArtworkPresentationState(for: child.identity)
    feature.childArtworkDidAppear(
      child,
      size: .poster(displayWidth: 120, scale: 2)
    )
    await eventually { await artworkLoader.callCount == 1 }

    feature.deactivate(selection)
    await artworkLoader.resolve(call: 0, with: ArtworkFixture.presentation)
    await Task.yield()

    #expect(state.presentation == nil)
  }
}

private actor RecordingChildArtworkLoader: HomeArtworkLoading {
  private var references: [ArtworkReference] = []

  var callCount: Int { references.count }

  func authorizationDidChange(to _: HomeAuthorizationIdentity) {
    // This fixture has no authorization-scoped state.
  }

  func image(
    for reference: ArtworkReference,
    size _: ArtworkSizeBucket,
    authorization _: HomeAuthorizationIdentity
  ) -> HomeArtworkPresentation? {
    references.append(reference)
    return ArtworkFixture.presentation
  }

  func reference(call index: Int) -> ArtworkReference? {
    references[index]
  }
}

private func artworkChild(kind: MediaKind) -> MediaSummary {
  MediaSummary(
    identity: MediaIdentity("child-artwork"),
    kind: kind,
    title: "Child Artwork",
    releaseYear: nil,
    runtime: nil,
    contentRating: nil,
    primaryGenre: nil,
    artwork: [
      movieArtwork(identity: "poster-child", role: .poster, textPresence: .textless),
      movieArtwork(identity: "thumbnail-child", role: .thumbnail, textPresence: .textless),
    ],
    playability: .noAvailableSource,
    defaultSource: nil,
    episodePosition: kind == .episode
      ? MediaEpisodePosition(seasonNumber: 1, episodeNumber: 1)
      : nil
  )
}
