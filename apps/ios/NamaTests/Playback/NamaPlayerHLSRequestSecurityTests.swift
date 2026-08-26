#if os(macOS)
  import Foundation
  import Testing

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

      @Test("rejects non-allowlisted children in an extensionless generic nested playlist")
      func rejectsExtensionlessNestedPlaylistEscape() async throws {
        let forbiddenServer = try await PlaybackFixtureServer.start()
        defer { forbiddenServer.stop() }
        let nestedPlaylist = """
          #EXTM3U
          #EXT-X-VERSION:3
          #EXT-X-TARGETDURATION:4
          #EXT-X-MEDIA-SEQUENCE:0
          #EXTINF:4.000,
          \(forbiddenServer.origin.appendingPathComponent("sdr-segment.ts").absoluteString)
          #EXT-X-ENDLIST

          """
        let sourceServer = try await PlaybackFixtureServer.start(
          routes: [
            "/extensionless-master.m3u8": .playlist(Self.extensionlessRootPlaylist),
            "/extensionless-video": .content(
              contentType: "application/octet-stream",
              data: Data(nestedPlaylist.utf8),
              requiredMarker: "media"
            ),
          ]
        )
        defer { sourceServer.stop() }
        let player = try makePlaybackTestPlayer()
        defer { player.stop() }
        player.load(
          playbackTestRequest(
            server: sourceServer,
            path: "extensionless-master.m3u8",
            mimeType: "application/vnd.apple.mpegurl",
            expiresAt: .distantFuture
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
        #expect(sourceServer.received(path: "/extensionless-video", marker: "media"))
        #expect(!forbiddenServer.received(path: "/sdr-segment.ts"))
        guard case .failed = player.state else {
          Issue.record("Expected a safe failure for the blocked extensionless playlist child")
          return
        }
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
        let window = hostPlaybackTestSurface(for: player)
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
          }
        )
        #expect(
          !(await securityPlaybackEventually(timeout: .seconds(Self.redirectObservationSeconds)) {
            forbiddenServer.received(path: "/subtitle.srt")
          })
        )
      }

      private static let redirectObservationSeconds: TimeInterval = 1

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

      private static let rootPlaylist = """
        #EXTM3U
        #EXT-X-VERSION:3
        #EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="English",DEFAULT=YES,AUTOSELECT=YES,URI="audio.m3u8"
        #EXT-X-STREAM-INF:BANDWIDTH=250000,CODECS="avc1.42c00a,mp4a.40.2",RESOLUTION=160x90,AUDIO="audio"
        video.m3u8

        """

      private static let extensionlessRootPlaylist = """
        #EXTM3U
        #EXT-X-VERSION:3
        #EXT-X-STREAM-INF:BANDWIDTH=250000,CODECS="avc1.42c00a,mp4a.40.2",RESOLUTION=160x90
        extensionless-video

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
