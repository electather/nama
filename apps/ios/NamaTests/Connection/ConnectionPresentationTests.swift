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
