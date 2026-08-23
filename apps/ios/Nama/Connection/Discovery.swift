import Foundation
import Network

nonisolated struct NamaDiscoveryRecord: Equatable, Sendable {
  let endpoint: NamaEndpoint
  let serviceName: String

  init?(serviceName: String, txtRecord: NWTXTRecord) {
    guard let value = txtRecord.getEntry(for: "url")?.data,
      let url = String(data: value, encoding: .utf8),
      let parsedEndpoint = try? NamaEndpoint(url)
    else {
      return nil
    }

    self.endpoint = parsedEndpoint
    self.serviceName = serviceName
  }

  init(endpoint: NamaEndpoint, serviceName: String) {
    self.endpoint = endpoint
    self.serviceName = serviceName
  }
}

nonisolated struct NamaDiscoveryCandidate: Equatable, Identifiable, Sendable {
  let endpoint: NamaEndpoint
  let serviceNames: [String]

  var id: NamaEndpoint {
    endpoint
  }

  static func reconcile(_ records: [NamaDiscoveryRecord]) -> [Self] {
    var namesByEndpoint: [NamaEndpoint: Set<String>] = [:]
    for record in records {
      namesByEndpoint[record.endpoint, default: []].insert(record.serviceName)
    }

    return
      namesByEndpoint
      .map { endpoint, names in
        Self(endpoint: endpoint, serviceNames: names.sorted())
      }
      .sorted { first, second in
        first.endpoint.absoluteString < second.endpoint.absoluteString
      }
  }
}

nonisolated enum NamaDiscoveryFailure: Equatable, Sendable {
  case permissionDenied
  case unavailable

  private static let policyDeniedErrorCode: Int32 = -65_570

  init(browserError: NWError) {
    #if os(tvOS)
      self = .unavailable
    #else
      if case .dns(let errorCode) = browserError,
        Int32(errorCode) == Self.policyDeniedErrorCode
      {
        self = .permissionDenied
      } else {
        self = .unavailable
      }
    #endif
  }
}

nonisolated enum NamaDiscoveryEvent: Equatable, Sendable {
  case records([NamaDiscoveryRecord])
  case failed(NamaDiscoveryFailure)
}

nonisolated enum NamaDiscoveryState: Equatable, Sendable {
  case inactive
  case scanning
  case empty
  case candidates([NamaDiscoveryCandidate])
  case permissionDenied
  case failed
}

nonisolated protocol NamaDiscovering: Sendable {
  func browse() async -> AsyncStream<NamaDiscoveryEvent>
}

nonisolated struct NWBrowserNamaDiscovery: NamaDiscovering {
  private static let serviceType = "_nama._tcp"
  private static let queue = DispatchQueue(label: "com.electather.nama.discovery")

  func browse() -> AsyncStream<NamaDiscoveryEvent> {
    let (stream, continuation) = AsyncStream<NamaDiscoveryEvent>.makeStream()
    let browser = NWBrowser(
      for: .bonjourWithTXTRecord(type: Self.serviceType, domain: nil),
      using: .tcp
    )

    browser.stateUpdateHandler = { state in
      switch state {
      case .waiting(let error):
        continuation.yield(.failed(NamaDiscoveryFailure(browserError: error)))

      case .failed(let error):
        continuation.yield(.failed(NamaDiscoveryFailure(browserError: error)))
        continuation.finish()

      case .cancelled:
        continuation.finish()

      case .setup, .ready:
        break

      @unknown default:
        continuation.yield(.failed(.unavailable))
      }
    }
    browser.browseResultsChangedHandler = { results, _ in
      let records = results.compactMap { result -> NamaDiscoveryRecord? in
        guard case .service(let name, _, _, _) = result.endpoint,
          case .bonjour(let txtRecord) = result.metadata
        else {
          return nil
        }
        return NamaDiscoveryRecord(serviceName: name, txtRecord: txtRecord)
      }
      continuation.yield(.records(records))
    }
    continuation.onTermination = { _ in
      browser.cancel()
    }
    browser.start(queue: Self.queue)
    return stream
  }
}
