import SwiftUI

struct MediaDetailsCreditsView: View {
  @State private var showsAllCredits = false

  let directors: [MediaCredit]
  let writers: [MediaCredit]
  let initialCast: [MediaCredit]
  let allCredits: [MediaCredit]
  let artwork: MediaCreditArtworkAccess

  var body: some View {
    if !allCredits.isEmpty {
      VStack(alignment: .leading, spacing: MediaDetailsLayout.creditSpacing) {
        Text("Credits")
          .font(.title2.bold())
          .accessibilityAddTraits(.isHeader)
        MediaConciseCrewView(directors: directors, writers: writers)
        if showsAllCredits {
          MediaAllCreditsView(credits: allCredits)
        } else if !initialCast.isEmpty {
          MediaInitialCastView(credits: initialCast, artwork: artwork)
        }
        Button(showsAllCredits ? "Show Less" : "See All Credits") {
          showsAllCredits.toggle()
        }
      }
      .frame(maxWidth: MediaDetailsLayout.proseMaximumWidth, alignment: .leading)
    }
  }
}

private struct MediaConciseCrewView: View {
  @Environment(\.locale) private var locale

  let directors: [MediaCredit]
  let writers: [MediaCredit]

  var body: some View {
    if !directors.isEmpty {
      LabeledContent(
        "Directors",
        value: mediaDetailsFormattedList(directors.map(\.name), locale: locale)
      )
    }
    if !writers.isEmpty {
      LabeledContent(
        "Writers",
        value: mediaDetailsFormattedList(writers.map(\.name), locale: locale)
      )
    }
  }
}

private struct MediaInitialCastView: View {
  let credits: [MediaCredit]
  let artwork: MediaCreditArtworkAccess

  var body: some View {
    Text("Cast")
      .font(.headline)
    ScrollView(.horizontal) {
      LazyHStack(alignment: .top, spacing: MediaDetailsLayout.creditSpacing) {
        ForEach(credits) { credit in
          MediaCastCreditView(credit: credit, artwork: artwork)
        }
      }
    }
    .scrollIndicators(.hidden)
  }
}

private struct MediaAllCreditsView: View {
  let credits: [MediaCredit]

  var body: some View {
    LazyVStack(alignment: .leading, spacing: MediaDetailsLayout.creditSpacing) {
      ForEach(credits) { credit in
        MediaCreditRow(credit: credit)
      }
    }
  }
}

private struct MediaCastCreditView: View {
  @Environment(\.displayScale) private var displayScale
  @ScaledMetric(relativeTo: .body) private var width = 140.0

  let credit: MediaCredit
  let artwork: MediaCreditArtworkAccess

  var body: some View {
    VStack(alignment: .leading, spacing: MediaDetailsLayout.metadataSpacing) {
      MediaCreditArtworkSurface(
        presentation: artwork.presentationState(credit.identity).presentation
      )
      .frame(width: width, height: width)
      .onAppear(perform: loadArtwork)
      .onChange(of: width) { _, _ in loadArtwork() }
      .onChange(of: displayScale) { _, _ in loadArtwork() }
      .onChange(of: credit.portraitArtwork?.identity) { _, _ in loadArtwork() }
      .onDisappear {
        artwork.didDisappear(credit.identity)
      }
      Text(credit.name)
        .font(.headline)
      if let characterName = credit.characterName {
        Text(characterName)
          .font(.subheadline)
          .foregroundStyle(.secondary)
      }
    }
    .frame(width: width, alignment: .leading)
    .accessibilityElement(children: .combine)
  }

  private func loadArtwork() {
    artwork.didAppear(
      credit,
      .poster(displayWidth: width, scale: displayScale)
    )
  }
}

private struct MediaCreditArtworkSurface: View {
  let presentation: HomeArtworkPresentation?

  var body: some View {
    RoundedRectangle(cornerRadius: MediaDetailsLayout.artworkCornerRadius)
      .fill(.quaternary)
      .overlay {
        if let presentation {
          Image(decorative: presentation.image, scale: MediaDetailsLayout.imageScale)
            .resizable()
            .scaledToFill()
        } else {
          Image(systemName: "person.crop.circle")
            .resizable()
            .scaledToFit()
            .foregroundStyle(.secondary)
            .padding(MediaDetailsLayout.metadataSpacing)
            .accessibilityHidden(true)
        }
      }
      .compositingGroup()
      .clipShape(.rect(cornerRadius: MediaDetailsLayout.artworkCornerRadius))
  }
}

private struct MediaCreditRow: View {
  let credit: MediaCredit

  var body: some View {
    VStack(alignment: .leading, spacing: MediaDetailsLayout.creditDetailSpacing) {
      Text(credit.name)
        .font(.headline)
      HStack(spacing: MediaDetailsLayout.metadataSpacing) {
        Text(mediaCreditRoleTitle(credit.role))
        if let characterName = credit.characterName {
          Text(characterName)
        }
      }
      .font(.subheadline)
      .foregroundStyle(.secondary)
    }
    .accessibilityElement(children: .combine)
  }
}

private func mediaCreditRoleTitle(_ role: MediaCreditRole) -> LocalizedStringKey {
  switch role {
  case .actor:
    "Cast"

  case .director:
    "Director"

  case .writer:
    "Writer"
  }
}
