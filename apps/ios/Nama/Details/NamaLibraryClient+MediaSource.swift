import Connect
import Foundation
import NamaAPI

nonisolated extension NamaLibraryClient: MediaSourceLoading {
  func loadSource(
    mediaIdentity: MediaIdentity,
    sourceIdentity: MediaSourceIdentity,
    authorization: HomeAuthorizationIdentity
  ) async throws -> MediaSource {
    let snapshot = await tokenStore.load()
    if Task.isCancelled {
      throw CancellationError()
    }
    guard
      case .record(let record) = snapshot,
      record.endpoint == authorization.endpoint,
      record.accessTokenExpiresAt == authorization.accessTokenExpiresAt
    else {
      throw MediaSourceFailure.authorizationUnavailable
    }

    var request = Nama_Api_V1_GetMediaSourceRequest()
    request.mediaID = mediaIdentity.rawValue
    request.sourceID = sourceIdentity.rawValue
    let response = await libraryClient(using: record).getMediaSource(request: request)
    if Task.isCancelled {
      throw CancellationError()
    }
    switch response.result {
    case .success(let value):
      do {
        return try Self.mapMediaSourceResponse(
          value,
          mediaIdentity: mediaIdentity,
          sourceIdentity: sourceIdentity
        )
      } catch MediaSourceResponseMappingError.stale {
        throw MediaSourceFailure.stale
      } catch {
        throw MediaSourceFailure.incompatible
      }

    case .failure(let error):
      throw Self.mapMediaSourceFailure(error)
    }
  }

  private static func mapMediaSourceResponse(
    _ response: Nama_Api_V1_GetMediaSourceResponse,
    mediaIdentity: MediaIdentity,
    sourceIdentity: MediaSourceIdentity
  ) throws -> MediaSource {
    guard response.hasSource else {
      throw MediaSourceResponseMappingError.invalid
    }
    let source = response.source
    guard
      mediaStringIsBounded(source.id),
      mediaStringIsBounded(source.mediaID),
      source.parts.count <= MediaSourceResponseBounds.maximumParts,
      !source.hasBitRateBps || source.bitRateBps > 0
    else {
      throw MediaSourceResponseMappingError.invalid
    }
    guard
      source.id == sourceIdentity.rawValue,
      source.mediaID == mediaIdentity.rawValue
    else {
      throw MediaSourceResponseMappingError.stale
    }

    return MediaSource(
      identity: MediaSourceIdentity(source.id),
      mediaIdentity: MediaIdentity(source.mediaID),
      label: try mediaSourceOptionalString(source.hasLabel, source.label),
      availability: try mapSourceAvailability(source.availability),
      runtime: try mapMediaDuration(
        isPresent: source.hasRuntime,
        seconds: source.runtime.seconds,
        nanoseconds: source.runtime.nanos
      ),
      bitRateBps: source.hasBitRateBps ? source.bitRateBps : nil,
      parts: try source.parts.map(mapMediaPart)
    )
  }

  private static func mapMediaPart(_ part: Nama_Api_V1_MediaPart) throws -> MediaPart {
    guard
      mediaStringIsBounded(part.id),
      mediaStringIsBounded(part.container),
      part.tracks.count <= MediaSourceResponseBounds.maximumTracks,
      !part.hasBitRateBps || part.bitRateBps > 0
    else {
      throw MediaResponseMappingError.invalid
    }

    return MediaPart(
      identity: MediaPartIdentity(part.id),
      order: part.order,
      container: part.container,
      runtime: try mapMediaDuration(
        isPresent: part.hasRuntime,
        seconds: part.runtime.seconds,
        nanoseconds: part.runtime.nanos
      ),
      sizeBytes: part.hasSizeBytes ? part.sizeBytes : nil,
      bitRateBps: part.hasBitRateBps ? part.bitRateBps : nil,
      tracks: try part.tracks.map(mapMediaTrack)
    )
  }

  private static func mapMediaTrack(_ track: Nama_Api_V1_MediaTrack) throws -> MediaTrack {
    let details: MediaTrackDetails
    switch track.details {
    case .video(let video):
      details = .video(try mapVideoTrack(video))

    case .audio(let audio):
      details = .audio(try mapAudioTrack(audio))

    case .subtitle(let subtitle):
      details = .subtitle(try mapSubtitleTrack(subtitle))

    case nil:
      details = .unknown
    }
    return MediaTrack(order: track.order, details: details)
  }

  private static func mapVideoTrack(
    _ video: Nama_Api_V1_VideoTrack
  ) throws -> MediaVideoTrack {
    guard
      mediaStringIsBounded(video.codec),
      !video.hasWidth || video.width > 0,
      !video.hasHeight || video.height > 0,
      !video.hasFrameRate || (video.frameRate.isFinite && video.frameRate > 0),
      !video.hasBitDepth || video.bitDepth > 0
    else {
      throw MediaResponseMappingError.invalid
    }
    return MediaVideoTrack(
      codec: video.codec,
      width: video.hasWidth ? video.width : nil,
      height: video.hasHeight ? video.height : nil,
      frameRate: video.hasFrameRate ? video.frameRate : nil,
      bitDepth: video.hasBitDepth ? video.bitDepth : nil,
      dynamicRange: video.hasDynamicRange ? try mapDynamicRange(video.dynamicRange) : nil
    )
  }

  private static func mapAudioTrack(
    _ audio: Nama_Api_V1_AudioTrack
  ) throws -> MediaAudioTrack {
    guard
      mediaStringIsBounded(audio.codec),
      !audio.hasSampleRateHz || audio.sampleRateHz > 0
    else {
      throw MediaResponseMappingError.invalid
    }
    return MediaAudioTrack(
      codec: audio.codec,
      title: try mediaSourceOptionalString(audio.hasTitle, audio.title),
      language: try mediaSourceOptionalString(audio.hasLanguage, audio.language),
      channelCount: audio.hasChannelCount ? audio.channelCount : nil,
      channelLayout: try mediaSourceOptionalString(audio.hasChannelLayout, audio.channelLayout),
      sampleRateHz: audio.hasSampleRateHz ? audio.sampleRateHz : nil,
      spatialFormat: audio.hasSpatialFormat
        ? try mapSpatialAudioFormat(audio.spatialFormat)
        : nil,
      isDefault: audio.isDefault,
      isCommentary: audio.isCommentary
    )
  }

  private static func mapSubtitleTrack(
    _ subtitle: Nama_Api_V1_SubtitleTrack
  ) throws -> MediaSubtitleTrack {
    guard mediaStringIsBounded(subtitle.codec) else {
      throw MediaResponseMappingError.invalid
    }
    let representation: MediaSubtitleRepresentation
    switch subtitle.representation {
    case .text:
      representation = .text

    case .image:
      representation = .image

    case .UNRECOGNIZED:
      representation = .unknown

    case .unspecified:
      throw MediaResponseMappingError.invalid
    }
    return MediaSubtitleTrack(
      codec: subtitle.codec,
      title: try mediaSourceOptionalString(subtitle.hasTitle, subtitle.title),
      language: try mediaSourceOptionalString(subtitle.hasLanguage, subtitle.language),
      representation: representation,
      isDefault: subtitle.isDefault,
      isForced: subtitle.isForced,
      isHearingImpaired: subtitle.isHearingImpaired,
      isCommentary: subtitle.isCommentary
    )
  }

  private static func mediaSourceOptionalString(
    _ isPresent: Bool,
    _ value: String
  ) throws -> String? {
    guard isPresent else {
      return nil
    }
    guard mediaStringIsBounded(value) else {
      throw MediaSourceResponseMappingError.invalid
    }
    return value
  }

  private static func mapMediaSourceFailure(_ error: ConnectError) -> MediaSourceFailure {
    let errorInfo: [Google_Rpc_ErrorInfo] = error.unpackedDetails()
    if isCatalogNotReady(error) {
      return .catalogNotReady(retryAfterSeconds: retryDelaySeconds(error))
    }
    if error.code == .failedPrecondition,
      errorInfo.contains(where: { detail in
        detail.domain == apiErrorDomain && detail.reason == "CLIENT_VERSION_UNSUPPORTED"
      })
    {
      return .incompatible
    }
    if let exception = error.exception {
      return (exception as NSError).domain == NSURLErrorDomain
        ? .unavailable
        : .incompatible
    }
    return switch error.code {
    case .notFound:
      .missing

    case .canceled:
      .canceled

    case .permissionDenied, .unauthenticated:
      .authorizationUnavailable

    case .unimplemented, .invalidArgument, .outOfRange, .ok:
      .incompatible

    case .unknown, .deadlineExceeded, .alreadyExists, .resourceExhausted,
      .failedPrecondition, .aborted, .unavailable, .internalError, .dataLoss:
      .unavailable
    }
  }
}

nonisolated private enum MediaSourceResponseMappingError: Error {
  case invalid
  case stale
}

nonisolated private enum MediaSourceResponseBounds {
  static let maximumParts = 100
  static let maximumTracks = 100
}
