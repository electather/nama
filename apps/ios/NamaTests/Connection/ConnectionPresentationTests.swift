import Foundation
import SwiftUI
import Testing

@testable import Nama

@Suite("Connection presentation contract")
struct ConnectionPresentationTests {
  @Test("shows the approved inline validation copy")
  func invalidAddressCopy() {
    #expect(
      String(localized: EndpointValidationError.invalid.message)
        == "Enter a valid HTTP or HTTPS Nama endpoint."
    )
  }

  @Test("shows the HTTPS requirement for forbidden HTTP")
  func httpsRequiredCopy() {
    #expect(
      String(localized: EndpointValidationError.requiresHTTPS.message)
        == "This Nama endpoint requires HTTPS."
    )
  }

  @Test("shows non-destructive recovery for a blocked saved endpoint")
  func savedEndpointHTTPSRequiredCopy() {
    #expect(String(localized: SavedEndpointHTTPSRequiredCopy.title) == "HTTPS required")
    #expect(
      String(localized: SavedEndpointHTTPSRequiredCopy.message)
        == "This saved Nama endpoint can no longer be contacted over HTTP. Change the endpoint to use HTTPS."
    )
  }

  @Test("shows the approved local HTTP confirmation and warning semantics")
  func localHTTPCopyAndSemantics() {
    #expect(String(localized: LocalHTTPConfirmationCopy.title) == "Connect without HTTPS?")
    #expect(
      String(localized: LocalHTTPConfirmationCopy.message)
        == "Traffic to this Nama endpoint won’t be encrypted. Continue only if you trust this endpoint and network."
    )
    #expect(
      String(localized: LocalHTTPWarningCopy.message)
        == "HTTP connection — traffic is not encrypted."
    )
    #expect(LocalHTTPWarningCopy.systemImage == "exclamationmark.triangle.fill")
    #expect(
      String(localized: LocalHTTPWarningCopy.accessibilityLabel)
        == "HTTP connection — traffic is not encrypted."
    )
  }

  @MainActor
  @Test("a long endpoint expands the production endpoint control instead of truncating")
  func longEndpointExpandsEndpointControl() throws {
    let shortEndpoint = try NamaEndpoint("http://nama.local")
    let longEndpoint = try NamaEndpoint(
      "http://nama.local/a/very/long/reverse/proxy/path/that/must/remain/visible/to/the/person/"
    )
    let shortHeight = try renderedEndpointHeight(for: shortEndpoint)
    let longHeight = try renderedEndpointHeight(for: longEndpoint)
    #expect(longHeight > shortHeight)
  }

  @Test("every selected local HTTP state exposes the unencrypted warning")
  func selectedLocalHTTPWarningStates() throws {
    let httpEndpoint = try NamaEndpoint("http://nama.local/very/long/reverse/proxy/path/")
    let httpsEndpoint = try NamaEndpoint("https://nama.example.com")
    let localHTTPStates: [ConnectionState] = [
      .checkingHTTPAcknowledgement(httpEndpoint),
      .confirmingHTTP(httpEndpoint, .entry),
      .verifying(httpEndpoint),
      .ready(httpEndpoint),
      .setupRequired(httpEndpoint),
      .failed(httpEndpoint, .cannotConnect),
      .pausedHTTPRestoration(httpEndpoint),
    ]
    let httpsStates: [ConnectionState] = [
      .checkingHTTPAcknowledgement(httpsEndpoint),
      .confirmingHTTP(httpsEndpoint, .entry),
      .verifying(httpsEndpoint),
      .ready(httpsEndpoint),
      .setupRequired(httpsEndpoint),
      .failed(httpsEndpoint, .cannotConnect),
      .pausedHTTPRestoration(httpsEndpoint),
    ]

    #expect(!localHTTPStates.map(\.showsUnencryptedHTTPWarning).contains(false))
    #expect(httpsStates.allSatisfy { !$0.showsUnencryptedHTTPWarning })
    #expect(!ConnectionState.editing(validationError: nil).showsUnencryptedHTTPWarning)
    #expect(
      !ConnectionState.requiresHTTPS(HTTPSRequiredEndpoint("http://nama.example.com"))
        .showsUnencryptedHTTPWarning
    )
  }

  @Test(
    "maps failures to approved safe copy",
    arguments: [
      (VerificationFailure.namaUnavailable, "Nama is temporarily unavailable. Try again."),
      (
        VerificationFailure.cannotConnect,
        "Couldn’t connect to this address. Check the address and network connection, then try again."
      ),
      (
        VerificationFailure.incompatible,
        "This address did not respond as a compatible Nama server."
      ),
    ]
  )
  func safeFailureCopy(failure: VerificationFailure, expected: String) {
    #expect(String(localized: failure.message) == expected)
  }

  @Test(
    "maps discovery states to approved copy",
    arguments: [
      (
        NamaDiscoveryState.scanning,
        "Looking for Nama servers…",
        Optional<String>.none
      ),
      (
        NamaDiscoveryState.empty,
        "No Nama servers found",
        "Make sure Nama is running on this network, or enter its address."
      ),
      (
        NamaDiscoveryState.permissionDenied,
        "Local Network Access Is Off",
        "Enable Local Network access in Settings to find nearby Nama servers, or enter an address manually."
      ),
      (
        NamaDiscoveryState.failed,
        "Couldn’t search for Nama servers",
        "Try again, or enter the Nama address manually."
      ),
    ]
  )
  func discoveryCopy(
    state: NamaDiscoveryState,
    expectedTitle: String,
    expectedMessage: String?
  ) {
    #expect(state.title.map(String.init(localized:)) == expectedTitle)
    #expect(state.message.map(String.init(localized:)) == expectedMessage)
  }

  @Test("terminal states expose only their approved actions")
  func terminalActions() throws {
    let endpoint = try NamaEndpoint("https://nama.example.com")

    #expect(ConnectionState.ready(endpoint).actions == [.changeEndpoint])
    #expect(ConnectionState.setupRequired(endpoint).actions == [.retry, .changeEndpoint])
    #expect(
      ConnectionState.failed(endpoint, .cannotConnect).actions == [.retry, .changeEndpoint]
    )
    #expect(
      ConnectionState.requiresHTTPS(HTTPSRequiredEndpoint("http://nama.example.com/")).actions
        == [.changeEndpoint]
    )
  }

  @Test("entry and active requests expose the actions available on their forms")
  func formActions() throws {
    let endpoint = try NamaEndpoint("https://nama.example.com")
    let httpEndpoint = try NamaEndpoint("http://nama.local")

    #expect(ConnectionState.editing(validationError: nil).actions == [.connect])
    #expect(
      ConnectionState.checkingHTTPAcknowledgement(httpEndpoint).actions
        == [.connect, .cancel, .changeEndpoint]
    )
    #expect(
      ConnectionState.confirmingHTTP(httpEndpoint, .entry).actions
        == [.cancel, .continueWithoutHTTPS]
    )
    #expect(
      ConnectionState.verifying(endpoint).actions == [.connect, .cancel, .changeEndpoint]
    )
    #expect(
      ConnectionState.pausedHTTPRestoration(httpEndpoint).actions
        == [.continueWithoutHTTPS, .changeEndpoint]
    )
  }

  @Test("television confirmation defaults to safe and recoverable actions")
  func televisionHTTPFocus() throws {
    let endpoint = try NamaEndpoint("http://nama.local")

    #expect(
      ConnectionState.confirmingHTTP(endpoint, .entry).televisionFocus
        == .action(.cancel)
    )
    #expect(
      ConnectionState.pausedHTTPRestoration(endpoint).televisionFocus
        == .action(.continueWithoutHTTPS)
    )
  }
}

@MainActor
private func renderedEndpointHeight(for endpoint: NamaEndpoint) throws -> Int {
  let presentationWidth: CGFloat = 320
  let renderer = ImageRenderer(
    content: EndpointValue(endpoint: endpoint)
      .frame(width: presentationWidth, alignment: .leading)
  )
  let image = try #require(renderer.cgImage)
  return image.height
}
