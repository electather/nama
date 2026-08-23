import Foundation
import Testing

@testable import Nama

@Suite("Nama endpoint normalization")
struct EndpointTests {
  @Test(
    "normalizes scheme, host, default port, and trailing slash",
    arguments: [
      (" HTTPS://Nama.Example.COM:443 ", "https://nama.example.com/"),
      ("http://Nama.Local:80/proxy", "http://nama.local/proxy/"),
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
    "accepts only approved local address classes over HTTP",
    arguments: [
      ("http://127.0.0.0", "http://127.0.0.0/"),
      ("http://127.255.255.255", "http://127.255.255.255/"),
      ("http://10.0.0.0", "http://10.0.0.0/"),
      ("http://10.255.255.255", "http://10.255.255.255/"),
      ("http://172.16.0.0", "http://172.16.0.0/"),
      ("http://172.31.255.255", "http://172.31.255.255/"),
      ("http://192.168.0.0", "http://192.168.0.0/"),
      ("http://192.168.255.255", "http://192.168.255.255/"),
      ("http://169.254.0.0", "http://169.254.0.0/"),
      ("http://169.254.255.255", "http://169.254.255.255/"),
      ("http://[::1]", "http://[::1]/"),
      ("http://[fc00::]", "http://[fc00::]/"),
      (
        "http://[fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff]",
        "http://[fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff]/"
      ),
      ("http://[fe80::]", "http://[fe80::]/"),
      (
        "http://[febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff]",
        "http://[febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff]/"
      ),
      ("http://[FE80::1%25en0]", "http://[fe80::1%25en0]/"),
      ("http://[::ffff:10.0.0.1]", "http://[::ffff:10.0.0.1]/"),
      ("http://[::ffff:192.168.1.1]", "http://[::ffff:192.168.1.1]/"),
      ("http://LOCALHOST", "http://localhost/"),
      ("http://api.Localhost", "http://api.localhost/"),
      ("http://nama.Local", "http://nama.local/"),
      ("http://living-room.media.local", "http://living-room.media.local/"),
    ]
  )
  func acceptsLocalHTTP(input: String, expected: String) throws {
    #expect(try NamaEndpoint(input).absoluteString == expected)
  }

  @Test(
    "requires HTTPS outside the approved local address classes",
    arguments: [
      "http://126.255.255.255",
      "http://128.0.0.0",
      "http://9.255.255.255",
      "http://11.0.0.0",
      "http://172.15.255.255",
      "http://172.32.0.0",
      "http://192.167.255.255",
      "http://192.169.0.0",
      "http://169.253.255.255",
      "http://169.255.0.0",
      "http://100.64.0.1",
      "http://0.0.0.0",
      "http://224.0.0.1",
      "http://192.0.2.1",
      "http://198.18.0.1",
      "http://240.0.0.1",
      "http://8.8.8.8",
      "http://[::]",
      "http://[::2]",
      "http://[fbff:ffff:ffff:ffff:ffff:ffff:ffff:ffff]",
      "http://[fe00::]",
      "http://[fe7f:ffff:ffff:ffff:ffff:ffff:ffff:ffff]",
      "http://[fec0::]",
      "http://[ff02::1]",
      "http://[2001:db8::1]",
      "http://[2001:2::1]",
      "http://[2001:4860:4860::8888]",
      "http://[::ffff:8.8.8.8]",
      "http://[::ffff:100.64.0.1]",
      "http://example.com",
      "http://nama",
      "http://local",
      "http://localhost.example",
      "http://api.localhost.example",
      "http://nama.local.example",
      "http://127.0.0.1.nip.io",
      "http://notlocal",
      "http://-nama.local",
      "http://nama-.local",
      "http://nama_local.local",
      "http://localhost.",
      "http://nama.local.",
      "http://192.168.1.1.",
    ]
  )
  func rejectsForbiddenHTTP(input: String) {
    do {
      _ = try NamaEndpoint(input)
      Issue.record("Expected \(input) to require HTTPS")
    } catch let error as EndpointValidationError {
      #expect(String(localized: error.message) == "This Nama endpoint requires HTTPS.")
    } catch {
      Issue.record("Expected a typed endpoint validation error")
    }
  }

  @Test(
    "rejects empty local namespace hosts as malformed",
    arguments: ["http://.local", "http://.localhost", "https://.local", "https://.localhost"]
  )
  func rejectsEmptyLocalNamespace(input: String) {
    do {
      _ = try NamaEndpoint(input)
      Issue.record("Expected \(input) to be malformed")
    } catch let error as EndpointValidationError {
      #expect(error == .invalid)
    } catch {
      Issue.record("Expected a typed endpoint validation error")
    }
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
      "http://[::1%25lo0]",
      "http://[fd00::1%25en0]",
      "https://[2001:db8::1%25en0]",
      "http://[fe80::1%25]",
      "http://192.168.1.1%25en0",
    ]
  )
  func rejectsInvalidAddress(input: String) {
    #expect(throws: EndpointValidationError.self) {
      try NamaEndpoint(input)
    }
  }
}
