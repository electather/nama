#if os(macOS)
  import AppKit
  import Foundation
  import SwiftUI
  import Testing

  @testable import Nama

  extension NamaPlaybackTests {
    @Suite("Nama player lifecycle", .serialized)
    @MainActor
    struct NamaPlayerLifecycleTests {
      @Test("closing the owning playback surface stops the active load")
      func closingOwningSurfaceStopsLoad() async throws {
        let server = try await PlaybackFixtureServer.start()
        defer { server.stop() }
        let player = try makePlaybackTestPlayer()
        defer { player.stop() }
        let window = hostSurface(for: player)
        player.load(
          playerRequest(
            server: server,
            path: "sdr-master.m3u8",
            mimeType: "application/vnd.apple.mpegurl",
            expiresAt: .distantFuture
          )
        )
        #expect(await securityPlaybackEventually { player.state == .playing })

        window.contentViewController = nil
        window.close()

        #expect(await securityPlaybackEventually { player.state == .idle })
      }

      @Test("foreground loss stops the active load")
      func foregroundLossStopsLoad() async throws {
        let server = try await PlaybackFixtureServer.start()
        defer { server.stop() }
        let player = try makePlaybackTestPlayer()
        let window = hostSurface(for: player)
        defer {
          player.stop()
          window.close()
        }
        player.load(
          playerRequest(
            server: server,
            path: "sdr-master.m3u8",
            mimeType: "application/vnd.apple.mpegurl",
            expiresAt: .distantFuture
          )
        )
        #expect(await securityPlaybackEventually { player.state == .playing })

        player.owningSceneLostForeground()

        #expect(player.state == .idle)
      }

      @Test("a newer complete load replaces all old session state without surfacing cancellation")
      func replacementDiscardsOldLoad() async throws {
        let oldServer = try await PlaybackFixtureServer.start()
        defer { oldServer.stop() }
        let newServer = try await PlaybackFixtureServer.start()
        defer { newServer.stop() }
        let oldSubtitleID = "old-session-subtitle"
        let oldRequest = oldPlayerRequest(server: oldServer, subtitleID: oldSubtitleID)
        let newRequest = playerRequest(
          server: newServer,
          path: "sdr-master.m3u8",
          mimeType: "application/vnd.apple.mpegurl",
          expiresAt: .distantFuture
        )
        let player = try makePlaybackTestPlayer()
        let window = hostSurface(for: player)
        defer {
          player.stop()
          window.close()
        }
        player.load(oldRequest)
        #expect(
          await securityPlaybackEventually {
            player.state == .playing && player.audioTracks.count == 2
              && player.subtitleTracks.contains { $0.id == oldSubtitleID }
          }
        )
        let oldAudioTrackIDs = Set(player.audioTracks.map(\.id))

        player.load(newRequest)

        assertReplacementStateReset(player)
        let oldRequestCount = oldServer.requestCount(path: "/track-controls.mkv")
        #expect(
          await securityPlaybackEventually {
            player.state == .playing
              && newServer.received(path: "/sdr-segment.ts", marker: "media")
          }
        )
        try await Task.sleep(for: .seconds(Self.replacementObservationDelaySeconds))
        #expect(oldServer.requestCount(path: "/track-controls.mkv") == oldRequestCount)
        #expect(
          newServer.receivedHeader(path: "/sdr-master.m3u8", name: "X-Old-Locator") == nil
        )
        #expect(player.audioTracks.allSatisfy { !oldAudioTrackIDs.contains($0.id) })
        guard case .failed = player.state else {
          return
        }
        Issue.record("Expected replacement cancellation to remain invisible")
      }

      private static let replacementObservationDelaySeconds: TimeInterval = 0.2

      private func oldPlayerRequest(
        server: PlaybackFixtureServer,
        subtitleID: String
      ) -> NamaPlayerRequest {
        let subtitle = NamaExternalSubtitleLocator(
          trackID: subtitleID,
          label: "Old subtitle",
          language: "eng",
          isDefault: false,
          isForced: false,
          locator: NamaPlaybackLocator(
            url: server.origin.appendingPathComponent("subtitle.srt"),
            headers: [NamaPlaybackLocatorHeader(name: "X-Nama-Fixture", value: "subtitle")],
            allowedRedirectOrigins: [server.origin],
            mimeType: "application/x-subrip",
            expiresAt: .distantFuture
          )
        )
        return NamaPlayerRequest(
          media: NamaPlaybackLocator(
            url: server.origin.appendingPathComponent("track-controls.mkv"),
            headers: [
              NamaPlaybackLocatorHeader(name: "X-Nama-Fixture", value: "media"),
              NamaPlaybackLocatorHeader(name: "X-Old-Locator", value: "old-secret"),
            ],
            allowedRedirectOrigins: [server.origin],
            mimeType: "video/x-matroska",
            expiresAt: .distantFuture
          ),
          resumePosition: nil,
          externalSubtitles: [subtitle]
        )
      }

      private func assertReplacementStateReset(_ player: NamaPlayer) {
        #expect(player.state == .loading)
        #expect(player.audioTracks.isEmpty)
        #expect(player.subtitleTracks.isEmpty)
        #expect(player.subtitleCues.isEmpty)
        #expect(player.selectedAudioTrackID == nil)
        #expect(player.selectedSubtitleTrackID == nil)
        #expect(player.videoCharacteristics == nil)
        #expect(player.clock.state == NamaPlayerClockState())
      }

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

#endif
