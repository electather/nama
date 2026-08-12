#if DEBUG
  import Foundation

  enum PlayerLabLaunchConfiguration: Equatable {
    case product
    case lab(baseURL: URL)
    case invalid(String)

    static func parse(arguments: [String]) -> Self {
      let labFlagCount = arguments.count { $0 == "--player-lab" }
      let baseFlagIndices = arguments.indices.filter {
        arguments[$0] == "--player-lab-base-url"
      }

      guard labFlagCount > 0 || !baseFlagIndices.isEmpty else { return .product }
      guard labFlagCount == 1, baseFlagIndices.count == 1 else {
        return .invalid("Use each Player Lab launch argument exactly once.")
      }
      let baseFlagIndex = baseFlagIndices[0]
      guard baseFlagIndex + 1 < arguments.count else {
        return .invalid("Add a URL after --player-lab-base-url.")
      }
      let value = arguments[baseFlagIndex + 1]
      guard !value.hasPrefix("--"), let baseURL = URL(string: value),
        let origin = try? PlayerLabURLResolver.baseOriginURL(for: baseURL)
      else {
        return .invalid(
          "Use an HTTP or HTTPS origin without credentials, a path, query, or fragment.")
      }
      return .lab(baseURL: origin)
    }
  }

  struct PlayerLabManifest: Decodable, Equatable {
    static let supportedVersion = 1

    let version: Int
    let fixtures: [PlayerLabFixture]

    static func decode(_ data: Data) throws -> Self {
      let manifest: Self
      do {
        manifest = try JSONDecoder().decode(Self.self, from: data)
      } catch {
        throw PlayerLabError.invalidManifest
      }
      guard manifest.version == supportedVersion else {
        throw PlayerLabError.unsupportedManifestVersion
      }
      guard Set(manifest.fixtures.map(\.id)).count == manifest.fixtures.count else {
        throw PlayerLabError.duplicateFixtureID
      }
      for fixture in manifest.fixtures {
        try fixture.validate()
      }
      return manifest
    }

    static func load(from bundle: Bundle = .main) throws -> Self {
      guard let resourceURL = bundle.url(forResource: "player-lab-fixtures", withExtension: "json")
      else {
        throw PlayerLabError.missingManifest
      }
      return try decode(Data(contentsOf: resourceURL))
    }
  }

  struct PlayerLabFixture: Decodable, Equatable, Identifiable {
    let id: String
    let title: String
    let mediaPath: String
    let sidecars: [PlayerLabSidecar]
    let headerScenario: PlayerLabHeaderScenario
    let expected: PlayerLabExpectedCharacteristics

    fileprivate func validate() throws {
      guard PlayerLabID.isValid(id), !title.isEmpty else {
        throw PlayerLabError.invalidManifest
      }
      try PlayerLabURLResolver.validate(relativePath: mediaPath)
      guard Set(sidecars.map(\.id)).count == sidecars.count else {
        throw PlayerLabError.duplicateSidecarID
      }
      for sidecar in sidecars {
        guard PlayerLabID.isValid(sidecar.id), !sidecar.label.isEmpty, !sidecar.mimeType.isEmpty
        else {
          throw PlayerLabError.invalidManifest
        }
        try PlayerLabURLResolver.validate(relativePath: sidecar.path)
      }
    }

    func playbackRequest(baseURL: URL) throws -> PlaybackRequest {
      let origin = try PlayerLabURLResolver.baseOriginURL(for: baseURL)
      let headers = headerScenario.headers
      return PlaybackRequest(
        media: PlaybackMediaLocator(
          url: try PlayerLabURLResolver.resolve(relativePath: mediaPath, against: origin),
          httpHeaders: headers,
          allowedRedirectOrigins: [origin],
          mimeType: nil
        ),
        externalSubtitles: try sidecars.map { sidecar in
          PlaybackExternalSubtitleLocator(
            id: sidecar.id,
            label: sidecar.label,
            language: sidecar.language,
            isDefault: false,
            isForced: false,
            locator: PlaybackMediaLocator(
              url: try PlayerLabURLResolver.resolve(relativePath: sidecar.path, against: origin),
              httpHeaders: headers,
              allowedRedirectOrigins: [origin],
              mimeType: sidecar.mimeType
            )
          )
        },
        resumePosition: nil
      )
    }
  }

  struct PlayerLabSidecar: Decodable, Equatable, Identifiable {
    let id: String
    let label: String
    let language: String?
    let mimeType: String
    let path: String
  }

  enum PlayerLabHeaderScenario: String, Decodable, Equatable {
    case none
    case dummyCredentials

    fileprivate var headers: [String: String] {
      switch self {
      case .none: [:]
      case .dummyCredentials:
        [
          "Authorization": "Bearer nama-player-lab-dummy-authorization",
          "X-Emby-Token": "nama-player-lab-dummy-jellyfin",
        ]
      }
    }
  }

  struct PlayerLabExpectedCharacteristics: Decodable, Equatable {
    let container: String
    let videoCodec: String
    let dynamicRange: String
    let audio: [PlayerLabExpectedAudio]
    let subtitles: [PlayerLabExpectedSubtitle]
  }

  struct PlayerLabExpectedAudio: Decodable, Equatable {
    let codec: String
    let channels: Int?
    let label: String?
  }

  struct PlayerLabExpectedSubtitle: Decodable, Equatable {
    enum Representation: String, Decodable, Equatable {
      case text
      case image
    }

    let representation: Representation
    let language: String?
  }

  enum PlayerLabURLResolver {
    static func validate(relativePath: String) throws {
      guard !relativePath.isEmpty, !relativePath.hasPrefix("/"), !relativePath.contains("\\"),
        let components = URLComponents(string: relativePath), components.scheme == nil,
        components.host == nil, components.user == nil, components.password == nil,
        components.query == nil, components.fragment == nil,
        safeDecodedPath(components.percentEncodedPath)
      else {
        throw PlayerLabError.unsafeRelativePath
      }
    }

    private static func safeDecodedPath(_ encodedPath: String) -> Bool {
      guard encodedPath.removingPercentEncoding != nil else { return false }
      var path = encodedPath
      while let decoded = path.removingPercentEncoding, decoded != path {
        path = decoded
      }
      return !path.hasPrefix("/") && !path.contains("\\")
        && !path.split(separator: "/", omittingEmptySubsequences: false).contains {
          $0 == "." || $0 == ".." || $0.isEmpty
        }
    }

    static func resolve(relativePath: String, against baseURL: URL) throws -> URL {
      try validate(relativePath: relativePath)
      let origin = try baseOriginURL(for: baseURL)
      guard var components = URLComponents(url: origin, resolvingAgainstBaseURL: false) else {
        throw PlayerLabError.invalidOrigin
      }
      components.percentEncodedPath = "/" + relativePath
      guard let resolved = components.url,
        try originURL(for: resolved) == origin
      else {
        throw PlayerLabError.unsafeRelativePath
      }
      return resolved
    }

    static func originURL(for url: URL) throws -> URL {
      guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
        let scheme = components.scheme?.lowercased(), scheme == "http" || scheme == "https",
        let host = components.host?.lowercased(), !host.isEmpty,
        components.user == nil, components.password == nil
      else {
        throw PlayerLabError.invalidOrigin
      }
      var originComponents = URLComponents()
      originComponents.scheme = scheme
      originComponents.host = host
      originComponents.port =
        (scheme == "http" && components.port == 80)
          || (scheme == "https" && components.port == 443) ? nil : components.port
      originComponents.path = "/"
      guard let origin = originComponents.url else { throw PlayerLabError.invalidOrigin }
      return origin
    }

    static func baseOriginURL(for url: URL) throws -> URL {
      guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
        components.query == nil, components.fragment == nil,
        components.percentEncodedPath.isEmpty || components.percentEncodedPath == "/"
      else {
        throw PlayerLabError.invalidOrigin
      }
      return try originURL(for: url)
    }
  }

  enum PlayerLabDiagnostics {
    static func fixtureLabel(for fixture: PlayerLabFixture) -> String {
      "Fixture: \(fixture.id)"
    }
  }

  private enum PlayerLabID {
    static func isValid(_ value: String) -> Bool {
      !value.isEmpty
        && value.unicodeScalars.allSatisfy {
          switch $0.value {
          case 45, 48...57, 97...122: true
          default: false
          }
        }
    }
  }

  enum PlayerLabError: LocalizedError {
    case missingManifest
    case invalidManifest
    case unsupportedManifestVersion
    case duplicateFixtureID
    case duplicateSidecarID
    case unsafeRelativePath
    case invalidOrigin

    var errorDescription: String? {
      switch self {
      case .missingManifest: "The bundled Player Lab manifest is missing."
      case .invalidManifest: "The bundled Player Lab manifest is malformed."
      case .unsupportedManifestVersion: "This Player Lab manifest version is not supported."
      case .duplicateFixtureID: "The Player Lab manifest contains duplicate fixture IDs."
      case .duplicateSidecarID: "A fixture contains duplicate sidecar IDs."
      case .unsafeRelativePath: "A fixture contains an unsafe relative path."
      case .invalidOrigin: "The Player Lab fixture origin is invalid."
      }
    }
  }
#endif
