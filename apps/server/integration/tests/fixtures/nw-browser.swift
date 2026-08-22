import Foundation
import Network

private let expectedArgumentCount = 2
private let timeoutSeconds = 10

guard CommandLine.arguments.count == expectedArgumentCount else {
  FileHandle.standardError.write(Data("expected canonical URL argument\n".utf8))
  exit(2)
}

let expectedURL = CommandLine.arguments[1]
let queue = DispatchQueue(label: "nama.lan-discovery-test")
let browser = NWBrowser(
  for: .bonjourWithTXTRecord(type: "_nama._tcp", domain: nil),
  using: .tcp
)

browser.stateUpdateHandler = { state in
  if case let .failed(error) = state {
    FileHandle.standardError.write(Data("NWBrowser failed: \(error)\n".utf8))
    exit(1)
  }
}

browser.browseResultsChangedHandler = { results, _ in
  for result in results {
    guard case let .bonjour(txtRecord) = result.metadata else {
      continue
    }
    guard case let .string(url) = txtRecord.getEntry(for: "url"), url == expectedURL else {
      continue
    }
    FileHandle.standardOutput.write(Data("\(url)\n".utf8))
    browser.cancel()
    exit(0)
  }
}

browser.start(queue: queue)
Thread.sleep(forTimeInterval: TimeInterval(timeoutSeconds))
FileHandle.standardError.write(Data("timed out waiting for _nama._tcp\n".utf8))
browser.cancel()
exit(1)
