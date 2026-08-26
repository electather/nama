#if os(macOS)
  import AppKit
  import Foundation
  import Testing
  // Swift Format and SwiftLint order these mixed-case module names differently.
  // swiftlint:disable:next sorted_imports
  import SwiftUI

  @testable import Nama

  extension NamaPlaybackTests {
    @Suite("Nama player HLS request security", .serialized)
    @MainActor
    struct NamaPlayerHLSRequestSecurityTests {
      @Test("routes allowed variant, rendition, segment, and key requests through the real adapter")
      func routesAllowedNestedHLSRequests() async throws {
        let server = try await PlaybackFixtureServer.start(
          routes: [
            "/nested-root.m3u8": .playlist(Self.rootPlaylist),
            "/video.m3u8": .playlist(Self.mediaPlaylist),
            "/audio.m3u8": .playlist(Self.mediaPlaylist),
            "/key.bin": .content(
              contentType: "application/octet-stream",
              data: Data("0123456789abcdef".utf8),
              requiredMarker: "media"
            ),
          ]
        )
        defer { server.stop() }
        let player = try makePlaybackTestPlayer()
        defer { player.stop() }
        player.load(
          NamaPlayerRequest(
            media: NamaPlaybackLocator(
              url: server.origin.appendingPathComponent("nested-root.m3u8"),
              headers: [NamaPlaybackLocatorHeader(name: "X-Nama-Fixture", value: "media")],
              allowedRedirectOrigins: [server.origin],
              mimeType: "application/vnd.apple.mpegurl",
              expiresAt: .distantFuture
            ),
            resumePosition: nil,
            externalSubtitles: []
          )
        )

        #expect(
          await securityPlaybackEventually {
            server.received(path: "/video.m3u8", marker: "media")
              && server.received(path: "/audio.m3u8", marker: "media")
              && server.received(path: "/key.bin", marker: "media")
              && server.received(path: "/sdr-segment.ts", marker: "media")
          }
        )
        #expect(server.received(path: "/nested-root.m3u8", marker: "media"))
      }

      @Test("rejects an external subtitle redirect outside its allowed origins")
      func rejectsExternalSubtitleRedirect() async throws {
        let forbiddenServer = try await PlaybackFixtureServer.start()
        defer { forbiddenServer.stop() }
        let redirectRoute = PlaybackFixtureRoute.redirect(
          location: forbiddenServer.origin.appendingPathComponent("subtitle.srt"),
          requiredMarker: "subtitle"
        )
        let sourceServer = try await PlaybackFixtureServer.start(
          routes: ["/subtitle-redirect.srt": redirectRoute]
        )
        defer { sourceServer.stop() }
        let subtitleID = "redirected-subtitle"
        let player = try makePlaybackTestPlayer()
        let window = hostSurface(for: player)
        defer {
          player.stop()
          window.close()
        }
        player.load(subtitleRedirectRequest(server: sourceServer, trackID: subtitleID))
        #expect(
          await securityPlaybackEventually {
            player.subtitleTracks.contains { $0.id == subtitleID }
          }
        )

        player.selectSubtitleTrack(id: subtitleID)

        #expect(
          await securityPlaybackEventually {
            sourceServer.received(path: "/subtitle-redirect.srt", marker: "subtitle")
              || forbiddenServer.received(path: "/subtitle.srt")
          }
        )
        #expect(sourceServer.received(path: "/subtitle-redirect.srt", marker: "subtitle"))
        #expect(!forbiddenServer.received(path: "/subtitle.srt"))
      }

      private func subtitleRedirectRequest(
        server: PlaybackFixtureServer,
        trackID: String
      ) -> NamaPlayerRequest {
        let subtitle = NamaExternalSubtitleLocator(
          trackID: trackID,
          label: "Redirected subtitle",
          language: "eng",
          isDefault: false,
          isForced: false,
          locator: NamaPlaybackLocator(
            url: server.origin.appendingPathComponent("subtitle-redirect.srt"),
            headers: [NamaPlaybackLocatorHeader(name: "X-Nama-Fixture", value: "subtitle")],
            allowedRedirectOrigins: [server.origin],
            mimeType: "application/x-subrip",
            expiresAt: .distantFuture
          )
        )
        return NamaPlayerRequest(
          media: NamaPlaybackLocator(
            url: server.origin.appendingPathComponent("sdr-master.m3u8"),
            headers: [NamaPlaybackLocatorHeader(name: "X-Nama-Fixture", value: "media")],
            allowedRedirectOrigins: [server.origin],
            mimeType: "application/vnd.apple.mpegurl",
            expiresAt: .distantFuture
          ),
          resumePosition: nil,
          externalSubtitles: [subtitle]
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

      private static let rootPlaylist = """
        #EXTM3U
        #EXT-X-VERSION:3
        #EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="English",DEFAULT=YES,AUTOSELECT=YES,URI="audio.m3u8"
        #EXT-X-STREAM-INF:BANDWIDTH=250000,CODECS="avc1.42c00a,mp4a.40.2",RESOLUTION=160x90,AUDIO="audio"
        video.m3u8

        """

      private static let mediaPlaylist = """
        #EXTM3U
        #EXT-X-VERSION:3
        #EXT-X-TARGETDURATION:4
        #EXT-X-MEDIA-SEQUENCE:0
        #EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x00000000000000000000000000000000
        #EXTINF:4.000,
        sdr-segment.ts
        #EXT-X-ENDLIST

        """
    }
  }
#endif
