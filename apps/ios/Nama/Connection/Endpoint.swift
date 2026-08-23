import Foundation

nonisolated enum EndpointValidationError: Error, Equatable {
  case invalid
}

nonisolated struct NamaEndpoint: Hashable, Sendable {
  let url: URL

  private static let validPortRange = 1...65_535
  private static let defaultHTTPPort = 80
  private static let defaultHTTPSPort = 443

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
      guard Self.validPortRange.contains(port) else {
        throw EndpointValidationError.invalid
      }
      if (scheme == "http" && port == Self.defaultHTTPPort)
        || (scheme == "https" && port == Self.defaultHTTPSPort)
      {
        components.port = nil
      }
    }

    components.scheme = scheme
    components.host = host.lowercased()
    components.percentEncodedPath = Self.normalizedPath(components.percentEncodedPath)

    guard let endpointURL = components.url else {
      throw EndpointValidationError.invalid
    }
    self.url = endpointURL
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
