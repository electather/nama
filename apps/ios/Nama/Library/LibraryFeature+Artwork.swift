extension LibraryFeature {
  func artworkPresentationState(
    for media: MediaIdentity
  ) -> HomeArtworkPresentationState? {
    artworkWindow.presentationState(for: media)
  }

  func artworkDidAppear(_ media: MediaIdentity, size: ArtworkSizeBucket) {
    artworkWindow.artworkDidAppear(media, in: LibraryArtworkProjection.collection, size: size)
  }

  func artworkDidDisappear(_ media: MediaIdentity) {
    artworkWindow.artworkDidDisappear(media, in: LibraryArtworkProjection.collection)
  }
}
