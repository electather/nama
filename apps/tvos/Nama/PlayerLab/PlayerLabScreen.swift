#if DEBUG
  import SwiftUI

  struct PlayerLabScreen: View {
    let baseURL: URL

    @State private var state: State = .loading

    var body: some View {
      Group {
        switch state {
        case .loading:
          ProgressView("Loading Player Lab…")
        case .fixtures(let fixtures):
          fixtureList(fixtures)
        case .playing(let fixture, let request):
          PlayerScreenBoundary(
            request: request,
            diagnosticsLabel: PlayerLabDiagnostics.fixtureLabel(for: fixture),
            backToFixtures: loadManifest
          )
        case .failed(let message):
          PlayerLabFailureScreen(message: message, retry: loadManifest)
        }
      }
      .task { loadManifest() }
    }

    private func fixtureList(_ fixtures: [PlayerLabFixture]) -> some View {
      NavigationStack {
        List(fixtures) { fixture in
          Button {
            play(fixture)
          } label: {
            VStack(alignment: .leading, spacing: 6) {
              Text(fixture.title)
              Text(fixture.id).font(.caption.monospaced()).foregroundStyle(.secondary)
            }
          }
        }
        .navigationTitle("Player Lab")
      }
    }

    private func loadManifest() {
      do {
        state = .fixtures(try PlayerLabManifest.load().fixtures)
      } catch {
        state = .failed(error.localizedDescription)
      }
    }

    private func play(_ fixture: PlayerLabFixture) {
      do {
        state = .playing(fixture, try fixture.playbackRequest(baseURL: baseURL))
      } catch {
        state = .failed(error.localizedDescription)
      }
    }

    private enum State {
      case loading
      case fixtures([PlayerLabFixture])
      case playing(PlayerLabFixture, PlaybackRequest)
      case failed(String)
    }
  }

  struct PlayerLabFailureScreen: View {
    let message: String
    let retry: (() -> Void)?

    var body: some View {
      VStack(spacing: 24) {
        Text("Player Lab Unavailable").font(.title)
        Text(message).multilineTextAlignment(.center)
        if let retry {
          Button("Retry", action: retry).buttonStyle(.borderedProminent)
        }
      }
      .padding(60)
    }
  }
#endif
