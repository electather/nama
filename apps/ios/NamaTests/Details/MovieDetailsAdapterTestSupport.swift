import Foundation

@testable import Nama

actor SuspendedMovieDetailsTokenStore: OAuthTokenStoring {
  private var snapshot: OAuthTokenStoreSnapshot = .missing
  private var loadContinuation: CheckedContinuation<OAuthTokenStoreSnapshot, Never>?
  private(set) var loadCallCount = 0

  func load() async -> OAuthTokenStoreSnapshot {
    loadCallCount += 1
    return await withCheckedContinuation { continuation in
      loadContinuation = continuation
    }
  }

  func resolve(with newSnapshot: OAuthTokenStoreSnapshot) {
    snapshot = newSnapshot
    loadContinuation?.resume(returning: newSnapshot)
    loadContinuation = nil
  }

  func replace(with candidate: EndpointBoundOAuthTokenRecord) {
    snapshot = .record(candidate)
  }

  func restore(
    _ previous: EndpointBoundOAuthTokenRecord?,
    ifCurrent candidate: EndpointBoundOAuthTokenRecord
  ) {
    guard snapshot == .record(candidate) else {
      return
    }
    snapshot = previous.map(OAuthTokenStoreSnapshot.record) ?? .missing
  }

  func remove(ifCurrent record: EndpointBoundOAuthTokenRecord) {
    if snapshot == .record(record) {
      snapshot = .missing
    }
  }

  func quarantine(_ data: Data) {
    snapshot = .damaged(data)
  }
}
enum MovieDetailsAdapterFixture {
  static let clientVersion = "1.2.3"
  static let generation: UInt64 = 11
  static let releaseYear: UInt32 = 2_026
  static let runtimeSeconds: Int64 = 7_200
  static let runtime: Duration = .seconds(runtimeSeconds)
  static let tokenExpiry: TimeInterval = 4_600
  static let completeSynopsis =
    "A long canonical synopsis that remains complete instead of being truncated by the adapter."
  static let longSynopsisChunk = "Long canonical detail remains readable. "
  static let longSynopsisRepetitions = 400

  static let completeResponse = #"""
    {
      "media": {
        "summary": {
          "id": "movie-details",
          "kind": "MEDIA_KIND_MOVIE",
          "title": "The Canonical Movie",
          "releaseYear": 2026,
          "runtime": "7200s",
          "contentRating": "PG-13",
          "primaryGenre": "Drama",
          "playability": "PLAYABILITY_PLAYABLE",
          "defaultSource": {
            "id": "source-default",
            "label": "4K HDR",
            "isDefault": true,
            "availability": "SOURCE_AVAILABILITY_AVAILABLE",
            "container": "mkv"
          }
        },
        "tagline": "Everything changes at midnight.",
        "synopsis": "A long canonical synopsis that remains complete instead of being truncated by the adapter.",
        "genres": ["Drama", "Mystery"],
        "studios": ["North Star Pictures", "Harbor Films"],
        "credits": [
          {
            "name": "Ada Director",
            "role": "MEDIA_CREDIT_ROLE_DIRECTOR"
          },
          {
            "name": "Wes Writer",
            "role": "MEDIA_CREDIT_ROLE_WRITER"
          },
          {
            "name": "Sam Actor",
            "role": "MEDIA_CREDIT_ROLE_ACTOR",
            "characterName": "The Traveler",
            "portraitArtwork": {
              "id": "portrait-sam",
              "role": "ARTWORK_ROLE_PORTRAIT",
              "textPresence": "ARTWORK_TEXT_PRESENCE_UNKNOWN"
            }
          }
        ],
        "artwork": [
          {
            "id": "backdrop-textless",
            "role": "ARTWORK_ROLE_BACKDROP",
            "width": 1920,
            "height": 1080,
            "textPresence": "ARTWORK_TEXT_PRESENCE_TEXTLESS"
          },
          {
            "id": "poster-textless",
            "role": "ARTWORK_ROLE_POSTER",
            "width": 1000,
            "height": 1500,
            "textPresence": "ARTWORK_TEXT_PRESENCE_TEXTLESS"
          }
        ],
        "sourceSummaries": [
          {
            "id": "source-default",
            "label": "4K HDR",
            "isDefault": true,
            "availability": "SOURCE_AVAILABILITY_AVAILABLE",
            "container": "mkv"
          }
        ],
        "movie": {
          "releaseDate": {
            "year": 2026,
            "month": 8,
            "day": 25
          }
        }
      }
    }
    """#
  static let minimalResponse = #"""
    {
      "media": {
        "summary": {
          "id": "movie-minimal",
          "kind": "MEDIA_KIND_MOVIE",
          "title": "Minimal Movie",
          "playability": "PLAYABILITY_NO_AVAILABLE_SOURCE"
        },
        "movie": {}
      }
    }
    """#

  static let unavailableCanonicalDefaultResponse = #"""
    {
      "media": {
        "summary": {
          "id": "movie-unavailable-default",
          "kind": "MEDIA_KIND_MOVIE",
          "title": "Unavailable Canonical Default",
          "playability": "PLAYABILITY_NO_AVAILABLE_SOURCE",
          "defaultSource": {
            "id": "source-unavailable-default",
            "label": "Unsupported Remote Copy",
            "isDefault": true,
            "availability": "SOURCE_AVAILABILITY_UNSUPPORTED",
            "container": "mkv"
          }
        },
        "sourceSummaries": [
          {
            "id": "source-unavailable-default",
            "label": "Unsupported Remote Copy",
            "isDefault": true,
            "availability": "SOURCE_AVAILABILITY_UNSUPPORTED",
            "container": "mkv"
          }
        ],
        "movie": {}
      }
    }
    """#

  static let canonicalRequestID = "2f1c5f44-6a9b-4d2e-8c70-62df607c2efa"
  static let unsupportedDetail = #"""
    {
      "type": "google.rpc.ErrorInfo",
      "value": "ChpDTElFTlRfVkVSU0lPTl9VTlNVUFBPUlRFRBILbmFtYS5hcGkudjE="
    }
    """#
  static let catalogNotReadyDetail = #"""
    {
      "type": "google.rpc.ErrorInfo",
      "value": "ChFDQVRBTE9HX05PVF9SRUFEWRILbmFtYS5hcGkudjE="
    }
    """#
  static let rateLimitedDetail = #"""
    {
      "type": "google.rpc.ErrorInfo",
      "value": "CgxSQVRFX0xJTUlURUQSC25hbWEuYXBpLnYx"
    }
    """#
  static let retryFiveSecondsDetail = #"""
    {
      "type": "google.rpc.RetryInfo",
      "value": "CgIIBQ=="
    }
    """#
  static let requestDetail = #"""
    {
      "type": "google.rpc.RequestInfo",
      "value": "CiQyZjFjNWY0NC02YTliLTRkMmUtOGM3MC02MmRmNjA3YzJlZmE="
    }
    """#

  static func failureResponse(
    code: String,
    detail: String? = nil,
    additionalDetails: [String] = []
  ) -> String {
    let details = [detail].compactMap(\.self) + additionalDetails
    let detailField = details.isEmpty ? "" : ", \"details\": [\(details.joined(separator: ","))]"
    return """
      {
        "code": "\(code)",
        "message": "safe failure"\(detailField)
      }
      """
  }
}
