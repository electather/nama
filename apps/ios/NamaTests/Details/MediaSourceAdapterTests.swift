import Foundation
import Testing

@testable import Nama

@Suite("Media Source LibraryService adapter", .serialized)
@MainActor
struct MediaSourceAdapterTests {
  @Test("GetMediaSource maps bounded technical data and preserves optional absence")
  func technicalResponseMapping() async throws {
    HomeConnectStubURLProtocol.configure(
      status: HomeTransportFixture.successfulHTTPStatus,
      body: MediaSourceAdapterFixture.technicalResponse
    )
    defer { HomeConnectStubURLProtocol.reset() }
    let record = try movieDetailsTokenRecord()
    let client = movieDetailsClient(record: record, platform: "ios")
    let mediaIdentity = MediaIdentity("canonical-media")
    let sourceIdentity = MediaSourceIdentity("canonical-source")

    let source = try await client.loadSource(
      mediaIdentity: mediaIdentity,
      sourceIdentity: sourceIdentity,
      authorization: movieDetailsAuthorization(record: record)
    )

    assertSourceAggregate(
      source,
      mediaIdentity: mediaIdentity,
      sourceIdentity: sourceIdentity
    )
    try assertPrimaryPart(source.parts.first)
    try assertOptionalPart(source.parts.last)
    try assertMediaSourceRequest()
  }

  @Test("GetMediaSource closes missing, unavailable, canceled, incompatible, and stale responses")
  func failureMapping() async throws {
    let cases = MediaSourceAdapterFixture.failureCases
    let record = try movieDetailsTokenRecord()
    let client = movieDetailsClient(record: record, platform: "ios")

    for testCase in cases {
      HomeConnectStubURLProtocol.configure(status: testCase.status, body: testCase.body)
      await #expect(throws: testCase.expected) {
        try await client.loadSource(
          mediaIdentity: MediaIdentity("canonical-media"),
          sourceIdentity: MediaSourceIdentity("canonical-source"),
          authorization: movieDetailsAuthorization(record: record)
        )
      }
    }
    HomeConnectStubURLProtocol.reset()
  }

  @Test("provider-private response fields cannot enter app source state")
  func providerPrivateFieldsRemainContained() async throws {
    HomeConnectStubURLProtocol.configure(
      status: HomeTransportFixture.successfulHTTPStatus,
      body: MediaSourceAdapterFixture.providerPrivateResponse
    )
    defer { HomeConnectStubURLProtocol.reset() }
    let record = try movieDetailsTokenRecord()
    let client = movieDetailsClient(record: record, platform: "ios")

    do {
      let source = try await client.loadSource(
        mediaIdentity: MediaIdentity("canonical-media"),
        sourceIdentity: MediaSourceIdentity("canonical-source"),
        authorization: movieDetailsAuthorization(record: record)
      )
      let reflectedSource = String(reflecting: source)
      #expect(!reflectedSource.contains(MediaSourceAdapterFixture.providerSentinel))
      #expect(!reflectedSource.contains(MediaSourceAdapterFixture.pathSentinel))
      #expect(!reflectedSource.contains(MediaSourceAdapterFixture.streamIndexSentinel))
    } catch {
      #expect(error as? MediaSourceFailure == .incompatible)
    }
  }
}

private struct MediaSourceFailureCase {
  let status: Int
  let body: String
  let expected: MediaSourceFailure
}

private func assertSourceAggregate(
  _ source: MediaSource,
  mediaIdentity: MediaIdentity,
  sourceIdentity: MediaSourceIdentity
) {
  #expect(source.identity == sourceIdentity)
  #expect(source.mediaIdentity == mediaIdentity)
  #expect(source.label == "Director's presentation")
  #expect(source.availability == .available)
  #expect(source.runtime == MediaSourceAdapterFixture.aggregateRuntime)
  #expect(source.bitRateBps == MediaSourceAdapterFixture.aggregateBitRateBps)
  #expect(
    source.parts.map(\.identity)
      == [MediaPartIdentity("part-main"), .init("part-extra")]
  )
  #expect(source.parts.map(\.order) == MediaSourceAdapterFixture.partOrders)
}

private func assertPrimaryPart(_ candidate: MediaPart?) throws {
  let part = try #require(candidate)
  #expect(part.container == "mkv")
  #expect(part.runtime == MediaSourceAdapterFixture.partRuntime)
  #expect(part.sizeBytes == MediaSourceAdapterFixture.partSizeBytes)
  #expect(part.bitRateBps == MediaSourceAdapterFixture.partBitRateBps)
  #expect(part.tracks.map(\.order) == MediaSourceAdapterFixture.trackOrders)
  #expect(part.tracks.map(\.details) == expectedMainTrackDetails())
}

private func expectedMainTrackDetails() -> [MediaTrackDetails] {
  [
    .video(
      MediaVideoTrack(
        codec: "hevc",
        width: MediaSourceAdapterFixture.videoWidth,
        height: MediaSourceAdapterFixture.videoHeight,
        frameRate: MediaSourceAdapterFixture.videoFrameRate,
        bitDepth: MediaSourceAdapterFixture.videoBitDepth,
        dynamicRange: .unknown
      )
    ),
    .audio(
      MediaAudioTrack(
        codec: "truehd",
        title: "Main mix",
        language: "eng",
        channelCount: MediaSourceAdapterFixture.audioChannelCount,
        channelLayout: "7.1",
        sampleRateHz: MediaSourceAdapterFixture.audioSampleRateHz,
        spatialFormat: .unknown,
        isDefault: true,
        isCommentary: false
      )
    ),
    .subtitle(
      MediaSubtitleTrack(
        codec: "pgs",
        title: nil,
        language: nil,
        representation: .unknown,
        isDefault: false,
        isForced: true,
        isHearingImpaired: false,
        isCommentary: false
      )
    ),
  ]
}

private func assertOptionalPart(_ candidate: MediaPart?) throws {
  let part = try #require(candidate)
  #expect(part.runtime == nil)
  #expect(part.sizeBytes == nil)
  #expect(part.bitRateBps == nil)
  let audio = try #require(part.tracks.first)
  #expect(
    audio.details
      == .audio(
        MediaAudioTrack(
          codec: "aac",
          title: nil,
          language: nil,
          channelCount: nil,
          channelLayout: nil,
          sampleRateHz: nil,
          spatialFormat: nil,
          isDefault: false,
          isCommentary: false
        )
      )
  )
}

@MainActor
private func assertMediaSourceRequest() throws {
  let request = try #require(HomeConnectStubURLProtocol.recordedRequests.first)
  #expect(request.url?.path == "/nama.api.v1.LibraryService/GetMediaSource")
  let body = try #require(HomeConnectStubURLProtocol.recordedRequestBodies.first)
  let requestJSON = try #require(
    JSONSerialization.jsonObject(with: body) as? [String: Any]
  )
  #expect(requestJSON["mediaId"] as? String == "canonical-media")
  #expect(requestJSON["sourceId"] as? String == "canonical-source")
}

private enum MediaSourceAdapterFixture {
  static let aggregateBitRateBps: UInt64 = 18_000_000
  static let aggregateRuntimeMilliseconds: Int64 = 500
  static let audioChannelCount: UInt32 = 8
  static let audioSampleRateHz: UInt32 = 48_000
  static let catalogRetryAfterSeconds = 5
  static let firstOrder: UInt32 = 0
  static let partBitRateBps: UInt64 = 17_500_000
  static let partOrders: [UInt32] = [firstOrder, secondOrder]
  static let partRuntimeSeconds: Int64 = 7_200
  static let partSizeBytes: UInt64 = 16_000_000_000
  static let secondOrder: UInt32 = 1
  static let thirdOrder: UInt32 = 2
  static let trackOrders: [UInt32] = [firstOrder, secondOrder, thirdOrder]
  static let videoBitDepth: UInt32 = 10
  static let videoFrameRate = 23.976
  static let videoHeight: UInt32 = 2_160
  static let videoWidth: UInt32 = 3_840

  static let aggregateRuntime: Duration =
    .seconds(partRuntimeSeconds) + .milliseconds(aggregateRuntimeMilliseconds)
  static let partRuntime: Duration = .seconds(partRuntimeSeconds)

  static let failureCases = [
    MediaSourceFailureCase(
      status: HomeTransportFixture.unavailableHTTPStatus,
      body: MovieDetailsAdapterFixture.failureResponse(code: "not_found"),
      expected: .missing
    ),
    MediaSourceFailureCase(
      status: HomeTransportFixture.unavailableHTTPStatus,
      body: MovieDetailsAdapterFixture.failureResponse(code: "unavailable"),
      expected: .unavailable
    ),
    MediaSourceFailureCase(
      status: HomeTransportFixture.unavailableHTTPStatus,
      body: MovieDetailsAdapterFixture.failureResponse(code: "canceled"),
      expected: .canceled
    ),
    MediaSourceFailureCase(
      status: HomeTransportFixture.successfulHTTPStatus,
      body: malformedResponse,
      expected: .incompatible
    ),
    MediaSourceFailureCase(
      status: HomeTransportFixture.successfulHTTPStatus,
      body: staleResponse,
      expected: .stale
    ),
    MediaSourceFailureCase(
      status: HomeTransportFixture.unavailableHTTPStatus,
      body: MovieDetailsAdapterFixture.failureResponse(
        code: "failed_precondition",
        detail: MovieDetailsAdapterFixture.unsupportedDetail
      ),
      expected: .incompatible
    ),
    MediaSourceFailureCase(
      status: HomeTransportFixture.unavailableHTTPStatus,
      body: MovieDetailsAdapterFixture.failureResponse(
        code: "unavailable",
        detail: MovieDetailsAdapterFixture.catalogNotReadyDetail,
        additionalDetails: [MovieDetailsAdapterFixture.retryFiveSecondsDetail]
      ),
      expected: .catalogNotReady(retryAfterSeconds: catalogRetryAfterSeconds)
    ),
  ]

  static let technicalResponse = #"""
    {
      "source": {
        "id": "canonical-source",
        "mediaId": "canonical-media",
        "label": "Director's presentation",
        "availability": "SOURCE_AVAILABILITY_AVAILABLE",
        "runtime": "7200.500s",
        "bitRateBps": "18000000",
        "parts": [
          {
            "id": "part-main",
            "order": 0,
            "container": "mkv",
            "runtime": "7200s",
            "sizeBytes": "16000000000",
            "bitRateBps": "17500000",
            "tracks": [
              {
                "order": 0,
                "video": {
                  "codec": "hevc",
                  "width": 3840,
                  "height": 2160,
                  "frameRate": 23.976,
                  "bitDepth": 10,
                  "dynamicRange": 99
                }
              },
              {
                "order": 1,
                "audio": {
                  "codec": "truehd",
                  "title": "Main mix",
                  "language": "eng",
                  "channelCount": 8,
                  "channelLayout": "7.1",
                  "sampleRateHz": 48000,
                  "spatialFormat": 99,
                  "isDefault": true
                }
              },
              {
                "order": 2,
                "subtitle": {
                  "codec": "pgs",
                  "representation": 99,
                  "isForced": true
                }
              }
            ]
          },
          {
            "id": "part-extra",
            "order": 1,
            "container": "mp4",
            "tracks": [
              {
                "order": 0,
                "audio": {
                  "codec": "aac"
                }
              }
            ]
          }
        ]
      }
    }
    """#
  static let malformedResponse = #"""
    {
      "source": {
        "id": "canonical-source",
        "mediaId": "canonical-media"
      }
    }
    """#
  static let staleResponse = #"""
    {
      "source": {
        "id": "different-source",
        "mediaId": "canonical-media",
        "availability": "SOURCE_AVAILABILITY_AVAILABLE"
      }
    }
    """#
  static let providerSentinel = "provider-item-private-917"
  static let pathSentinel = "/private/provider/library/movie.mkv"
  static let streamIndexSentinel = "private-stream-index-43"
  static let providerPrivateResponse = """
    {
      "source": {
        "id": "canonical-source",
        "mediaId": "canonical-media",
        "availability": "SOURCE_AVAILABILITY_AVAILABLE",
        "providerItemId": "\(providerSentinel)",
        "filesystemPath": "\(pathSentinel)",
        "streamIndex": "\(streamIndexSentinel)"
      }
    }
    """
}
