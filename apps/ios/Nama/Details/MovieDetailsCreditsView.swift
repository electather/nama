import SwiftUI

struct MovieDetailsCreditsView: View {
  @State private var showsAllCredits = false

  let directors: [MovieCredit]
  let writers: [MovieCredit]
  let initialCast: [MovieCredit]
  let allCredits: [MovieCredit]

  var body: some View {
    if !allCredits.isEmpty {
      VStack(alignment: .leading, spacing: MovieDetailsLayout.creditSpacing) {
        Text("Credits")
          .font(.title2.bold())
          .accessibilityAddTraits(.isHeader)
        MovieConciseCrewView(directors: directors, writers: writers)
        if showsAllCredits {
          MovieAllCreditsView(credits: allCredits)
        } else if !initialCast.isEmpty {
          MovieInitialCastView(credits: initialCast)
        }
        Button(showsAllCredits ? "Show Less" : "See All Credits") {
          showsAllCredits.toggle()
        }
      }
      .frame(maxWidth: MovieDetailsLayout.proseMaximumWidth, alignment: .leading)
    }
  }
}

private struct MovieConciseCrewView: View {
  @Environment(\.locale) private var locale

  let directors: [MovieCredit]
  let writers: [MovieCredit]

  var body: some View {
    if !directors.isEmpty {
      LabeledContent(
        "Directors",
        value: movieDetailsFormattedList(directors.map(\.name), locale: locale)
      )
    }
    if !writers.isEmpty {
      LabeledContent(
        "Writers",
        value: movieDetailsFormattedList(writers.map(\.name), locale: locale)
      )
    }
  }
}

private struct MovieInitialCastView: View {
  let credits: [MovieCredit]

  var body: some View {
    Text("Cast")
      .font(.headline)
    ScrollView(.horizontal) {
      LazyHStack(alignment: .top, spacing: MovieDetailsLayout.creditSpacing) {
        ForEach(credits) { credit in
          MovieCastCreditView(credit: credit)
        }
      }
    }
    .scrollIndicators(.hidden)
  }
}

private struct MovieAllCreditsView: View {
  let credits: [MovieCredit]

  var body: some View {
    LazyVStack(alignment: .leading, spacing: MovieDetailsLayout.creditSpacing) {
      ForEach(credits) { credit in
        MovieCreditRow(credit: credit)
      }
    }
  }
}

private struct MovieCastCreditView: View {
  @ScaledMetric(relativeTo: .body) private var width = 140.0

  let credit: MovieCredit

  var body: some View {
    VStack(alignment: .leading, spacing: MovieDetailsLayout.metadataSpacing) {
      Image(systemName: "person.crop.circle")
        .resizable()
        .scaledToFit()
        .foregroundStyle(.secondary)
        .frame(width: width, height: width)
        .accessibilityHidden(true)
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
}

private struct MovieCreditRow: View {
  let credit: MovieCredit

  var body: some View {
    VStack(alignment: .leading, spacing: MovieDetailsLayout.creditDetailSpacing) {
      Text(credit.name)
        .font(.headline)
      HStack(spacing: MovieDetailsLayout.metadataSpacing) {
        Text(movieCreditRoleTitle(credit.role))
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

private func movieCreditRoleTitle(_ role: MovieCreditRole) -> LocalizedStringKey {
  switch role {
  case .actor:
    "Cast"

  case .director:
    "Director"

  case .writer:
    "Writer"
  }
}
