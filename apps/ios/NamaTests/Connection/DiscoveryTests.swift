import Foundation
import Network
import Testing

@testable import Nama

@Suite("Nama endpoint discovery records")
struct DiscoveryTests {
  private static let policyDeniedErrorCode: Int32 = -65_570

  @Test("accepts a valid URL TXT value and ignores unknown keys")
  func parsesValidTXTRecord() throws {
    let txtRecord = NWTXTRecord([
      "ignored": "untrusted",
      "url": " HTTPS://Nama.Example.COM:443/proxy ",
    ])

    let record = NamaDiscoveryRecord(serviceName: "Living Room", txtRecord: txtRecord)

    #expect(record?.endpoint == (try NamaEndpoint("https://nama.example.com/proxy/")))
    #expect(record?.serviceName == "Living Room")
  }

  @Test("suppresses forbidden HTTP advertisements while retaining eligible endpoints")
  func enforcesTransportPolicy() {
    let records = [
      "https://nama.example.com",
      "http://192.168.1.20",
      "http://nama.local",
      "http://nama.example.com",
      "http://100.64.0.1",
    ].map { endpoint in
      NamaDiscoveryRecord(
        serviceName: endpoint,
        txtRecord: NWTXTRecord(["url": endpoint])
      )
    }

    #expect(records[0] != nil)
    #expect(records[1] != nil)
    #expect(records[2] != nil)
    #expect(records[3] == nil)
    #expect(records[4] == nil)
  }

  @Test("ignores missing, malformed, empty, and non-UTF-8 URL TXT values")
  func ignoresMalformedTXTRecords() {
    var nonUTF8Record = NWTXTRecord()
    nonUTF8Record.setEntry(.data(Data([0xFF])), for: "url")

    let records = [
      NWTXTRecord(["other": "https://nama.example.com"]),
      NWTXTRecord(["url": "nama.example.com"]),
      NWTXTRecord(["url": ""]),
      nonUTF8Record,
    ]

    for txtRecord in records {
      #expect(NamaDiscoveryRecord(serviceName: "Nama", txtRecord: txtRecord) == nil)
    }
  }

  @Test("reconciles duplicate interfaces by normalized endpoint and sorts deterministically")
  func reconcilesCandidates() throws {
    let firstEndpoint = try NamaEndpoint("https://a.example.com")
    let secondEndpoint = try NamaEndpoint("HTTPS://B.EXAMPLE.COM:443")
    let records = [
      NamaDiscoveryRecord(endpoint: secondEndpoint, serviceName: "Upstairs"),
      NamaDiscoveryRecord(endpoint: firstEndpoint, serviceName: "Zulu"),
      NamaDiscoveryRecord(endpoint: secondEndpoint, serviceName: "Downstairs"),
      NamaDiscoveryRecord(endpoint: firstEndpoint, serviceName: "Zulu"),
    ]

    let candidates = NamaDiscoveryCandidate.reconcile(records)

    #expect(candidates.map(\.endpoint) == [firstEndpoint, secondEndpoint])
    #expect(candidates[0].serviceNames == ["Zulu"])
    #expect(candidates[1].serviceNames == ["Downstairs", "Upstairs"])
  }

  @Test("removes a candidate when its final browse record disappears")
  func removesFinalRecord() throws {
    let removedEndpoint = try NamaEndpoint("https://removed.example.com")
    let retainedEndpoint = try NamaEndpoint("https://retained.example.com")
    let initialRecords = [
      NamaDiscoveryRecord(endpoint: removedEndpoint, serviceName: "Nama"),
      NamaDiscoveryRecord(endpoint: removedEndpoint, serviceName: "Nama"),
      NamaDiscoveryRecord(endpoint: retainedEndpoint, serviceName: "Office"),
    ]

    let remainingCandidates = NamaDiscoveryCandidate.reconcile(
      initialRecords.filter { $0.endpoint == retainedEndpoint }
    )

    #expect(remainingCandidates.map(\.endpoint) == [retainedEndpoint])
  }

  @Test("classifies the Bonjour policy-denied error as local-network denial")
  func classifiesPermissionDenial() {
    let error = NWError.dns(Self.policyDeniedErrorCode)

    #if os(tvOS)
      #expect(NamaDiscoveryFailure(browserError: error) == .unavailable)
    #else
      #expect(NamaDiscoveryFailure(browserError: error) == .permissionDenied)
    #endif
  }

  @Test("classifies other browser errors as discovery failure")
  func classifiesBrowserFailure() {
    let error = NWError.posix(.ENETDOWN)

    #expect(NamaDiscoveryFailure(browserError: error) == .unavailable)
  }
}
