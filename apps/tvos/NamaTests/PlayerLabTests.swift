import Foundation
import XCTest

#if canImport(Nama)
  @testable import Nama
#endif

#if DEBUG
  final class PlayerLabTests: XCTestCase {
    func testLaunchParsingKeepsNormalLaunchAndAcceptsOneCompleteLabConfiguration() throws {
      XCTAssertEqual(PlayerLabLaunchConfiguration.parse(arguments: ["Nama"]), .product)

      let configuration = PlayerLabLaunchConfiguration.parse(arguments: [
        "Nama", "--player-lab", "--player-lab-base-url", "http://media.test:8080",
      ])

      guard case .lab(let baseURL) = configuration else {
        return XCTFail("Expected a Player Lab configuration")
      }
      XCTAssertEqual(baseURL.absoluteString, "http://media.test:8080/")
    }

    func testLaunchParsingRejectsIncompleteDuplicateAndUnsafeLabConfiguration() {
      let cases = [
        ["Nama", "--player-lab"],
        ["Nama", "--player-lab-base-url", "http://media.test:8080"],
        [
          "Nama", "--player-lab", "--player-lab", "--player-lab-base-url",
          "http://media.test:8080",
        ],
        [
          "Nama", "--player-lab", "--player-lab-base-url", "http://media.test:8080",
          "--player-lab-base-url", "http://media.test:8081",
        ],
        ["Nama", "--player-lab", "--player-lab-base-url"],
        [
          "Nama", "--player-lab", "--player-lab-base-url",
          "http://user:secret@media.test:8080",
        ],
        [
          "Nama", "--player-lab", "--player-lab-base-url",
          "http://media.test:8080/?token=secret",
        ],
      ]

      for arguments in cases {
        guard case .invalid(let message) = PlayerLabLaunchConfiguration.parse(arguments: arguments)
        else {
          return XCTFail("Expected invalid configuration for \(arguments)")
        }
        XCTAssertFalse(message.isEmpty)
        XCTAssertFalse(message.contains("secret"))
      }
    }

    func testManifestDecodesRequiredFixtureCharacteristics() throws {
      let manifest = try PlayerLabManifest.decode(validManifestData())

      XCTAssertEqual(manifest.version, 1)
      XCTAssertEqual(manifest.fixtures.map(\.id), ["mkv-text"])
      XCTAssertEqual(manifest.fixtures[0].expected.container, "matroska")
      XCTAssertEqual(manifest.fixtures[0].expected.videoCodec, "hevc")
      XCTAssertEqual(manifest.fixtures[0].expected.dynamicRange, "sdr")
      XCTAssertEqual(manifest.fixtures[0].expected.audio[0].channels, 6)
      XCTAssertEqual(manifest.fixtures[0].expected.subtitles[0].representation, .text)
    }

    func testManifestRejectsUnsupportedVersionAndDuplicateFixtureIDs() throws {
      let unsupported = try replacing(
        in: validManifestData(), from: "\"version\": 1", to: "\"version\": 2")
      XCTAssertThrowsError(try PlayerLabManifest.decode(unsupported))

      let fixture = try fixtureObject()
      let duplicate = try JSONSerialization.data(withJSONObject: [
        "version": 1,
        "fixtures": [fixture, fixture],
      ])
      XCTAssertThrowsError(try PlayerLabManifest.decode(duplicate))
    }

    func testManifestRejectsDuplicateSidecarsAndUnsafeRelativePaths() throws {
      var fixture = try fixtureObject()
      let sidecar = (fixture["sidecars"] as! [[String: Any]])[0]
      fixture["sidecars"] = [sidecar, sidecar]
      let duplicateSidecars = try JSONSerialization.data(withJSONObject: [
        "version": 1,
        "fixtures": [fixture],
      ])
      XCTAssertThrowsError(try PlayerLabManifest.decode(duplicateSidecars))

      let unsafePaths = [
        "/private/movie.mkv",
        "../private/movie.mkv",
        "media\\..\\private\\movie.mkv",
        "media/%2e%2e/private/movie.mkv",
        "media/%252e%252e/private/movie.mkv",
        "media/%5c../private/movie.mkv",
        "media/%255c../private/movie.mkv",
        "http://media.test/movie.mkv",
        "media/movie.mkv?token=secret",
        "media/movie.mkv#secret",
      ]
      for path in unsafePaths {
        var unsafeFixture = try fixtureObject()
        unsafeFixture["mediaPath"] = path
        let data = try JSONSerialization.data(withJSONObject: [
          "version": 1,
          "fixtures": [unsafeFixture],
        ])
        XCTAssertThrowsError(try PlayerLabManifest.decode(data)) { error in
          guard let labError = error as? PlayerLabError, case .unsafeRelativePath = labError else {
            return XCTFail("Expected unsafeRelativePath for \(path), got \(error)")
          }
        }
      }
    }

    func testRelativePathResolutionUsesNormalizedSameOrigin() throws {
      let baseURL = URL(string: "http://MEDIA.test:80/")!

      let resolved = try PlayerLabURLResolver.resolve(
        relativePath: "media/Movie%20One.mkv",
        against: baseURL
      )

      XCTAssertEqual(resolved.absoluteString, "http://media.test/media/Movie%20One.mkv")
      XCTAssertEqual(
        try PlayerLabURLResolver.originURL(for: resolved).absoluteString,
        "http://media.test/"
      )
    }

    func testFixtureConversionBuildsMediaAndSidecarRequestsWithFixedDummyMarkers() throws {
      let fixture = try PlayerLabManifest.decode(validManifestData()).fixtures[0]

      let request = try fixture.playbackRequest(
        baseURL: URL(string: "http://media.test:8080/")!
      )

      XCTAssertEqual(request.media.url.absoluteString, "http://media.test:8080/media/movie.mkv")
      XCTAssertEqual(
        request.media.allowedRedirectOrigins.map(\.absoluteString),
        [
          "http://media.test:8080/"
        ])
      XCTAssertEqual(
        request.media.httpHeaders,
        [
          "Authorization": "Bearer nama-player-lab-dummy-authorization",
          "X-Emby-Token": "nama-player-lab-dummy-jellyfin",
          "X-Nama-Player-Lab-Marker": "nama-player-lab-dummy-marker",
        ])
      XCTAssertEqual(request.externalSubtitles.count, 1)
      XCTAssertEqual(request.externalSubtitles[0].id, "english-srt")
      XCTAssertEqual(
        request.externalSubtitles[0].locator.url.absoluteString,
        "http://media.test:8080/subtitles/movie.en.srt"
      )
      XCTAssertEqual(request.externalSubtitles[0].locator.mimeType, "application/x-subrip")
    }

    func testDiagnosticsKeepOnlyTheFixtureIDAndSanitizedError() throws {
      let fixture = try PlayerLabManifest.decode(validManifestData()).fixtures[0]
      XCTAssertEqual(PlayerLabDiagnostics.fixtureLabel(for: fixture), "Fixture: mkv-text")

      let sensitivePath = "media/Authorization-secret.mkv?token=secret"
      let data = try replacing(
        in: validManifestData(),
        from: "media/movie.mkv",
        to: sensitivePath
      )
      do {
        _ = try PlayerLabManifest.decode(data)
        XCTFail("Expected an unsafe path failure")
      } catch {
        XCTAssertEqual(error.localizedDescription, "A fixture contains an unsafe relative path.")
        XCTAssertFalse(error.localizedDescription.contains("Authorization"))
        XCTAssertFalse(error.localizedDescription.contains("secret"))
      }
    }

    private func validManifestData() -> Data {
      Data(
        #"""
        {
          "version": 1,
          "fixtures": [{
            "id": "mkv-text",
            "title": "MKV selectable audio and text subtitles",
            "mediaPath": "media/movie.mkv",
            "sidecars": [{
              "id": "english-srt",
              "label": "English",
              "language": "eng",
              "mimeType": "application/x-subrip",
              "path": "subtitles/movie.en.srt"
            }],
            "headerScenario": "dummyCredentials",
            "expected": {
              "container": "matroska",
              "videoCodec": "hevc",
              "dynamicRange": "sdr",
              "audio": [{"codec": "aac", "channels": 6, "label": "English 5.1"}],
              "subtitles": [{"representation": "text", "language": "eng"}]
            }
          }]
        }
        """#.utf8)
    }

    private func fixtureObject() throws -> [String: Any] {
      let object = try JSONSerialization.jsonObject(with: validManifestData()) as! [String: Any]
      return (object["fixtures"] as! [[String: Any]])[0]
    }

    private func replacing(in data: Data, from: String, to: String) throws -> Data {
      let source = try XCTUnwrap(String(data: data, encoding: .utf8))
      return Data(source.replacingOccurrences(of: from, with: to).utf8)
    }
  }
#endif
