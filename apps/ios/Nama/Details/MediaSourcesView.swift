import SwiftUI

struct MediaSourcesView: View {
  @Environment(\.scenePhase) private var scenePhase

  let feature: MediaSourcesFeature
  let selection: MediaSourcesSelection
  let authorization: HomeAuthorizationIdentity
  let emitPlayIntent: @MainActor (MediaPlayIntent) -> Void
  let reauthorize: @MainActor () async -> Void

  var body: some View {
    MediaSourcesPresentationView(
      selection: selection,
      state: feature.state,
      inspect: feature.inspect,
      retry: feature.retry,
      play: emitPlay,
      reauthorize: reauthorize
    )
    .navigationTitle("Sources")
    .onAppear(perform: activateIfNeeded)
    .onChange(of: selection) { _, _ in
      activateIfNeeded()
    }
    .onChange(of: authorization) { _, _ in
      activateIfNeeded()
    }
    .onChange(of: scenePhase) { _, phase in
      if phase == .active {
        activateIfNeeded()
      } else {
        feature.deactivate(selection)
      }
    }
  }

  private func activateIfNeeded() {
    guard scenePhase == .active else {
      return
    }
    feature.select(selection, authorization: authorization)
  }

  private func emitPlay() {
    guard let intent = feature.play() else {
      return
    }
    emitPlayIntent(intent)
  }
}

struct MediaSourcesPresentationView: View {
  let selection: MediaSourcesSelection
  let state: MediaSourcesState
  let inspect: @MainActor (MediaSourceIdentity) -> Void
  let retry: @MainActor () -> Void
  let play: @MainActor () -> Void
  let reauthorize: @MainActor () async -> Void

  var body: some View {
    ScrollView {
      LazyVStack(alignment: .leading, spacing: MediaDetailsLayout.sectionSpacing) {
        VStack(alignment: .leading, spacing: MediaDetailsLayout.metadataSpacing) {
          Text(selection.mediaTitle)
            .font(.largeTitle.bold())
            .accessibilityAddTraits(.isHeader)
          Text("Choose a source to inspect its technical details.")
            .foregroundStyle(.secondary)
        }
        .frame(maxWidth: MediaDetailsLayout.proseMaximumWidth, alignment: .leading)

        MediaSourceChoicesView(
          summaries: selection.sourceSummaries,
          loadingIdentity: loadingIdentity,
          inspect: inspect
        )

        stateContent
      }
      .frame(maxWidth: MediaDetailsLayout.contentMaximumWidth, alignment: .leading)
      .padding(MediaDetailsLayout.contentPadding)
    }
  }

  @ViewBuilder
  private var stateContent: some View {
    switch state {
    case .idle, .choosing:
      EmptyView()

    case .loading(_, let summary):
      HStack(spacing: MediaDetailsLayout.metadataSpacing) {
        ProgressView()
        if let label = summary.label {
          Text("Loading \(label) details…")
        } else {
          Text("Loading Source details…")
        }
      }

    case .inspected(_, let summary, let source):
      MediaSourceTechnicalView(
        summary: summary,
        source: source,
        play: play,
        retry: retry
      )

    case .failed(_, _, let failure):
      MediaSourceFailureView(
        failure: failure,
        retry: retry,
        reauthorize: reauthorize
      )
    }
  }

  private var loadingIdentity: MediaSourceIdentity? {
    guard case .loading(_, let summary) = state else {
      return nil
    }
    return summary.identity
  }
}

private struct MediaSourceChoicesView: View {
  let summaries: [MediaSourceSummary]
  let loadingIdentity: MediaSourceIdentity?
  let inspect: @MainActor (MediaSourceIdentity) -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: MediaDetailsLayout.metadataSpacing) {
      Text("Sources")
        .font(.title2.bold())
        .accessibilityAddTraits(.isHeader)
      if summaries.isEmpty {
        ContentUnavailableView(
          "No Sources",
          systemImage: "rectangle.stack.badge.minus",
          description: Text("Return to Details and refresh this item.")
        )
      } else {
        ForEach(summaries, id: \.identity) { summary in
          Button {
            inspect(summary.identity)
          } label: {
            HStack(alignment: .top, spacing: MediaDetailsLayout.metadataSpacing) {
              MediaSourceSummaryView(summary: summary, availability: summary.availability)
              Spacer(minLength: MediaDetailsLayout.metadataSpacing)
              if loadingIdentity == summary.identity {
                ProgressView()
              } else {
                Image(systemName: "info.circle")
                  .accessibilityHidden(true)
              }
            }
          }
          .buttonStyle(.bordered)
          .disabled(loadingIdentity == summary.identity)
          .accessibilityHint("Loads technical details for this source")
        }
      }
    }
  }
}

private struct MediaSourceFailureView: View {
  let failure: MediaSourceFailure
  let retry: @MainActor () -> Void
  let reauthorize: @MainActor () async -> Void

  private var presentation: MediaSourceFailurePresentation {
    mediaSourceFailurePresentation(failure)
  }

  var body: some View {
    ContentUnavailableView {
      Label(presentation.title, systemImage: presentation.symbol)
    } description: {
      Text(presentation.message)
      if presentation.showsRetryGuidance {
        if let retryAfterSeconds = presentation.retryAfterSeconds {
          Text("Try again in about \(retryAfterSeconds) seconds.")
        } else {
          Text("Try again shortly.")
        }
      }
    } actions: {
      if presentation.requiresReauthorization {
        Button("Authorize Again") {
          Task { await reauthorize() }
        }
        .buttonStyle(.borderedProminent)
      } else {
        Button("Try Again", action: retry)
          .buttonStyle(.borderedProminent)
      }
    }
  }
}

private struct MediaSourceFailurePresentation {
  let title: LocalizedStringKey
  let symbol: String
  let message: LocalizedStringKey
  var requiresReauthorization = false
  var showsRetryGuidance = false
  var retryAfterSeconds: Int?

  static let missing = Self(
    title: "Source not found",
    symbol: "rectangle.stack.badge.minus",
    message: "This source is no longer available for this item. Try again or choose another source."
  )

  static func catalogNotReady(retryAfterSeconds: Int?) -> Self {
    Self(
      title: "Library is being prepared",
      symbol: "clock",
      message: "Your library is being prepared.",
      showsRetryGuidance: true,
      retryAfterSeconds: retryAfterSeconds
    )
  }

  static let unavailable = Self(
    title: "Source details are unavailable",
    symbol: "exclamationmark.triangle",
    message: "Nama could not load this source. Check this device’s connection, then try again."
  )

  static let canceled = Self(
    title: "Source request canceled",
    symbol: "exclamationmark.triangle",
    message: "Nama canceled this source request. Try again when you are ready."
  )

  static let authorizationUnavailable = Self(
    title: "Authorization required",
    symbol: "person.crop.circle.badge.exclamationmark",
    message: "Authorization is no longer available. Authorize again to continue.",
    requiresReauthorization: true
  )

  static let incompatible = Self(
    title: "Update required",
    symbol: "arrow.trianglehead.2.clockwise.rotate.90",
    message: "This app and Nama cannot inspect Sources together. Check for updates."
  )

  static let stale = Self(
    title: "Source changed",
    symbol: "arrow.clockwise",
    message:
      "The selected source no longer matches this item. Return to Details and refresh, or try again."
  )
}

private func mediaSourceFailurePresentation(
  _ failure: MediaSourceFailure
) -> MediaSourceFailurePresentation {
  switch failure {
  case .missing:
    .missing

  case .catalogNotReady(let retryAfterSeconds):
    .catalogNotReady(retryAfterSeconds: retryAfterSeconds)

  case .unavailable:
    .unavailable

  case .canceled:
    .canceled

  case .authorizationUnavailable:
    .authorizationUnavailable

  case .incompatible:
    .incompatible

  case .stale:
    .stale
  }
}
