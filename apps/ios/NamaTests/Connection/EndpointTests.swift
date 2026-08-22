import Foundation
import Testing

@testable import Nama

@Suite("Nama endpoint normalization")
struct EndpointTests {
  @Test(
    "normalizes scheme, host, default port, and trailing slash",
    arguments: [
      (" HTTPS://Nama.Example.COM:443 ", "https://nama.example.com/"),
      ("http://Nama.Example.COM:80/proxy", "http://nama.example.com/proxy/"),
      ("https://nama.example.com:8443/proxy/", "https://nama.example.com:8443/proxy/"),
    ]
  )
  func normalizes(input: String, expected: String) throws {
    let endpoint = try NamaEndpoint(input)

    #expect(endpoint.absoluteString == expected)
  }

  @Test("preserves a reverse-proxy path prefix")
  func preservesReverseProxyPrefix() throws {
    let endpoint = try NamaEndpoint("https://nama.example.com/media%20services/nama")

    #expect(endpoint.absoluteString == "https://nama.example.com/media%20services/nama/")
  }

  @Test(
    "rejects addresses outside the Nama endpoint shape",
    arguments: [
      "nama.example.com",
      "ftp://nama.example.com",
      "https:///nama",
      "https://user@nama.example.com",
      "https://user:password@nama.example.com",
      "https://nama.example.com?mode=test",
      "https://nama.example.com?",
      "https://nama.example.com#status",
      "https://nama.example.com#",
      "https://nama.example.com:0",
      "https://nama.example.com:65536",
    ]
  )
  func rejectsInvalidAddress(input: String) {
    #expect(throws: EndpointValidationError.self) {
      try NamaEndpoint(input)
    }
  }
}
