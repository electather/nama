import Foundation

nonisolated enum EndpointValidationError: Error, Equatable {
  case invalid
}

nonisolated struct NamaEndpoint: Hashable, Sendable {
  let url: URL

  var absoluteString: String {
    url.absoluteString
  }

  init(_ input: String) throws {
    let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
    guard var components = URLComponents(string: trimmed),
      let scheme = components.scheme?.lowercased(),
      scheme == "http" || scheme == "https",
      let host = components.host,
      !host.isEmpty,
      components.user == nil,
      components.password == nil,
      components.query == nil,
      components.fragment == nil
    else {
      throw EndpointValidationError.invalid
    }

    if let port = components.port {
      guard (1...65_535).contains(port) else {
        throw EndpointValidationError.invalid
      }
      if (scheme == "http" && port == 80) || (scheme == "https" && port == 443) {
        components.port = nil
      }
    }

    components.scheme = scheme
    components.host = host.lowercased()
    components.percentEncodedPath = Self.normalizedPath(components.percentEncodedPath)

    guard let url = components.url else {
      throw EndpointValidationError.invalid
    }
    self.url = url
  }

  private static func normalizedPath(_ path: String) -> String {
    guard !path.isEmpty else {
      return "/"
    }

    var end = path.endIndex
    while end > path.startIndex {
      let previous = path.index(before: end)
      guard path[previous] == "/" else {
        break
      }
      end = previous
    }
    return end == path.startIndex ? "/" : "\(path[..<end])/"
  }
}
