#if os(macOS)
  import Testing

  @testable import Nama

  @Suite("Playback presentation")
  struct PlaybackPresentationTests {
    @Test("projects every player state into visible playback chrome")
    func projectsPlayerStates() {
      let failure = NamaPlaybackFailure.sanitized(.network)

      #expect(PlaybackPresentationPhase(playerState: .idle) == .loading)
      #expect(PlaybackPresentationPhase(playerState: .loading) == .loading)
      #expect(PlaybackPresentationPhase(playerState: .playing) == .controls(.pause))
      #expect(PlaybackPresentationPhase(playerState: .paused) == .controls(.play))
      #expect(PlaybackPresentationPhase(playerState: .seeking) == .controls(nil))
      #expect(PlaybackPresentationPhase(playerState: .buffering) == .controls(.pause))
      #expect(PlaybackPresentationPhase(playerState: .ended) == .ended)
      #expect(PlaybackPresentationPhase(playerState: .failed(failure)) == .failed(failure))
    }
  }
#endif
