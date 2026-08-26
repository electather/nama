#if os(macOS)
  import AppKit
  import Foundation
  import Testing
  // Swift Format and SwiftLint order these mixed-case module names differently.
  // swiftlint:disable:next sorted_imports
  import SwiftUI

  @testable import Nama

  @Suite("Nama playback", .serialized)
  actor NamaPlaybackTests {
    @Suite("Nama player locator security", .serialized)
    @MainActor
    struct NamaPlayerSecurityTests {
      @Test("rejects initial media outside the exact allowed origins")
      func rejectsInitialMediaOutsideAllowedOrigins() async throws {
        let server = try await PlaybackFixtureServer.start()
        defer { server.stop() }
        let player = try makePlaybackTestPlayer()
        defer { player.stop() }
        var allowedOrigin = try #require(
          URLComponents(url: server.origin, resolvingAgainstBaseURL: false)
        )
        allowedOrigin.host = "localhost"

        player.load(
          NamaPlayerRequest(
            media: NamaPlaybackLocator(
              url: server.origin.appendingPathComponent("sdr-master.m3u8"),
              headers: [NamaPlaybackLocatorHeader(name: "X-Nama-Fixture", value: "media")],
              allowedRedirectOrigins: [try #require(allowedOrigin.url)],
              mimeType: "application/vnd.apple.mpegurl",
              expiresAt: .distantFuture
            ),
            resumePosition: nil,
            externalSubtitles: []
          )
        )

        #expect(
          await securityPlaybackEventually {
            if case .failed = player.state {
              return true
            }
            return server.received(path: "/sdr-master.m3u8", marker: "media")
          }
        )
        #expect(player.state == .failed(.sanitized(.playbackUnavailable)))
        #expect(!server.received(path: "/sdr-master.m3u8", marker: "media"))
      }

      @Test("rejects a nested HLS destination outside the allowed origins")
      func rejectsNestedHLSDestinationOutsideAllowedOrigins() async throws {
        let forbiddenServer = try await PlaybackFixtureServer.start()
        defer { forbiddenServer.stop() }
        let playlist = """
          #EXTM3U
          #EXT-X-VERSION:3
          #EXT-X-TARGETDURATION:4
          #EXT-X-MEDIA-SEQUENCE:0
          #EXTINF:4.000,
          \(forbiddenServer.origin.appendingPathComponent("sdr-segment.ts").absoluteString)
          #EXT-X-ENDLIST

          """
        let sourceServer = try await PlaybackFixtureServer.start(
          routes: ["/nested-master.m3u8": .playlist(playlist)]
        )
        defer { sourceServer.stop() }
        let player = try makePlaybackTestPlayer()
        defer { player.stop() }

        player.load(
          NamaPlayerRequest(
            media: mediaLocator(
              server: sourceServer,
              path: "nested-master.m3u8",
              mimeType: "application/vnd.apple.mpegurl"
            ),
            resumePosition: nil,
            externalSubtitles: []
          )
        )

        #expect(
          await securityPlaybackEventually {
            if case .failed = player.state {
              return true
            }
            return forbiddenServer.received(path: "/sdr-segment.ts")
          }
        )
        #expect(!forbiddenServer.received(path: "/sdr-segment.ts"))
        guard case .failed = player.state else {
          Issue.record("Expected a safe failure for the blocked nested destination")
          return
        }
      }
      @Test("normalizes exact scheme, host, and effective port origins")
      func normalizesExactOrigins() throws {
        let implicitHTTPSURL = try #require(URL(string: "HTTPS://Example.COM"))
        let explicitHTTPSURL = try #require(URL(string: "https://example.com:443/"))
        let differentSchemeURL = try #require(URL(string: "http://example.com:443"))
        let pathURL = try #require(URL(string: "https://example.com/path"))
        let fragmentURL = try #require(URL(string: "https://example.com/path#playback"))
        let implicitHTTPS = try #require(
          NamaPlaybackOrigin(allowedOrigin: implicitHTTPSURL)
        )
        let explicitHTTPS = try #require(
          NamaPlaybackOrigin(allowedOrigin: explicitHTTPSURL)
        )
        let differentScheme = try #require(
          NamaPlaybackOrigin(allowedOrigin: differentSchemeURL)
        )
        let destinationWithFragment = try #require(
          NamaPlaybackOrigin(destination: fragmentURL)
        )

        #expect(implicitHTTPS == explicitHTTPS)
        #expect(implicitHTTPS == destinationWithFragment)
        #expect(implicitHTTPS != differentScheme)
        #expect(NamaPlaybackOrigin(allowedOrigin: pathURL) == nil)
      }

      @Test("allows a redirect and records header replay only between allowed origins")
      func allowsRedirectAndRecordsHeaderReplay() async throws {
        let destination = try await PlaybackFixtureServer.start()
        defer { destination.stop() }
        let redirectRoute = PlaybackFixtureRoute.redirect(
          location: destination.origin.appendingPathComponent("sdr-master.m3u8"),
          requiredMarker: "media"
        )
        let source = try await PlaybackFixtureServer.start(
          routes: ["/redirect.m3u8": redirectRoute]
        )
        defer { source.stop() }
        let player = try makePlaybackTestPlayer()
        defer { player.stop() }

        player.load(
          NamaPlayerRequest(
            media: mediaLocator(
              server: source,
              path: "redirect.m3u8",
              mimeType: "application/vnd.apple.mpegurl",
              allowedOrigins: [source.origin, destination.origin]
            ),
            resumePosition: nil,
            externalSubtitles: []
          )
        )

        #expect(
          await securityPlaybackEventually {
            if case .failed = player.state {
              return true
            }
            return destination.received(path: "/sdr-segment.ts", marker: "media")
          }
        )
        #expect(source.received(path: "/redirect.m3u8", marker: "media"))
        #expect(destination.received(path: "/sdr-master.m3u8", marker: "media"))
        #expect(destination.received(path: "/sdr-segment.ts", marker: "media"))
      }

      @Test("rejects a redirect to a non-allowlisted origin before contact")
      func rejectsRedirectOutsideAllowedOrigins() async throws {
        let forbiddenDestination = try await PlaybackFixtureServer.start()
        defer { forbiddenDestination.stop() }
        let redirectRoute = PlaybackFixtureRoute.redirect(
          location: forbiddenDestination.origin.appendingPathComponent("sdr-master.m3u8"),
          requiredMarker: "media"
        )
        let source = try await PlaybackFixtureServer.start(
          routes: ["/redirect.m3u8": redirectRoute]
        )
        defer { source.stop() }
        let player = try makePlaybackTestPlayer()
        defer { player.stop() }

        player.load(
          NamaPlayerRequest(
            media: mediaLocator(
              server: source,
              path: "redirect.m3u8",
              mimeType: "application/vnd.apple.mpegurl"
            ),
            resumePosition: nil,
            externalSubtitles: []
          )
        )

        #expect(
          await securityPlaybackEventually {
            if case .failed = player.state {
              return true
            }
            return forbiddenDestination.received(path: "/sdr-master.m3u8")
          }
        )
        #expect(!forbiddenDestination.received(path: "/sdr-master.m3u8"))
        guard case .failed = player.state else {
          Issue.record("Expected a safe failure for the blocked redirect")
          return
        }
      }

      private func mediaLocator(
        server: PlaybackFixtureServer,
        path: String,
        mimeType: String,
        allowedOrigins: [URL] = []
      ) -> NamaPlaybackLocator {
        let effectiveAllowedOrigins = allowedOrigins.isEmpty ? [server.origin] : allowedOrigins
        return NamaPlaybackLocator(
          url: server.origin.appendingPathComponent(path),
          headers: [NamaPlaybackLocatorHeader(name: "X-Nama-Fixture", value: "media")],
          allowedRedirectOrigins: effectiveAllowedOrigins,
          mimeType: mimeType,
          expiresAt: .distantFuture
        )
      }
    }
  }

  enum PlaybackSecurityTestTiming {
    static let timeoutSeconds: TimeInterval = 10
    static let pollIntervalSeconds: TimeInterval = 0.02
    static let timeout: Duration = .seconds(timeoutSeconds)
    static let pollInterval: Duration = .seconds(pollIntervalSeconds)
  }

  private enum PlaybackTestSurface {
    static let width: CGFloat = 320
    static let height: CGFloat = 180
    static let size = NSSize(width: width, height: height)
  }

  @MainActor
  func securityPlaybackEventually(
    timeout: Duration = PlaybackSecurityTestTiming.timeout,
    _ condition: @MainActor @Sendable () -> Bool
  ) async -> Bool {
    let clock = ContinuousClock()
    let deadline = clock.now.advanced(by: timeout)
    while clock.now < deadline {
      if condition() {
        return true
      }
      try? await Task.sleep(for: PlaybackSecurityTestTiming.pollInterval)
    }
    return condition()
  }

  func playbackTestRequest(
    server: PlaybackFixtureServer,
    path: String,
    mimeType: String,
    expiresAt: Date
  ) -> NamaPlayerRequest {
    NamaPlayerRequest(
      media: NamaPlaybackLocator(
        url: server.origin.appendingPathComponent(path),
        headers: [NamaPlaybackLocatorHeader(name: "X-Nama-Fixture", value: "media")],
        allowedRedirectOrigins: [server.origin],
        mimeType: mimeType,
        expiresAt: expiresAt
      ),
      resumePosition: nil,
      externalSubtitles: []
    )
  }

  @MainActor
  func hostPlaybackTestSurface(for player: NamaPlayer) -> NSWindow {
    let controller = NSHostingController(rootView: NamaPlayerSurface(player: player))
    let window = NSWindow(contentViewController: controller)
    window.setContentSize(PlaybackTestSurface.size)
    window.makeKeyAndOrderFront(nil)
    controller.view.layoutSubtreeIfNeeded()
    return window
  }

  @MainActor
  func makePlaybackTestPlayer() throws -> NamaPlayer {
    try NamaPlayer { _ in
      Issue.record("Unexpected Locator expiry")
    }
  }
#endif
