import Foundation
import SwiftUI

struct MediaDetailsParentNavigationView: View {
  let parents: [MediaDetailsParent]

  var body: some View {
    if !parents.isEmpty {
      ScrollView(.horizontal) {
        HStack(spacing: MediaDetailsLayout.metadataSpacing) {
          ForEach(parents, id: \.identity) { parent in
            NavigationLink(
              value: ConsumerNavigationDestination.details(
                MediaDetailsSelection(
                  identity: parent.identity,
                  kind: parent.kind,
                  title: parent.title
                )
              )
            ) {
              Label(parent.title, systemImage: parent.kind.detailsSystemImage)
            }
          }
        }
      }
      .scrollIndicators(.hidden)
      .accessibilityLabel("Canonical parent context")
    }
  }
}

struct MediaDetailsMetadataView: View {
  let metadata: [MediaDetailsMetadata]

  var body: some View {
    if !metadata.isEmpty {
      VStack(alignment: .leading, spacing: MediaDetailsLayout.metadataSpacing) {
        ForEach(metadata) { item in
          metadataRow(item)
        }
      }
      .font(.headline)
      .foregroundStyle(.secondary)
    }
  }

  @ViewBuilder
  private func metadataRow(_ item: MediaDetailsMetadata) -> some View {
    if let descriptive = item.descriptiveMetadata {
      MediaDetailsDescriptiveMetadataRow(metadata: descriptive)
    } else if let count = item.countMetadata {
      MediaDetailsCountMetadataRow(metadata: count)
    }
  }
}

private struct MediaDetailsDescriptiveMetadataRow: View {
  let metadata: MediaDetailsDescriptiveMetadata

  @ViewBuilder
  var body: some View {
    switch metadata {
    case .releaseDate(let date):
      LabeledContent("Released") { MediaCalendarDateText(date: date) }

    case .firstReleaseDate(let date):
      LabeledContent("First released") { MediaCalendarDateText(date: date) }

    case .lastReleaseDate(let date):
      LabeledContent("Last released") { MediaCalendarDateText(date: date) }

    case .releaseYear(let year):
      LabeledContent("Released") {
        Text(year, format: .number.grouping(.never))
      }

    case .runtime(let runtime):
      LabeledContent("Runtime") {
        Text(runtime, format: .time(pattern: .hourMinute))
      }

    case .contentRating(let rating):
      LabeledContent("Rating", value: rating)

    case .primaryGenre(let genre):
      LabeledContent("Genre", value: genre)
    }
  }
}

private struct MediaDetailsCountMetadataRow: View {
  let metadata: MediaDetailsCountMetadata

  @ViewBuilder
  var body: some View {
    switch metadata {
    case .seasonCount(let count):
      LabeledContent("Seasons") { Text(count, format: .number) }

    case .episodeCount(let count):
      LabeledContent("Episodes") { Text(count, format: .number) }

    case .seasonNumber(let number):
      LabeledContent("Season") { Text(number, format: .number) }

    case .episodeNumber(let number):
      LabeledContent("Episode") { Text(number, format: .number) }
    }
  }
}
struct MediaDetailsSupportingContentView: View {
  let details: MediaDetails
  let creditArtwork: MediaCreditArtworkAccess

  var body: some View {
    MediaDetailsDescriptionView(
      tagline: details.tagline,
      synopsis: details.synopsis
    )
    MediaDetailsSupportingMetadataView(
      genres: details.genres,
      studios: details.studios
    )
    MediaDetailsCreditsView(
      directors: details.directors,
      writers: details.writers,
      initialCast: details.initialCast,
      allCredits: details.credits,
      artwork: creditArtwork
    )
  }
}

private struct MediaCalendarDateText: View {
  private static let referenceLeapYear = 2_000

  let date: MediaCalendarDate

  var body: some View {
    if let resolvedDate {
      if date.year == nil {
        Text(resolvedDate, format: .dateTime.month(.wide).day())
      } else if date.day == nil {
        Text(resolvedDate, format: .dateTime.year().month(.wide))
      } else {
        Text(resolvedDate, format: .dateTime.year().month(.wide).day())
      }
    } else if let year = date.year {
      Text(year, format: .number.grouping(.never))
    }
  }

  private var resolvedDate: Date? {
    guard date.month != nil else {
      return nil
    }
    var components = DateComponents()
    components.calendar = Calendar(identifier: .gregorian)
    components.year = Int(date.year ?? Int32(Self.referenceLeapYear))
    components.month = date.month.map(Int.init)
    components.day = Int(date.day ?? 1)
    return components.date
  }
}

struct MediaDetailsChildrenView: View {
  #if os(tvOS)
    @State private var retainedChildFocus: (identity: MediaIdentity?, position: Int?) = (nil, nil)
    @FocusState private var focusedChildIdentity: MediaIdentity?
  #endif

  let parentKind: MediaKind
  let state: MediaChildrenState
  let refreshRecoveryIsActive: Bool
  let loadMore: @MainActor () -> Void
  let childDidAppear: @MainActor (MediaIdentity) -> Void
  let reauthorize: @MainActor () async -> Void
  let artwork: MediaChildArtworkAccess

  var body: some View {
    VStack(alignment: .leading, spacing: MediaDetailsLayout.metadataSpacing) {
      Text(childTitle)
        .font(.title2.bold())
        .accessibilityAddTraits(.isHeader)
      if state.confirmedItems.isEmpty {
        emptyOrLoadingContent
      } else {
        #if os(tvOS)
          VStack(alignment: .leading, spacing: MediaDetailsLayout.creditSpacing) {
            childRows
          }
        #else
          LazyVStack(alignment: .leading, spacing: MediaDetailsLayout.creditSpacing) {
            childRows
          }
        #endif
      }
    }
    #if os(tvOS)
      .task(id: state.confirmedItems.map(\.identity)) {
        requestInitialFocus()
      }
      .onChange(of: refreshRecoveryIsActive) { _, isActive in
        if !isActive {
          requestInitialFocus()
        }
      }
      .onChange(of: focusedChildIdentity) { _, identity in
        if let identity {
          retainedChildFocus.identity = identity
          retainedChildFocus.position = state.confirmedItems.firstIndex { $0.identity == identity }
        }
      }
    #endif
  }

  @ViewBuilder
  private var childRows: some View {
    ForEach(state.confirmedItems) { item in
      MediaChildRow(
        item: item,
        childDidAppear: childDidAppear,
        artwork: artwork
      )
      #if os(tvOS)
        .focused($focusedChildIdentity, equals: item.identity)
      #endif
    }
    pageFooter
  }

  #if os(tvOS)
    private func requestInitialFocus() {
      let available = state.confirmedItems.map(\.identity)
      if let target = mediaChildrenTelevisionFocusIdentity(
        current: retainedChildFocus.identity,
        retainedPosition: retainedChildFocus.position,
        available: available,
        refreshRecoveryIsActive: refreshRecoveryIsActive
      ) {
        retainedChildFocus.identity = target
        retainedChildFocus.position = available.firstIndex(of: target)
        focusedChildIdentity = target
      }
    }
  #endif

  private var childTitle: LocalizedStringKey {
    switch parentKind {
    case .show:
      "Seasons"

    case .season:
      "Episodes"

    case .movie, .episode:
      "Children"
    }
  }

  private var childLoadingTitle: LocalizedStringKey {
    switch parentKind {
    case .show:
      "Loading Seasons…"

    case .season:
      "Loading Episodes…"

    case .movie, .episode:
      "Loading children…"
    }
  }

  private var childEmptyTitle: LocalizedStringKey {
    switch parentKind {
    case .show:
      "No Seasons"

    case .season:
      "No Episodes"

    case .movie, .episode:
      "No Children"
    }
  }

  private var childSystemImage: String {
    switch parentKind {
    case .show:
      "rectangle.stack"

    case .season:
      "play.rectangle"

    case .movie, .episode:
      "rectangle.stack"
    }
  }

  @ViewBuilder
  private var emptyOrLoadingContent: some View {
    switch state {
    case .loading:
      ProgressView(childLoadingTitle)

    case .content:
      ContentUnavailableView(
        childEmptyTitle,
        systemImage: childSystemImage
      )

    case .notApplicable:
      EmptyView()

    case .loadingMore, .pageFailed:
      pageFooter
    }
  }

  @ViewBuilder
  private var pageFooter: some View {
    #if os(tvOS)
      televisionPageFooter
    #else
      switch state {
      case .loadingMore:
        ProgressView("Loading more…")

      case .pageFailed(_, _, let failure):
        MediaChildrenPageFailureView(
          failure: failure,
          retry: loadMore,
          reauthorize: reauthorize
        )

      case .notApplicable, .loading, .content:
        EmptyView()
      }
    #endif
  }

  #if os(tvOS)
    @ViewBuilder
    private var televisionPageFooter: some View {
      if let action = mediaChildrenTelevisionAction(for: state) {
        Button(pageActionTitle(action)) {
          if action == .reauthorize {
            Task { await reauthorize() }
          } else {
            loadMore()
          }
        }
        .id(MediaChildrenFocusIdentity.loadMore)
      }
    }

    private func pageActionTitle(_ action: MediaChildrenTelevisionAction) -> LocalizedStringKey {
      switch action {
      case .loadMore:
        "Load More"

      case .loading:
        "Loading More…"

      case .retry:
        "Retry Load More"

      case .reauthorize:
        "Authorize Again"
      }
    }
  #endif
}

private struct MediaChildrenPageFailureView: View {
  let failure: MediaDetailsFailure
  let retry: @MainActor () -> Void
  let reauthorize: @MainActor () async -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: MediaDetailsLayout.metadataSpacing) {
      Label("More items could not be loaded", systemImage: "exclamationmark.triangle")
        .font(.headline)
      MediaDetailsRetryGuidance(failure: failure)
      if failure == .authorizationUnavailable {
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

private enum MediaChildrenFocusIdentity: Hashable {
  case loadMore
}
