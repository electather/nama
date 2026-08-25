import AVFoundation
import SwiftUI

struct NamaPlayerSurface: View {
  let player: NamaPlayer

  var body: some View {
    ZStack {
      player.surface
      NamaSubtitleOverlay(
        cues: player.subtitleCues,
        clock: player.clock,
        presentationSize: presentationSize
      )
    }
    .background(.black)
  }

  private var presentationSize: CGSize? {
    guard
      let width = player.videoCharacteristics?.width,
      let height = player.videoCharacteristics?.height
    else {
      return nil
    }
    return CGSize(width: width, height: height)
  }
}

private struct NamaSubtitleOverlay: View {
  let cues: [NamaPlaybackSubtitleCue]
  let clock: NamaPlayerClock
  let presentationSize: CGSize?

  var body: some View {
    GeometryReader { geometry in
      let bounds = CGRect(origin: .zero, size: geometry.size)
      let contentRect =
        presentationSize.map { size in
          AVMakeRect(aspectRatio: size, insideRect: bounds)
        } ?? bounds
      ForEach(activeCues) { cue in
        cueView(cue, contentRect: contentRect)
      }
    }
    .allowsHitTesting(false)
  }

  private var activeCues: [NamaPlaybackSubtitleCue] {
    cues.filter { cue in
      cue.startTime <= clock.state.position && clock.state.position <= cue.endTime
    }
  }

  @ViewBuilder
  private func cueView(
    _ cue: NamaPlaybackSubtitleCue,
    contentRect: CGRect
  ) -> some View {
    switch cue.body {
    case .text(let text):
      if let position = cue.placement?.position {
        subtitleText(text)
          .frame(width: contentRect.width)
          .position(
            x: contentRect.minX + position.x * contentRect.width,
            y: contentRect.minY + position.y * contentRect.height
          )
      } else {
        subtitleText(text)
          .frame(
            width: contentRect.width,
            height: contentRect.height,
            alignment: .bottom
          )
          .position(x: contentRect.midX, y: contentRect.midY)
      }

    case .image(let image, let position, _):
      let imageRect = CGRect(
        x: contentRect.minX + position.minX * contentRect.width,
        y: contentRect.minY + position.minY * contentRect.height,
        width: position.width * contentRect.width,
        height: position.height * contentRect.height
      )
      Image(decorative: image, scale: 1)
        .resizable()
        .frame(width: imageRect.width, height: imageRect.height)
        .position(x: imageRect.midX, y: imageRect.midY)
    }
  }

  private func subtitleText(_ text: String) -> some View {
    Text(text)
      .font(.title2.weight(.semibold))
      .multilineTextAlignment(.center)
      .padding()
      .foregroundStyle(.white)
      .background(.black)
      .accessibilityIdentifier("nama-playback-subtitle")
  }
}
