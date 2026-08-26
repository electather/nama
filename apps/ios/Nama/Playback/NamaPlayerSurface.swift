import AVFoundation
import SwiftUI

nonisolated enum NamaSubtitleLayout {
  private enum NumpadAlignment: Int {
    case bottomLeading = 1
    case bottom = 2
    case bottomTrailing = 3
    case leading = 4
    case center = 5
    case trailing = 6
    case topLeading = 7
    case top = 8
    case topTrailing = 9
  }

  private static let verticalCenterDivisor: CGFloat = 2

  static func textAlignment(for rawValue: Int?) -> Alignment {
    switch alignment(for: rawValue) {
    case .bottomLeading:
      .bottomLeading

    case .bottom:
      .bottom

    case .bottomTrailing:
      .bottomTrailing

    case .leading:
      .leading

    case .center:
      .center

    case .trailing:
      .trailing

    case .topLeading:
      .topLeading

    case .top:
      .top

    case .topTrailing:
      .topTrailing
    }
  }

  static func textOffset(
    for position: CGPoint?,
    alignment rawValue: Int?,
    in contentRect: CGRect
  ) -> CGSize {
    guard let position else {
      return .zero
    }
    let alignment = alignment(for: rawValue)
    let anchorX =
      switch alignment {
      case .bottomLeading, .leading, .topLeading:
        contentRect.minX

      case .bottom, .center, .top:
        contentRect.midX

      case .bottomTrailing, .trailing, .topTrailing:
        contentRect.maxX
      }
    let anchorY =
      switch alignment {
      case .bottomLeading, .bottom, .bottomTrailing:
        contentRect.maxY

      case .leading, .center, .trailing:
        contentRect.midY

      case .topLeading, .top, .topTrailing:
        contentRect.minY
      }
    let targetX = contentRect.minX + position.x * contentRect.width
    let targetY = contentRect.minY + position.y * contentRect.height
    return CGSize(width: targetX - anchorX, height: targetY - anchorY)
  }

  static func imageRect(
    position: CGRect,
    canvasSize: CGSize,
    in contentRect: CGRect
  ) -> CGRect {
    guard canvasSize.width > 0, canvasSize.height > 0 else {
      return CGRect(
        x: contentRect.minX + position.minX * contentRect.width,
        y: contentRect.minY + position.minY * contentRect.height,
        width: position.width * contentRect.width,
        height: position.height * contentRect.height
      )
    }
    let scale = contentRect.width / canvasSize.width
    let canvasMinY =
      contentRect.midY - canvasSize.height * scale / Self.verticalCenterDivisor
    return CGRect(
      x: contentRect.minX + position.minX * canvasSize.width * scale,
      y: canvasMinY + position.minY * canvasSize.height * scale,
      width: position.width * canvasSize.width * scale,
      height: position.height * canvasSize.height * scale
    )
  }

  private static func alignment(for rawValue: Int?) -> NumpadAlignment {
    rawValue.flatMap(NumpadAlignment.init(rawValue:)) ?? .bottom
  }
}

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
      let alignment = NamaSubtitleLayout.textAlignment(for: cue.placement?.alignment)
      let offset = NamaSubtitleLayout.textOffset(
        for: cue.placement?.position,
        alignment: cue.placement?.alignment,
        in: contentRect
      )
      subtitleText(text)
        .frame(
          width: contentRect.width,
          height: contentRect.height,
          alignment: alignment
        )
        .position(x: contentRect.midX, y: contentRect.midY)
        .offset(offset)

    case .image(let image, let position, let canvasSize):
      let imageRect = NamaSubtitleLayout.imageRect(
        position: position,
        canvasSize: canvasSize,
        in: contentRect
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
