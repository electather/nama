import Foundation

@testable import Nama

nonisolated enum HomeTransportFixture {
  static let overlongTitleLength = 129
  static let oversizedHomeItemCount = 51
  static let successfulHTTPStatus = 200
  static let unavailableHTTPStatus = 503
  private static let oversizedItemCount = 51
  private static let overlongTitleCount = 129
  static let homeResponse = #"""
    {
      "sections": [
        {
          "id": "shows",
          "title": "Shows",
          "kind": "HOME_SECTION_KIND_SHOWS",
          "items": []
        },
        {
          "id": "movies",
          "title": "Movies",
          "kind": "HOME_SECTION_KIND_MOVIES",
          "items": [
            {
              "id": "movie-2",
              "kind": "MEDIA_KIND_MOVIE",
              "title": "Second from server",
              "releaseYear": 2026,
              "runtime": "7200s",
              "contentRating": "PG-13",
              "primaryGenre": "Drama",
              "artwork": [
                {
                  "id": "artwork-2",
                  "role": "ARTWORK_ROLE_POSTER",
                  "width": 1000,
                  "height": 1500,
                  "locale": "en-US",
                  "textPresence": "ARTWORK_TEXT_PRESENCE_TEXTLESS"
                }
              ],
              "playability": "PLAYABILITY_PLAYABLE",
              "defaultSource": {
                "id": "source-2",
                "label": "Living room encode",
                "isDefault": true,
                "availability": "SOURCE_AVAILABILITY_AVAILABLE",
                "container": "mkv",
                "videoQuality": {
                  "codec": "hevc",
                  "width": 3840,
                  "height": 2160,
                  "dynamicRange": "DYNAMIC_RANGE_HDR10"
                },
                "audioQuality": {
                  "codec": "eac3",
                  "channelCount": 8,
                  "spatialFormat": "SPATIAL_AUDIO_FORMAT_DOLBY_ATMOS"
                }
              }
            },
            {
              "id": "movie-1",
              "kind": "MEDIA_KIND_MOVIE",
              "title": "First from server",
              "playability": "PLAYABILITY_NO_AVAILABLE_SOURCE"
            }
          ]
        }
      ]
    }
    """#
  static let artworkResponse = #"""
    {
      "locator": {
        "url": "https://artwork.example.test/poster?lease=short-lived",
        "headers": [
          {
            "name": "X-Artwork-Token",
            "value": "short-lived-secret"
          }
        ],
        "allowedRedirectOrigins": [
          "https://artwork.example.test",
          "https://cdn.example.test"
        ],
        "refreshAt": "2030-01-01T00:00:00Z",
        "accessExpiresAt": "2030-01-01T00:01:00Z",
        "width": 384,
        "height": 576
      }
    }
    """#
  static let catalogNotReadyResponse = #"""
    {
      "code": "unavailable",
      "message": "catalog is not ready",
      "details": [
        {
          "type": "google.rpc.ErrorInfo",
          "value": "ChFDQVRBTE9HX05PVF9SRUFEWRILbmFtYS5hcGkudjE="
        },
        {
          "type": "google.rpc.RetryInfo",
          "value": "CgIICQ=="
        },
        {
          "type": "google.rpc.RequestInfo",
          "value": "ChByZXF1ZXN0LXNhZmUtMTIz"
        }
      ]
    }
    """#
  static let oversizedHomeResponse: String = {
    let item = #"""
      {
        "id": "movie",
        "kind": "MEDIA_KIND_MOVIE",
        "title": "Movie",
        "playability": "PLAYABILITY_PLAYABLE"
      }
      """#
    let items = Array(repeating: item, count: oversizedHomeItemCount).joined(separator: ",")
    return """
      {
        "sections": [
          {
            "id": "movies",
            "title": "Movies",
            "kind": "HOME_SECTION_KIND_MOVIES",
            "items": [\(items)]
          }
        ]
      }
      """
  }()
  static let unsupportedReasonAtUnavailableResponse = #"""
    {
      "code": "unavailable",
      "message": "temporarily unavailable",
      "details": [
        {
          "type": "google.rpc.ErrorInfo",
          "value": "ChpDTElFTlRfVkVSU0lPTl9VTlNVUFBPUlRFRBILbmFtYS5hcGkudjE="
        }
      ]
    }
    """#
  static let validRequestInfoValue = "CiQyZjFjNWY0NC02YTliLTRkMmUtOGM3MC02MmRmNjA3YzJlZmE="
  static let unsafeRequestInfoValue = "Cg51bnNhZmUKcmVxdWVzdA=="
  static let overlongRequestInfoValue =
    "CoEBYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYW"
    + "FhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFh"

  static func unavailableResponse(requestInfoValue: String) -> String {
    """
    {
      "code": "unavailable",
      "message": "temporarily unavailable",
      "details": [
        {
          "type": "google.rpc.RequestInfo",
          "value": "\(requestInfoValue)"
        }
      ]
    }
    """
  }

  static let malformedArtworkLocaleResponse = #"""
    {
      "sections": [
        {
          "id": "movies",
          "title": "Movies",
          "kind": "HOME_SECTION_KIND_MOVIES",
          "items": [
            {
              "id": "movie",
              "kind": "MEDIA_KIND_MOVIE",
              "title": "Movie",
              "artwork": [
                {
                  "id": "artwork",
                  "role": "ARTWORK_ROLE_POSTER",
                  "locale": "not_valid",
                  "textPresence": "ARTWORK_TEXT_PRESENCE_TEXTLESS"
                }
              ],
              "playability": "PLAYABILITY_PLAYABLE"
            }
          ]
        }
      ]
    }
    """#
  static let overlongCombiningTitleResponse: String = {
    let title = String(repeating: "e\u{301}", count: overlongTitleLength)
    return """
      {
        "sections": [
          {
            "id": "movies",
            "title": "Movies",
            "kind": "HOME_SECTION_KIND_MOVIES",
            "items": [
              {
                "id": "movie",
                "kind": "MEDIA_KIND_MOVIE",
                "title": "\(title)",
                "playability": "PLAYABILITY_PLAYABLE"
              }
            ]
          }
        ]
      }
      """
  }()
}

func homeStubConfiguration() -> URLSessionConfiguration {
  let configuration = URLSessionConfiguration.ephemeral
  configuration.protocolClasses = [HomeConnectStubURLProtocol.self]
  return configuration
}

nonisolated final class HomeConnectStubURLProtocol: URLProtocol, @unchecked Sendable {
  private static let lock = NSLock()
  nonisolated(unsafe) private static var responseStatus = HomeTransportFixture
    .unavailableHTTPStatus
  nonisolated(unsafe) private static var responseBody = ""
  nonisolated(unsafe) private static var requests: [URLRequest] = []
  nonisolated(unsafe) private static var requestBodies: [Data] = []
  private static let bodyBufferSize = 4_096

  static var recordedRequests: [URLRequest] {
    lock.withLock { requests }
  }

  static var recordedRequestBodies: [Data] {
    lock.withLock { requestBodies }
  }

  static func configure(status: Int, body: String) {
    lock.withLock {
      responseStatus = status
      responseBody = body
      requests = []
      requestBodies = []
    }
  }

  static func reset() {
    configure(status: HomeTransportFixture.unavailableHTTPStatus, body: "")
  }

  // URLProtocol requires these overrides to remain class methods.
  // swiftlint:disable:next static_over_final_class non_overridable_class_declaration
  override class func canInit(with _: URLRequest) -> Bool {
    true
  }

  // swiftlint:disable:next static_over_final_class non_overridable_class_declaration
  override class func canonicalRequest(for request: URLRequest) -> URLRequest {
    request
  }

  override func startLoading() {
    let requestBody = Self.body(from: request)
    let response = Self.lock.withLock { () -> (Int, String) in
      Self.requests.append(request)
      Self.requestBodies.append(requestBody)
      return (Self.responseStatus, Self.responseBody)
    }
    guard
      let url = request.url,
      let httpResponse = HTTPURLResponse(
        url: url,
        statusCode: response.0,
        httpVersion: "HTTP/1.1",
        headerFields: ["content-type": "application/json"]
      )
    else {
      client?.urlProtocol(self, didFailWithError: URLError(.badURL))
      return
    }
    client?.urlProtocol(self, didReceive: httpResponse, cacheStoragePolicy: .notAllowed)
    client?.urlProtocol(self, didLoad: Data(response.1.utf8))
    client?.urlProtocolDidFinishLoading(self)
  }

  override func stopLoading() {
    // URLProtocol has no active work to stop in this synchronous fixture.
  }

  private static func body(from request: URLRequest) -> Data {
    if let body = request.httpBody {
      return body
    }
    guard let stream = request.httpBodyStream else {
      return Data()
    }
    stream.open()
    defer { stream.close() }
    var body = Data()
    var buffer = [UInt8](repeating: .zero, count: bodyBufferSize)
    while true {
      let readCount = stream.read(&buffer, maxLength: buffer.count)
      guard readCount > 0 else {
        return body
      }
      body.append(contentsOf: buffer.prefix(readCount))
    }
  }
}
