import Foundation
import Network

nonisolated enum EndpointValidationError: Error, Equatable {
  case invalid
  case requiresHTTPS
}

nonisolated struct HTTPSRequiredEndpoint: Equatable, Sendable {
  let absoluteString: String

  init(_ absoluteString: String) {
    self.absoluteString = absoluteString
  }
}

nonisolated struct NamaEndpoint: Hashable, Sendable {
  let url: URL

  private static let validPortRange = 1...65_535
  private static let defaultHTTPPort = 80
  private static let defaultHTTPSPort = 443
  private static let ipv4LoopbackFirstOctet: UInt8 = 127
  private static let ipv4PrivateTenFirstOctet: UInt8 = 10
  private static let ipv4Private172FirstOctet: UInt8 = 172
  private static let ipv4Private172SecondOctetRange: ClosedRange<UInt8> = 16...31
  private static let ipv4Private192FirstOctet: UInt8 = 192
  private static let ipv4Private192SecondOctet: UInt8 = 168
  private static let ipv4LinkLocalFirstOctet: UInt8 = 169
  private static let ipv4LinkLocalSecondOctet: UInt8 = 254
  private static let ipv6UniqueLocalFirstByteMask: UInt8 = 0xFE
  private static let ipv6UniqueLocalFirstBytePrefix: UInt8 = 0xFC
  private static let ipv6LinkLocalFirstByte: UInt8 = 0xFE
  private static let ipv6LinkLocalSecondByteMask: UInt8 = 0xC0
  private static let ipv6LinkLocalSecondBytePrefix: UInt8 = 0x80
  private static let maximumDNSNameLength = 253
  private static let maximumDNSLabelLength = 63
  private static let asciiHyphen: UInt8 = 0x2D
  private static let asciiLowercaseLetterRange: ClosedRange<UInt8> = 0x61...0x7A
  private static let asciiDigitRange: ClosedRange<UInt8> = 0x30...0x39

  private enum LocalName {
    case unrelated
    case emptyNamespace
    case localhost
    case qualified(Substring)
  }

  var absoluteString: String {
    url.absoluteString
  }

  var usesUnencryptedHTTP: Bool {
    url.scheme == "http"
  }

  init(_ input: String) throws {
    let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
    guard var components = URLComponents(string: trimmed),
      let scheme = components.scheme?.lowercased(),
      scheme == "http" || scheme == "https",
      let host = components.host,
      !host.isEmpty,
      components.user == nil,
      components.password == nil,
      components.query == nil,
      components.fragment == nil
    else {
      throw EndpointValidationError.invalid
    }

    if let port = components.port {
      guard Self.validPortRange.contains(port) else {
        throw EndpointValidationError.invalid
      }
      if (scheme == "http" && port == Self.defaultHTTPPort)
        || (scheme == "https" && port == Self.defaultHTTPSPort)
      {
        components.port = nil
      }
    }

    let normalizedHost = Self.normalizedHost(host)
    components.scheme = scheme
    components.host = normalizedHost
    components.percentEncodedPath = Self.normalizedPath(components.percentEncodedPath)

    guard let endpointURL = components.url, Self.hasValidZone(normalizedHost) else {
      throw EndpointValidationError.invalid
    }
    guard scheme == "https" || Self.allowsHTTP(to: normalizedHost) else {
      throw EndpointValidationError.requiresHTTPS
    }
    self.url = endpointURL
  }

  private static func normalizedHost(_ host: String) -> String {
    guard let zoneSeparator = host.firstIndex(of: "%") else {
      return host.lowercased()
    }
    return host[..<zoneSeparator].lowercased() + host[zoneSeparator...]
  }

  private static func hasValidZone(_ host: String) -> Bool {
    guard let (address, zone) = splitZone(in: host) else {
      return false
    }
    guard zone != nil else {
      return true
    }
    guard let ipv6 = IPv6Address(address) else {
      return false
    }
    return isIPv6LinkLocal(ipv6)
  }

  private static func allowsHTTP(to host: String) -> Bool {
    guard let (address, _) = splitZone(in: host) else {
      return false
    }
    if let ipv4 = IPv4Address(address) {
      return allowsHTTP(to: ipv4)
    }
    if let ipv6 = IPv6Address(address) {
      if ipv6.isIPv4Mapped, let mapped = ipv6.asIPv4 {
        return allowsHTTP(to: mapped)
      }
      return isIPv6Loopback(ipv6) || isIPv6UniqueLocal(ipv6) || isIPv6LinkLocal(ipv6)
    }
    return isProperLocalName(address)
  }

  private static func splitZone(in host: String) -> (address: String, zone: String?)? {
    let unbracketed = unbracketedHost(host)
    guard let separator = unbracketed.firstIndex(of: "%") else {
      return (String(unbracketed), nil)
    }
    let zoneStart = unbracketed.index(after: separator)
    guard zoneStart < unbracketed.endIndex,
      !unbracketed[zoneStart...].contains("%")
    else {
      return nil
    }
    return (
      String(unbracketed[..<separator]),
      String(unbracketed[zoneStart...])
    )
  }

  private static func unbracketedHost(_ host: String) -> Substring {
    guard host.first == "[", host.last == "]" else {
      return host[...]
    }
    return host.dropFirst().dropLast()
  }

  private static func allowsHTTP(to address: IPv4Address) -> Bool {
    let bytes = address.rawValue
    let first = bytes[bytes.startIndex]
    let second = bytes[bytes.index(after: bytes.startIndex)]
    return first == Self.ipv4LoopbackFirstOctet
      || first == Self.ipv4PrivateTenFirstOctet
      || (first == Self.ipv4Private172FirstOctet
        && Self.ipv4Private172SecondOctetRange.contains(second))
      || (first == Self.ipv4Private192FirstOctet
        && second == Self.ipv4Private192SecondOctet)
      || (first == Self.ipv4LinkLocalFirstOctet
        && second == Self.ipv4LinkLocalSecondOctet)
  }

  private static func isIPv6Loopback(_ address: IPv6Address) -> Bool {
    let bytes = address.rawValue
    return bytes.dropLast().allSatisfy { $0 == 0 } && bytes.last == 1
  }

  private static func isIPv6UniqueLocal(_ address: IPv6Address) -> Bool {
    guard let first = address.rawValue.first else {
      return false
    }
    return first & Self.ipv6UniqueLocalFirstByteMask == Self.ipv6UniqueLocalFirstBytePrefix
  }

  private static func isIPv6LinkLocal(_ address: IPv6Address) -> Bool {
    let bytes = address.rawValue
    let first = bytes[bytes.startIndex]
    let second = bytes[bytes.index(after: bytes.startIndex)]
    return first == Self.ipv6LinkLocalFirstByte
      && second & Self.ipv6LinkLocalSecondByteMask == Self.ipv6LinkLocalSecondBytePrefix
  }

  private static func isProperLocalName(_ host: String) -> Bool {
    guard host.utf8.count <= Self.maximumDNSNameLength else {
      return false
    }
    switch localName(in: host) {
    case .localhost:
      return true

    case .qualified(let prefix):
      return prefix.split(separator: ".", omittingEmptySubsequences: false)
        .allSatisfy(isProperDNSLabel)

    case .emptyNamespace, .unrelated:
      return false
    }
  }

  private static func localName(in host: String) -> LocalName {
    if host == "localhost" {
      return .localhost
    }
    let prefix: Substring
    if host.hasSuffix(".localhost") {
      prefix = host.dropLast(".localhost".count)
    } else if host.hasSuffix(".local") {
      prefix = host.dropLast(".local".count)
    } else {
      return .unrelated
    }
    return prefix.isEmpty ? .emptyNamespace : .qualified(prefix)
  }

  private static func isProperDNSLabel(_ label: Substring) -> Bool {
    guard !label.isEmpty, label.utf8.count <= Self.maximumDNSLabelLength,
      let first = label.utf8.first,
      let last = label.utf8.last,
      isASCIILetterOrDigit(first),
      isASCIILetterOrDigit(last)
    else {
      return false
    }
    return label.utf8.allSatisfy { character in
      isASCIILetterOrDigit(character) || character == Self.asciiHyphen
    }
  }

  private static func isASCIILetterOrDigit(_ value: UInt8) -> Bool {
    Self.asciiLowercaseLetterRange.contains(value) || Self.asciiDigitRange.contains(value)
  }

  private static func normalizedPath(_ path: String) -> String {
    guard !path.isEmpty else {
      return "/"
    }

    var end = path.endIndex
    while end > path.startIndex {
      let previous = path.index(before: end)
      guard path[previous] == "/" else {
        break
      }
      end = previous
    }
    return end == path.startIndex ? "/" : "\(path[..<end])/"
  }
}
