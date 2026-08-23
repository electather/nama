import Foundation
import Testing

@testable import Nama

@Suite("Connection presentation contract")
struct ConnectionPresentationTests {
  @Test("shows the approved inline validation copy")
  func invalidAddressCopy() {
    #expect(
      String(localized: EndpointValidationError.invalid.message)
        == "Enter a valid HTTP or HTTPS server address."
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
  }

  @Test("entry and active requests expose the actions available on their forms")
  func formActions() throws {
    let endpoint = try NamaEndpoint("https://nama.example.com")

    #expect(ConnectionState.editing(showsValidationError: false).actions == [.connect])
    #expect(ConnectionState.verifying(endpoint).actions == [.connect, .cancel])
  }
}
