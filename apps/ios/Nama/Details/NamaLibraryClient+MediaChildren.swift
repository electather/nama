import NamaAPI

nonisolated extension NamaLibraryClient {
  static func mapMediaChildrenResponse(
    _ response: Nama_Api_V1_ListChildrenResponse,
    expectedKind: MediaKind
  ) throws -> MediaChildrenPage {
    guard
      response.items.count <= Int(MediaChildrenPagePolicy.size),
      response.nextPageToken.utf8.count <= MediaChildrenBounds.maximumPageTokenBytes
    else {
      throw MediaChildrenResponseMappingError.invalid
    }
    return MediaChildrenPage(
      items: try response.items.map { item in
        try mapMediaSummary(item, expectedKind: expectedKind)
      },
      nextPageToken: response.nextPageToken.isEmpty ? nil : response.nextPageToken
    )
  }
}

nonisolated enum MediaChildrenBounds {
  static let maximumPageTokenBytes = 4_096
}

nonisolated private enum MediaChildrenResponseMappingError: Error {
  case invalid
}
