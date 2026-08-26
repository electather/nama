#if os(macOS)
  import AppKit
  import Foundation
  import SwiftUI
  import Testing

  @testable import Nama

  extension NamaPlaybackTests {
    @Suite("Nama player expiry lifecycle", .serialized)
    @MainActor
    struct NamaPlayerExpiryLifecycleTests {
      @Test(
        "expiry stops the old load and requests one complete replacement at the clamped position")
      func replacesExpiredLocator() async throws {
        let server = try await PlaybackFixtureServer.start()
        defer { server.stop() }
        let replacement = playerRequest(
          server: server,
          path: "sdr-master.m3u8",
          mimeType: "application/vnd.apple.mpegurl",
          expiresAt: .distantFuture
        )
        var expiredPosition: TimeInterval?
        let playerBox = ExpiryWeakPlayerBox()
        let player = try NamaPlayer { position in
          expiredPosition = position
          playerBox.player?.load(replacement)
        }
        playerBox.player = player
        let window = hostSurface(for: player)
        defer {
          player.stop()
          window.close()
        }
        player.load(
          playerRequest(
            server: server,
            path: "track-controls.mkv",
            mimeType: "video/x-matroska",
            expiresAt: Date().addingTimeInterval(Self.expiryDelaySeconds)
          )
        )

        #expect(
          await securityPlaybackEventually {
            player.state == .playing && player.clock.state.duration != nil
          }
        )
        let requestedPosition = try #require(player.clock.state.duration)
        let expectedPosition = player.seek(to: requestedPosition + Self.positionBeyondDuration)

        #expect(
          await securityPlaybackEventually {
            expiredPosition != nil && server.received(path: "/sdr-master.m3u8", marker: "media")
          }
        )
        #expect(expiredPosition == expectedPosition)
        #expect(player.state != .failed(.sanitized(.playbackUnavailable)))
      }
      @Test("an already-expired replacement stops the old load and signals its clamped position")
      func alreadyExpiredReplacementSignalsCoordinator() async throws {
        let server = try await PlaybackFixtureServer.start()
        defer { server.stop() }
        var expiredPosition: TimeInterval?
        let player = try NamaPlayer { position in
          expiredPosition = position
        }
        let window = hostSurface(for: player)
        defer {
          player.stop()
          window.close()
        }
        player.load(
          playerRequest(
            server: server,
            path: "track-controls.mkv",
            mimeType: "video/x-matroska",
            expiresAt: .distantFuture
          )
        )
        #expect(
          await securityPlaybackEventually {
            player.state == .playing && player.clock.state.duration != nil
          }
        )
        let duration = try #require(player.clock.state.duration)
        let expectedPosition = player.seek(to: duration + Self.positionBeyondDuration)
        #expect(
          await securityPlaybackEventually {
            abs(player.clock.state.position - expectedPosition) < Self.positionTolerance
          }
        )
        let currentPosition = player.clock.state.position
        player.load(
          playerRequest(
            server: server,
            path: "sdr-master.m3u8",
            mimeType: "application/vnd.apple.mpegurl",
            expiresAt: .distantPast
          )
        )

        #expect(expiredPosition == currentPosition)
        #expect(player.state == .idle)
        #expect(!server.received(path: "/sdr-master.m3u8"))
      }
      @Test("expiry stops a stalled initial request before the engine load can finish")
      func stalledInitialRequestExpiresImmediately() async throws {
        let stallRoute = PlaybackFixtureRoute.stall(requiredMarker: "media")
        let server = try await PlaybackFixtureServer.start(routes: ["/stall.mkv": stallRoute])
        defer { server.stop() }
        var didExpire = false
        let player = try NamaPlayer { _ in
          didExpire = true
        }
        defer { player.stop() }
        player.load(
          playerRequest(
            server: server,
            path: "stall.mkv",
            mimeType: "video/x-matroska",
            expiresAt: Date().addingTimeInterval(Self.inFlightExpiryDelaySeconds)
          )
        )
        #expect(
          await securityPlaybackEventually {
            server.received(path: "/stall.mkv", marker: "media")
          }
        )

        #expect(await securityPlaybackEventually { didExpire })
        #expect(player.state == .idle)
      }

      private static let expiryDelaySeconds: TimeInterval = 2
      private static let inFlightExpiryDelaySeconds: TimeInterval = 0.5
      private static let positionTolerance: TimeInterval = 0.5
      private static let positionBeyondDuration: TimeInterval = 10

      private func playerRequest(
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

      private func hostSurface(for player: NamaPlayer) -> NSWindow {
        let controller = NSHostingController(rootView: NamaPlayerSurface(player: player))
        let window = NSWindow(contentViewController: controller)
        window.setContentSize(NSSize(width: 320, height: 180))
        window.makeKeyAndOrderFront(nil)
        controller.view.layoutSubtreeIfNeeded()
        return window
      }
    }
  }

  @MainActor
  private final class ExpiryWeakPlayerBox {
    weak var player: NamaPlayer?
  }
#endif
