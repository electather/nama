#if os(macOS)
  import AppKit
  import Observation
  import SwiftUI
  import Testing

  @testable import Nama

  @Suite("Nama player boundary", .serialized)
  @MainActor
  struct NamaPlayerTests {
    @Test("clamps displayed and requested times to a known duration")
    func clampsClock() {
      let clock = NamaPlayerClockState(
        position: 125,
        duration: 120,
        bufferedPosition: 130,
        seekTarget: 150
      )

      #expect(clock.position == 120)
      #expect(clock.duration == 120)
      #expect(clock.bufferedPosition == 120)
      #expect(clock.seekTarget == 120)
      #expect(clock.clampedSeekTarget(-5) == 0)
      #expect(clock.clampedSeekTarget(125) == 120)
    }

    @Test("classifies XSUB as a bitmap subtitle format")
    func classifiesXSUB() {
      #expect(NamaPlayer.subtitleRepresentation("xsub") == .image)
    }

    @Test("loads, renders, and stops controlled SDR HLS")
    func controlledSDRHLS() async throws {
      let server = try await PlaybackFixtureServer.start()
      defer { server.stop() }
      let player = try NamaPlayer()
      let window = hostSurface(for: player)
      defer {
        player.stop()
        window.close()
      }
      let subtitle = externalSubtitle(from: server)
      player.load(
        NamaPlayerRequest(
          media: mediaLocator(
            server: server,
            path: "sdr-master.m3u8",
            mimeType: "application/vnd.apple.mpegurl"
          ),
          resumePosition: 1,
          externalSubtitles: [subtitle]
        )
      )

      #expect(
        await playbackEventually {
          player.hasFirstFrame
            && player.state == .playing
            && player.subtitleTracks.contains { $0.id == subtitle.trackID }
            && player.videoCharacteristics?.sourceDynamicRange == .sdr
            && player.videoCharacteristics?.width == 160
            && player.videoCharacteristics?.height == 90
        }
      )
      #expect(server.received(path: "/sdr-master.m3u8", marker: "media"))
      #expect(server.received(path: "/sdr-segment.ts", marker: "media"))
      #expect(player.clock.state.position >= 0.9)
      #expect(player.videoCharacteristics?.width == 160)
      #expect(player.videoCharacteristics?.height == 90)

      player.selectSubtitleTrack(id: subtitle.trackID)
      #expect(
        await playbackEventually {
          player.selectedSubtitleTrackID == subtitle.trackID
        }
      )
      #expect(
        await server.waitUntilReceived(path: "/subtitle.srt", marker: "subtitle")
      )
      player.disableSubtitles()
      #expect(await playbackEventually { player.selectedSubtitleTrackID == nil })

      player.stop()
      assertStopped(player)
    }

    @Test("maps transport, seek, and track selection to the real engine")
    func controlsAndTracks() async throws {
      let server = try await PlaybackFixtureServer.start()
      defer { server.stop() }
      let player = try NamaPlayer()
      let window = hostSurface(for: player)
      defer {
        player.stop()
        window.close()
      }
      let subtitle = externalSubtitle(from: server)
      player.load(
        NamaPlayerRequest(
          media: mediaLocator(
            server: server,
            path: "track-controls.mkv",
            mimeType: "video/x-matroska"
          ),
          resumePosition: 1,
          externalSubtitles: [subtitle]
        )
      )

      await verifyTracksReady(player)

      try await verifySubtitleRendering(
        player: player,
        window: window,
        subtitleID: subtitle.trackID
      )
      player.play()
      #expect(await playbackEventually { player.state == .playing })

      let alternateAudio = try #require(
        player.audioTracks.first { $0.id != player.selectedAudioTrackID }
      )
      player.selectAudioTrack(id: alternateAudio.id)
      #expect(
        await playbackEventually { player.selectedAudioTrackID == alternateAudio.id }
      )

      let duration = try #require(player.clock.state.duration)
      let expectedPosition = min(5, duration / 2)
      #expect(player.seek(to: expectedPosition) == expectedPosition)
      #expect(
        await playbackEventually {
          abs(player.clock.state.position - expectedPosition) < 0.5
            && player.state == .playing
        }
      )
      #expect(player.clock.state.position <= duration)
      player.stop()
      assertStopped(player)
    }

    @Test("sanitizes engine and network failure details")
    func sanitizesFailure() async throws {
      let server = try await PlaybackFixtureServer.start()
      defer { server.stop() }
      let player = try NamaPlayer()
      defer { player.stop() }
      let secretURL = server.origin
        .appendingPathComponent("missing.m3u8")
        .appending(queryItems: [URLQueryItem(name: "token", value: "secret-url")])

      player.load(
        NamaPlayerRequest(
          media: NamaPlaybackLocator(
            url: secretURL,
            headers: [
              NamaPlaybackLocatorHeader(name: "X-Fixture-Secret", value: "secret-header")
            ],
            allowedRedirectOrigins: [server.origin],
            mimeType: "application/vnd.apple.mpegurl"
          ),
          resumePosition: nil,
          externalSubtitles: []
        )
      )

      #expect(
        await playbackEventually {
          if case .failed = player.state { true } else { false }
        }
      )
      guard case .failed(let failure) = player.state else {
        Issue.record("Expected a sanitized playback failure")
        return
      }
      #expect(failure.category == .network)
      let summary = String(localized: failure.summary)
      #expect(!summary.contains("secret-url"))
      #expect(!summary.contains("secret-header"))
      #expect(!summary.contains(server.origin.absoluteString))
    }

    private func mediaLocator(
      server: PlaybackFixtureServer,
      path: String,
      mimeType: String
    ) -> NamaPlaybackLocator {
      NamaPlaybackLocator(
        url: server.origin.appendingPathComponent(path),
        headers: [NamaPlaybackLocatorHeader(name: "X-Nama-Fixture", value: "media")],
        allowedRedirectOrigins: [server.origin],
        mimeType: mimeType
      )
    }

    private func externalSubtitle(
      from server: PlaybackFixtureServer
    ) -> NamaExternalSubtitleLocator {
      NamaExternalSubtitleLocator(
        trackID: "session-subtitle-english",
        label: "English",
        language: "eng",
        isDefault: false,
        isForced: false,
        locator: NamaPlaybackLocator(
          url: server.origin.appendingPathComponent("subtitle.srt"),
          headers: [NamaPlaybackLocatorHeader(name: "X-Nama-Fixture", value: "subtitle")],
          allowedRedirectOrigins: [server.origin],
          mimeType: "application/x-subrip"
        )
      )
    }

    private func verifyTracksReady(_ player: NamaPlayer) async {
      #expect(
        await playbackEventually {
          player.state == .playing && player.audioTracks.count == 2
        }
      )
      #expect(player.audioTracks.allSatisfy { Int($0.id) == nil })
    }

    private func renderedPixels(in window: NSWindow) -> Data? {
      guard
        let view = window.contentView,
        let representation = view.bitmapImageRepForCachingDisplay(in: view.bounds)
      else {
        return nil
      }
      view.layoutSubtreeIfNeeded()
      view.cacheDisplay(in: view.bounds, to: representation)
      return representation.representation(using: .png, properties: [:])
    }

    private func verifySubtitleRendering(
      player: NamaPlayer,
      window: NSWindow,
      subtitleID: String
    ) async throws {
      player.pause()
      #expect(await playbackEventually { player.state == .paused })
      let subtitle = try #require(player.subtitleTracks.first { $0.id == subtitleID })
      let frameWithoutSubtitle = try #require(renderedPixels(in: window))
      player.selectSubtitleTrack(id: subtitle.id)
      #expect(
        await playbackEventually {
          player.selectedSubtitleTrackID == subtitle.id && !player.subtitleCues.isEmpty
        }
      )
      let frameWithSubtitle = try #require(renderedPixels(in: window))
      #expect(frameWithSubtitle != frameWithoutSubtitle)
      player.disableSubtitles()
      #expect(await playbackEventually { player.selectedSubtitleTrackID == nil })
    }

    private func assertStopped(_ player: NamaPlayer) {
      #expect(player.state == .idle)
      #expect(player.clock.state == NamaPlayerClockState())
      #expect(player.audioTracks.isEmpty)
      #expect(player.subtitleTracks.isEmpty)
      #expect(!player.hasFirstFrame)
    }

    private func hostSurface(for player: NamaPlayer) -> NSWindow {
      let window = NSWindow(
        contentRect: CGRect(x: 0, y: 0, width: 640, height: 360),
        styleMask: [.borderless],
        backing: .buffered,
        defer: false
      )
      window.contentView = NSHostingView(rootView: NamaPlayerSurface(player: player))
      window.orderFrontRegardless()
      return window
    }
  }

  @Suite("Nama player redirect policy", .serialized)
  @MainActor
  struct NamaPlayerRedirectTests {
    @Test("rejects redirects outside the Locator origin allowlist")
    func rejectsDisallowedRedirectOrigin() async throws {
      let target = try await PlaybackFixtureServer.start()
      defer { target.stop() }
      let rejectedURL = target.origin.appendingPathComponent("missing.m3u8")
      let source = try await PlaybackFixtureServer.start(
        redirects: ["/redirect.m3u8": rejectedURL]
      )
      defer { source.stop() }
      let player = try NamaPlayer()
      defer { player.stop() }

      player.load(
        NamaPlayerRequest(
          media: NamaPlaybackLocator(
            url: source.origin.appendingPathComponent("redirect.m3u8"),
            headers: [NamaPlaybackLocatorHeader(name: "X-Nama-Fixture", value: "media")],
            allowedRedirectOrigins: [source.origin],
            mimeType: "application/vnd.apple.mpegurl"
          ),
          resumePosition: nil,
          externalSubtitles: []
        )
      )

      #expect(
        await playbackEventually {
          if case .failed = player.state { true } else { false }
        }
      )
      #expect(!target.received(path: "/missing.m3u8"))
    }

    @Test("follows redirects within the Locator origin allowlist")
    func followsAllowedRedirectOrigin() async throws {
      let target = try await PlaybackFixtureServer.start()
      defer { target.stop() }
      let allowedURL = target.origin.appendingPathComponent("sdr-master.m3u8")
      let source = try await PlaybackFixtureServer.start(
        redirects: ["/redirect.m3u8": allowedURL]
      )
      defer { source.stop() }
      let player = try NamaPlayer()
      defer { player.stop() }

      player.load(
        NamaPlayerRequest(
          media: NamaPlaybackLocator(
            url: source.origin.appendingPathComponent("redirect.m3u8"),
            headers: [NamaPlaybackLocatorHeader(name: "X-Nama-Fixture", value: "media")],
            allowedRedirectOrigins: [source.origin, target.origin],
            mimeType: "application/vnd.apple.mpegurl"
          ),
          resumePosition: nil,
          externalSubtitles: []
        )
      )

      #expect(
        await target.waitUntilReceived(path: "/sdr-master.m3u8", marker: "media")
      )
      #expect(
        await target.waitUntilReceived(path: "/sdr-segment.ts", marker: "media")
      )
      #expect(await playbackEventually { player.state == .playing })
    }
  }

  @Suite("Nama subtitle layout")
  struct NamaSubtitleLayoutTests {
    private static let topLeadingAlignment = 7
    private static let middleAlignment = 5
    private static let bottomTrailingAlignment = 3

    @Test("maps ASS numpad alignment to the matching surface anchor")
    func mapsTextAlignment() {
      #expect(
        NamaSubtitleLayout.textAlignment(for: Self.topLeadingAlignment) == .topLeading
      )
      #expect(NamaSubtitleLayout.textAlignment(for: Self.middleAlignment) == .center)
      #expect(
        NamaSubtitleLayout.textAlignment(for: Self.bottomTrailingAlignment) == .bottomTrailing
      )
      #expect(NamaSubtitleLayout.textAlignment(for: nil) == .bottom)
    }

    @Test("maps bitmap cues through their authored canvas")
    func mapsBitmapCanvas() {
      let imageRect = NamaSubtitleLayout.imageRect(
        position: CGRect(x: 0.1, y: 0.8, width: 0.2, height: 0.1),
        canvasSize: CGSize(width: 1_920, height: 1_080),
        in: CGRect(x: 10, y: 20, width: 1_920, height: 800)
      )

      #expect(imageRect == CGRect(x: 202, y: 744, width: 384, height: 108))
    }
  }

  @MainActor
  private func playbackEventually(
    _ condition: @MainActor @Sendable () -> Bool
  ) async -> Bool {
    while !condition() {
      await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
        withObservationTracking {
          _ = condition()
        } onChange: {
          continuation.resume()
        }
      }
    }
    return true
  }
#endif
