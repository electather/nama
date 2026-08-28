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

    @Test("exposes elapsed time when no equivalent timeline control exists")
    func exposesElapsedTimeWithoutKnownDuration() {
      #expect(
        PlaybackTimeReadoutAccessibility(position: 42, duration: nil)
          == .elapsed(.seconds(42))
      )
      #expect(
        PlaybackTimeReadoutAccessibility(position: 42, duration: 90) == .hidden
      )
    }

    @Test("localizes built-in track copy and preserves provider labels")
    func separatesTrackLabelSources() {
      guard case .localized = PlaybackTrackTitle.subtitlesOff else {
        Issue.record("The built-in subtitle action must remain localization-ready")
        return
      }
      guard case .verbatim(let label) = PlaybackTrackTitle.provider("Commentary") else {
        Issue.record("Provider track labels must remain verbatim")
        return
      }
      #expect(label == "Commentary")
    }

    @MainActor
    @Test("turns player construction failure into a visible preview state")
    func representsPreviewInitializationFailure() {
      enum PreviewFailure: Error {
        case expected
      }

      let state = PlaybackPreviewPlayer {
        throw PreviewFailure.expected
      }

      guard case .unavailable = state else {
        Issue.record("Player construction failures must render an unavailable state")
        return
      }
    }
  }
#endif
