using System.Text.Json;
using System.Globalization;
using Jellyfin.Data.Enums;
using MediaBrowser.Controller.MediaEncoding;
using MediaBrowser.Model.Dlna;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.MediaInfo;
using MediaBrowser.Model.Session;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging;

namespace Nama.Jellyfin.Extension;

internal sealed class PlaybackNegotiationService
{
  private const int MaximumListItems = 100;
  private const int MaximumTokenLength = 256;
  private const string ProgressiveProtocol = "http_progressive";
  private const string HlsProtocol = "hls";
  private const TranscodeReason AudioTranscodeReasons =
      TranscodeReason.AudioCodecNotSupported
      | TranscodeReason.AudioBitrateNotSupported
      | TranscodeReason.AudioChannelsNotSupported
      | TranscodeReason.AudioProfileNotSupported
      | TranscodeReason.AudioSampleRateNotSupported
      | TranscodeReason.SecondaryAudioNotSupported
      | TranscodeReason.AudioBitDepthNotSupported
      | TranscodeReason.AudioIsExternal
      | TranscodeReason.UnknownAudioStreamInfo;
  private const TranscodeReason VideoTranscodeReasons =
      TranscodeReason.VideoCodecNotSupported
      | TranscodeReason.VideoResolutionNotSupported
      | TranscodeReason.AnamorphicVideoNotSupported
      | TranscodeReason.InterlacedVideoNotSupported
      | TranscodeReason.VideoBitDepthNotSupported
      | TranscodeReason.VideoBitrateNotSupported
      | TranscodeReason.VideoFramerateNotSupported
      | TranscodeReason.VideoLevelNotSupported
      | TranscodeReason.RefFramesNotSupported
      | TranscodeReason.VideoRangeTypeNotSupported
      | TranscodeReason.VideoProfileNotSupported
      | TranscodeReason.VideoCodecTagNotSupported
      | TranscodeReason.ContainerBitrateExceedsLimit
      | TranscodeReason.UnknownVideoStreamInfo;
  private static readonly string[] SdrDynamicRanges = ["SDR"];
  private static readonly string[] Hdr10DynamicRanges = ["HDR10"];
  private static readonly string[] Hdr10PlusDynamicRanges = ["HDR10Plus"];
  private static readonly string[] HlgDynamicRanges = ["HLG"];
  private static readonly string[] DolbyVisionDynamicRanges =
  [
    "DOVI",
    "DOVIWithHDR10",
    "DOVIWithHLG",
    "DOVIWithSDR",
    "DOVIWithEL",
    "DOVIWithHDR10Plus",
    "DOVIWithELHDR10Plus"
  ];

  private readonly IMediaEncoder _mediaEncoder;
  private readonly ILogger<PlaybackNegotiationService> _logger;

  public PlaybackNegotiationService(
      IMediaEncoder mediaEncoder,
      ILogger<PlaybackNegotiationService> logger)
  {
    _mediaEncoder = mediaEncoder;
    _logger = logger;
  }

  public NegotiatedPlayback Negotiate(
      PlanPlaybackInput input,
      Guid itemId,
      MediaSourceInfo source,
      int? requestedAudioTrackIndex = null,
      int? requestedSubtitleTrackIndex = null,
      bool requestedSubtitleDisabled = false)
  {
    var capabilities = input.Capabilities
        ?? throw new PlaybackRequestException(StatusCodes.Status400BadRequest);
    PlaybackCapabilityValidator.Validate(capabilities);
    source = CloneMediaSource(source);
    var preferences = input.Preferences
        ?? throw new PlaybackRequestException(StatusCodes.Status400BadRequest);
    var protocols = RequiredTokens(capabilities.Protocols);
    var directProfiles = BuildDirectProfiles(capabilities.DirectPlayProfiles);
    var subtitleProfiles = BuildSubtitleProfiles(capabilities, protocols, directProfiles);
    var profile = new DeviceProfile
    {
      Name = "Nama",
      MaxStreamingBitrate = null,
      MaxStaticBitrate = null,
      MaxStaticMusicBitrate = null,
      MusicStreamingTranscodingBitrate = null,
      DirectPlayProfiles = directProfiles,
      TranscodingProfiles = BuildTranscodingProfiles(capabilities, protocols),
      CodecProfiles = BuildCodecProfiles(capabilities, directProfiles),
      SubtitleProfiles = subtitleProfiles
    };
    var audioTrackIndex = requestedAudioTrackIndex ?? SelectAudioTrack(source, preferences);
    if (requestedSubtitleDisabled && requestedSubtitleTrackIndex.HasValue)
    {
      throw new PlaybackRequestException(StatusCodes.Status400BadRequest);
    }
    var subtitleTrackIndex = requestedSubtitleDisabled
        ? null
        : requestedSubtitleTrackIndex ?? SelectSubtitleTrack(
            source,
            preferences,
            capabilities.SubtitleCapabilities);
    ValidateTrack(source, audioTrackIndex, MediaStreamType.Audio);
    if (subtitleTrackIndex.HasValue)
    {
      ValidateTrack(source, subtitleTrackIndex.Value, MediaStreamType.Subtitle);
      if (!SupportsSubtitle(
          source.GetMediaStream(MediaStreamType.Subtitle, subtitleTrackIndex.Value),
          capabilities.SubtitleCapabilities))
      {
        throw Unsupported("SUBTITLE_UNSUPPORTED");
      }
    }

    var maximumBitRate = MaximumBitRate(preferences);
    var video = source.VideoStream ?? throw Unsupported("VIDEO_STREAM_MISSING");
    var audio = source.GetMediaStream(MediaStreamType.Audio, audioTrackIndex)
        ?? throw Unsupported("AUDIO_STREAM_MISSING");
    var sourceContainers = ProviderContainers(source.Container);
    var supportsProgressive = protocols.Contains(ProgressiveProtocol, StringComparer.Ordinal);
    var stream = new StreamBuilder(_mediaEncoder, _logger).GetOptimalVideoStream(new MediaOptions
    {
      AllowAudioStreamCopy = SupportsAudioCopy(
          capabilities.DirectPlayProfiles,
          sourceContainers,
          RequiredProviderToken(audio.Codec)),
      AllowVideoStreamCopy = SupportsVideoCopy(
          capabilities.DirectPlayProfiles,
          sourceContainers,
          RequiredProviderToken(video.Codec)),
      AudioStreamIndex = audioTrackIndex,
      EnableDirectPlay = supportsProgressive,
      EnableDirectStream = supportsProgressive,
      ItemId = itemId,
      MaxAudioChannels = CheckedInt(capabilities.MaxAudioChannels),
      MaxBitrate = maximumBitRate,
      MediaSourceId = source.Id,
      MediaSources = [source],
      Profile = profile,
      SubtitleStreamIndex = subtitleTrackIndex ?? -1
    }) ?? throw Unsupported("PLAYBACK_UNSUPPORTED");

    var container = RequiredProviderToken(stream.Container);
    var videoCodec = RequiredProviderToken(
        stream.VideoCodecs.Count > 0 ? stream.VideoCodecs[0] : null);
    var audioCodec = RequiredProviderToken(
        stream.AudioCodecs.Count > 0 ? stream.AudioCodecs[0] : null);
    if (!SupportsOutput(capabilities.DirectPlayProfiles, container, videoCodec, audioCodec))
    {
      throw Unsupported("OUTPUT_PROFILE_UNSUPPORTED");
    }
    var protocol = stream.SubProtocol == MediaStreamProtocol.hls
        ? HlsProtocol
        : stream.SubProtocol == MediaStreamProtocol.http
            ? ProgressiveProtocol
            : throw Unsupported("PROTOCOL_UNSUPPORTED");
    if (!protocols.Contains(protocol, StringComparer.Ordinal))
    {
      throw Unsupported("PROTOCOL_UNSUPPORTED");
    }

    var subtitleAction = subtitleTrackIndex.HasValue
        ? SubtitleAction(stream.SubtitleDeliveryMethod)
        : null;
    if (subtitleTrackIndex.HasValue
        && !SupportsSubtitleDelivery(
            source.GetMediaStream(MediaStreamType.Subtitle, subtitleTrackIndex.Value),
            capabilities.SubtitleCapabilities,
            stream.SubtitleDeliveryMethod))
    {
      throw Unsupported("SUBTITLE_DELIVERY_UNSUPPORTED");
    }
    var videoTranscodes = string.Equals(subtitleAction, "burn", StringComparison.Ordinal)
        || !EqualityComparer<TranscodeReason>.Default.Equals(
            stream.TranscodeReasons & VideoTranscodeReasons,
            default)
        || !string.Equals(video.Codec, videoCodec, StringComparison.OrdinalIgnoreCase);
    var audioTranscodes = !EqualityComparer<TranscodeReason>.Default.Equals(
        stream.TranscodeReasons & AudioTranscodeReasons,
        default)
        || !string.Equals(audio.Codec, audioCodec, StringComparison.OrdinalIgnoreCase);
    if ((videoTranscodes && !SupportsVideoEncoder(videoCodec))
        || (audioTranscodes && !SupportsAudioEncoder(audioCodec)))
    {
      throw Unsupported("OUTPUT_CODEC_UNSUPPORTED");
    }
    var strategy = videoTranscodes
        ? "transcode_video"
        : audioTranscodes
            ? "transcode_audio"
            : stream.PlayMethod == PlayMethod.DirectPlay
                ? "direct"
                : "remux";
    var actions = BuildActions(
        source,
        audioTrackIndex,
        subtitleTrackIndex,
        videoTranscodes,
        audioTranscodes,
        subtitleAction);
    var mimeType = string.Equals(protocol, HlsProtocol, StringComparison.Ordinal)
        ? "application/vnd.apple.mpegurl"
        : MimeType(container);
    return new NegotiatedPlayback(
        stream,
        strategy,
        container,
        videoCodec,
        audioCodec,
        protocol,
        mimeType,
        audioTrackIndex,
        subtitleTrackIndex,
        subtitleAction,
        actions);
  }

  public static IReadOnlyList<PlaybackTrackModel> Tracks(MediaSourceInfo source)
  {
    var streams = source.MediaStreams
        .Where(stream => stream.Type is MediaStreamType.Audio or MediaStreamType.Subtitle)
        .Take(MaximumListItems + 1)
        .ToArray();
    if (streams.Length > MaximumListItems)
    {
      throw Unsupported("TRACK_COUNT_UNSUPPORTED");
    }
    return streams.Select(stream => new PlaybackTrackModel(
        stream.Index,
        stream.Type == MediaStreamType.Audio ? "audio" : "subtitle",
        RequiredProviderToken(stream.Codec),
        stream.Type == MediaStreamType.Audio ? stream.Channels : null,
        stream.IsDefault,
        stream.IsForced,
        BoundedProviderText(stream.Title),
        BoundedProviderText(stream.Language),
        stream.Type == MediaStreamType.Subtitle
            ? stream.IsTextSubtitleStream ? "text" : "image"
            : null))
        .ToArray();
  }

  private static DirectPlayProfile[] BuildDirectProfiles(
      IReadOnlyList<DirectPlayProfileInput>? input)
  {
    if (input is not { Count: > 0 and <= MaximumListItems })
    {
      throw new PlaybackRequestException(StatusCodes.Status400BadRequest);
    }
    return input.Select(value => new DirectPlayProfile
    {
      AudioCodec = string.Join(',', RequiredTokens(value.AudioCodecs)),
      Container = RequiredToken(value.Container),
      Type = DlnaProfileType.Video,
      VideoCodec = RequiredToken(value.VideoCodec)
    }).ToArray();
  }

  private static TranscodingProfile[] BuildTranscodingProfiles(
      PlaybackCapabilitiesInput capabilities,
      IReadOnlyList<string> protocols)
  {
    var inputs = capabilities.DirectPlayProfiles
        ?? throw new PlaybackRequestException(StatusCodes.Status400BadRequest);
    var profiles = new List<TranscodingProfile>();
    foreach (var protocol in protocols)
    {
      foreach (var input in inputs)
      {
        var isHls = string.Equals(protocol, HlsProtocol, StringComparison.Ordinal);
        var container = RequiredToken(input.Container);
        var videoCodec = RequiredToken(input.VideoCodec);
        if (isHls
            && (!string.Equals(container, "mp4", StringComparison.Ordinal)
                || videoCodec is not ("h264" or "hevc")))
        {
          continue;
        }
        profiles.Add(new TranscodingProfile
        {
          AudioCodec = string.Join(',', RequiredTokens(input.AudioCodecs)),
          Container = container,
          Context = EncodingContext.Streaming,
          EnableSubtitlesInManifest = isHls,
          MaxAudioChannels = capabilities.MaxAudioChannels?.ToString(CultureInfo.InvariantCulture),
          Protocol = isHls ? MediaStreamProtocol.hls : MediaStreamProtocol.http,
          SegmentLength = isHls ? 2 : 0,
          Type = DlnaProfileType.Video,
          VideoCodec = videoCodec
        });
      }
    }
    if (profiles.Count == 0)
    {
      throw Unsupported("OUTPUT_PROFILE_UNSUPPORTED");
    }
    return profiles.ToArray();
  }

  private static CodecProfile[] BuildCodecProfiles(
      PlaybackCapabilitiesInput capabilities,
      IReadOnlyList<DirectPlayProfile> directProfiles)
  {
    var profiles = new List<CodecProfile>();
    var videoConditions = new List<ProfileCondition>();
    AddMaximumCondition(videoConditions, ProfileConditionValue.Width, capabilities.MaxWidth);
    AddMaximumCondition(videoConditions, ProfileConditionValue.Height, capabilities.MaxHeight);
    AddMaximumCondition(
        videoConditions,
        ProfileConditionValue.VideoBitDepth,
        capabilities.MaxVideoBitDepth);
    var dynamicRanges = JellyfinDynamicRanges(capabilities.DynamicRanges);
    if (dynamicRanges.Length > 0)
    {
      videoConditions.Add(new ProfileCondition(
          ProfileConditionType.EqualsAny,
          ProfileConditionValue.VideoRangeType,
          string.Join('|', dynamicRanges),
          true));
    }
    if (videoConditions.Count > 0)
    {
      profiles.Add(new CodecProfile
      {
        Codec = string.Join(
            ',',
            directProfiles.Select(profile => profile.VideoCodec).Distinct(StringComparer.Ordinal)),
        Conditions = videoConditions.ToArray(),
        Type = CodecType.Video
      });
    }
    if (capabilities.MaxAudioChannels.HasValue)
    {
      profiles.Add(new CodecProfile
      {
        Codec = string.Join(',', directProfiles
            .SelectMany(profile => RequiredTokens(profile.AudioCodec?.Split(',')))
            .Distinct(StringComparer.Ordinal)),
        Conditions =
        [
          new ProfileCondition(
              ProfileConditionType.LessThanEqual,
              ProfileConditionValue.AudioChannels,
              capabilities.MaxAudioChannels.Value.ToString(CultureInfo.InvariantCulture),
              true)
        ],
        Type = CodecType.VideoAudio
      });
    }
    return profiles.ToArray();
  }

  private static SubtitleProfile[] BuildSubtitleProfiles(
      PlaybackCapabilitiesInput capabilities,
      string[] protocols,
      IReadOnlyList<DirectPlayProfile> directProfiles)
  {
    var inputs = capabilities.SubtitleCapabilities ?? [];
    if (inputs.Count > MaximumListItems)
    {
      throw new PlaybackRequestException(StatusCodes.Status400BadRequest);
    }
    var profiles = new List<SubtitleProfile>();
    var hlsOnly = protocols.Length == 1
        && string.Equals(protocols[0], HlsProtocol, StringComparison.Ordinal);
    var containers = string.Join(
        ',',
        directProfiles.Select(profile => profile.Container).Distinct(StringComparer.Ordinal));
    foreach (var input in inputs)
    {
      var format = RequiredToken(input.Format);
      var modes = RequiredTokens(input.DeliveryModes);
      foreach (var mode in modes.OrderBy(mode => SubtitleModeRank(mode, hlsOnly)))
      {
        profiles.Add(new SubtitleProfile
        {
          Container = string.Equals(mode, "embedded", StringComparison.Ordinal)
              ? containers
              : string.Empty,
          Format = format,
          Method = mode switch
          {
            "embedded" => SubtitleDeliveryMethod.Embed,
            "external" when hlsOnly => SubtitleDeliveryMethod.Hls,
            "external" => SubtitleDeliveryMethod.External,
            "burned_in" => SubtitleDeliveryMethod.Encode,
            _ => throw new PlaybackRequestException(StatusCodes.Status400BadRequest)
          }
        });
        if (string.Equals(mode, "external", StringComparison.Ordinal) && hlsOnly)
        {
          profiles.Add(new SubtitleProfile
          {
            Container = string.Empty,
            Format = format,
            Method = SubtitleDeliveryMethod.External
          });
        }
      }
    }
    return profiles.ToArray();
  }

  private static PlaybackActionModel[] BuildActions(
      MediaSourceInfo source,
      int audioTrackIndex,
      int? subtitleTrackIndex,
      bool videoTranscodes,
      bool audioTranscodes,
      string? subtitleAction)
  {
    var streams = source.MediaStreams
        .Where(stream => stream.Type is MediaStreamType.Video
            or MediaStreamType.Audio
            or MediaStreamType.Subtitle)
        .Take(MaximumListItems + 1)
        .ToArray();
    if (streams.Length > MaximumListItems)
    {
      throw Unsupported("TRACK_COUNT_UNSUPPORTED");
    }
    return streams.Select(stream => new PlaybackActionModel(
        stream.Index,
        stream.Type switch
        {
          MediaStreamType.Video => videoTranscodes ? "transcode" : "copy",
          MediaStreamType.Audio when stream.Index == audioTrackIndex =>
              audioTranscodes ? "transcode" : "copy",
          MediaStreamType.Subtitle when stream.Index == subtitleTrackIndex =>
              subtitleAction ?? "omit",
          _ => "omit"
        }))
        .ToArray();
  }

  private static int SelectAudioTrack(
      MediaSourceInfo source,
      PlaybackPreferencesInput preferences)
  {
    var streams = source.MediaStreams.Where(stream => stream.Type == MediaStreamType.Audio).ToArray();
    if (streams.Length == 0)
    {
      throw Unsupported("AUDIO_STREAM_MISSING");
    }
    return PreferredTrack(streams, RequiredTokens(preferences.PreferredAudioLanguages))?.Index
        ?? streams.FirstOrDefault(stream => stream.Index == source.DefaultAudioStreamIndex)?.Index
        ?? streams.FirstOrDefault(stream => stream.IsDefault)?.Index
        ?? streams[0].Index;
  }

  private static int? SelectSubtitleTrack(
      MediaSourceInfo source,
      PlaybackPreferencesInput preferences,
      IReadOnlyList<SubtitleCapabilityInput>? capabilities)
  {
    var candidates = source.MediaStreams
        .Where(stream => stream.Type == MediaStreamType.Subtitle)
        .Select(stream => new SubtitleCandidate(
            stream.Index,
            stream.Codec,
            stream.Language,
            stream.IsDefault,
            stream.IsForced))
        .ToArray();
    return PlaybackSubtitleSelector.Select(
        candidates,
        source.DefaultSubtitleStreamIndex,
        preferences.SubtitlePreference,
        RequiredTokens(preferences.PreferredSubtitleLanguages),
        capabilities);
  }

  private static MediaStream? PreferredTrack(
      IReadOnlyList<MediaStream> streams,
      IReadOnlyList<string> languages)
  {
    foreach (var language in languages)
    {
      var match = streams.FirstOrDefault(
          stream => string.Equals(stream.Language, language, StringComparison.OrdinalIgnoreCase));
      if (match is not null)
      {
        return match;
      }
    }
    return null;
  }

  private static bool SupportsSubtitle(
      MediaStream? stream,
      IReadOnlyList<SubtitleCapabilityInput>? capabilities)
  {
    return stream is not null
        && capabilities?.Any(capability =>
            string.Equals(capability.Format, stream.Codec, StringComparison.OrdinalIgnoreCase)
            && capability.DeliveryModes is { Count: > 0 }) == true;
  }

  private static bool SupportsOutput(
      IReadOnlyList<DirectPlayProfileInput>? profiles,
      string container,
      string videoCodec,
      string audioCodec)
  {
    return profiles?.Any(profile =>
        string.Equals(profile.Container, container, StringComparison.OrdinalIgnoreCase)
        && string.Equals(profile.VideoCodec, videoCodec, StringComparison.OrdinalIgnoreCase)
        && profile.AudioCodecs?.Contains(audioCodec, StringComparer.OrdinalIgnoreCase)
            == true) == true;
  }

  private bool SupportsAudioEncoder(string codec)
  {
    var encoder = codec switch
    {
      "mp3" => "libmp3lame",
      "opus" => "libopus",
      "vorbis" => "libvorbis",
      _ => codec
    };
    return _mediaEncoder.SupportsEncoder(encoder);
  }

  private bool SupportsVideoEncoder(string codec)
  {
    var encoder = codec switch
    {
      "av1" => "libsvtav1",
      "h264" => "libx264",
      "h265" or "hevc" => "libx265",
      "vp8" => "libvpx",
      "vp9" => "libvpx-vp9",
      _ => codec
    };
    return _mediaEncoder.SupportsEncoder(encoder);
  }

  private static bool SupportsAudioCopy(
      IReadOnlyList<DirectPlayProfileInput>? profiles,
      IReadOnlyList<string> containers,
      string audioCodec)
  {
    return profiles?.Any(profile =>
        containers.Contains(profile.Container ?? string.Empty, StringComparer.OrdinalIgnoreCase)
        && profile.AudioCodecs?.Contains(audioCodec, StringComparer.OrdinalIgnoreCase)
            == true) == true;
  }

  private static bool SupportsVideoCopy(
      IReadOnlyList<DirectPlayProfileInput>? profiles,
      IReadOnlyList<string> containers,
      string videoCodec)
  {
    return profiles?.Any(profile =>
        containers.Contains(profile.Container ?? string.Empty, StringComparer.OrdinalIgnoreCase)
        && string.Equals(profile.VideoCodec, videoCodec, StringComparison.OrdinalIgnoreCase))
        == true;
  }

  private static bool SupportsSubtitleDelivery(
      MediaStream? stream,
      IReadOnlyList<SubtitleCapabilityInput>? capabilities,
      SubtitleDeliveryMethod method)
  {
    var requiredMode = method switch
    {
      SubtitleDeliveryMethod.Embed => "embedded",
      SubtitleDeliveryMethod.External or SubtitleDeliveryMethod.Hls => "external",
      SubtitleDeliveryMethod.Encode => "burned_in",
      _ => "unsupported"
    };
    return stream is not null
        && capabilities?.Any(capability =>
            string.Equals(capability.Format, stream.Codec, StringComparison.OrdinalIgnoreCase)
            && capability.DeliveryModes?.Contains(requiredMode, StringComparer.Ordinal) == true)
        == true;
  }

  private static int? MaximumBitRate(PlaybackPreferencesInput preferences)
  {
    if (preferences.Quality is "auto" or "original")
    {
      if (preferences.MaxBitRateBps is not null)
      {
        throw new PlaybackRequestException(StatusCodes.Status400BadRequest);
      }
      return null;
    }
    if (!string.Equals(preferences.Quality, "capped", StringComparison.Ordinal)
        || !ulong.TryParse(
            preferences.MaxBitRateBps,
            NumberStyles.None,
            CultureInfo.InvariantCulture,
            out var maximum)
        || maximum == 0)
    {
      throw new PlaybackRequestException(StatusCodes.Status400BadRequest);
    }
    return maximum > int.MaxValue ? int.MaxValue : (int)maximum;
  }

  private static string[] JellyfinDynamicRanges(IReadOnlyList<string>? input)
  {
    var ranges = RequiredTokens(input);
    return ranges.SelectMany(range => range switch
    {
      "sdr" => SdrDynamicRanges,
      "hdr10" => Hdr10DynamicRanges,
      "hdr10_plus" => Hdr10PlusDynamicRanges,
      "hlg" => HlgDynamicRanges,
      "dolby_vision" => DolbyVisionDynamicRanges,
      _ => throw new PlaybackRequestException(StatusCodes.Status400BadRequest)
    }).ToArray();
  }

  private static int SubtitleModeRank(string mode, bool hlsOnly)
  {
    return mode switch
    {
      "external" when hlsOnly => 0,
      "embedded" => 1,
      "external" => 2,
      "burned_in" => 3,
      _ => throw new PlaybackRequestException(StatusCodes.Status400BadRequest)
    };
  }

  private static string SubtitleAction(SubtitleDeliveryMethod method)
  {
    return method switch
    {
      SubtitleDeliveryMethod.Embed => "copy",
      SubtitleDeliveryMethod.External or SubtitleDeliveryMethod.Hls => "external",
      SubtitleDeliveryMethod.Encode => "burn",
      SubtitleDeliveryMethod.Drop => "omit",
      _ => throw Unsupported("SUBTITLE_DELIVERY_UNSUPPORTED")
    };
  }

  private static string MimeType(string container)
  {
    return container switch
    {
      "mp4" => "video/mp4",
      "mkv" or "matroska" => "video/x-matroska",
      "ts" or "mpegts" => "video/mp2t",
      _ => throw Unsupported("CONTAINER_UNSUPPORTED")
    };
  }

  private static void ValidateTrack(
      MediaSourceInfo source,
      int index,
      MediaStreamType expectedType)
  {
    if (index < 0 || source.GetMediaStream(expectedType, index) is null)
    {
      throw new PlaybackRequestException(StatusCodes.Status400BadRequest);
    }
  }

  private static string[] RequiredTokens(IReadOnlyList<string>? values)
  {
    if (values is null || values.Count > MaximumListItems)
    {
      throw new PlaybackRequestException(StatusCodes.Status400BadRequest);
    }
    return values.Select(RequiredToken).ToArray();
  }

  internal static MediaSourceInfo CloneMediaSource(MediaSourceInfo source)
  {
    return JsonSerializer.Deserialize<MediaSourceInfo>(
        JsonSerializer.SerializeToUtf8Bytes(source))
        ?? throw Unsupported("PROVIDER_METADATA_INVALID");
  }

  private static string RequiredToken(string? value)
  {
    if (string.IsNullOrEmpty(value) || value.Length > MaximumTokenLength)
    {
      throw new PlaybackRequestException(StatusCodes.Status400BadRequest);
    }
    return value.ToLowerInvariant();
  }

  private static string RequiredProviderToken(string? value)
  {
    if (string.IsNullOrEmpty(value) || value.Length > MaximumTokenLength)
    {
      throw Unsupported("PROVIDER_METADATA_INVALID");
    }
    return value.ToLowerInvariant();
  }

  private static string[] ProviderContainers(string? value)
  {
    if (string.IsNullOrEmpty(value))
    {
      throw Unsupported("PROVIDER_METADATA_INVALID");
    }
    var values = value.Split(
        ',',
        StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
    if (values.Length == 0 || values.Length > MaximumListItems)
    {
      throw Unsupported("PROVIDER_METADATA_INVALID");
    }
    return values.Select(RequiredProviderToken).ToArray();
  }

  private static string? BoundedProviderText(string? value)
  {
    return string.IsNullOrEmpty(value) || value.Length > MaximumTokenLength ? null : value;
  }

  private static int? CheckedInt(uint? value)
  {
    if (!value.HasValue)
    {
      return null;
    }
    return value.Value > int.MaxValue ? int.MaxValue : (int)value.Value;
  }

  private static void AddMaximumCondition(
      List<ProfileCondition> conditions,
      ProfileConditionValue property,
      uint? maximum)
  {
    if (maximum.HasValue)
    {
      conditions.Add(new ProfileCondition(
          ProfileConditionType.LessThanEqual,
          property,
          maximum.Value.ToString(CultureInfo.InvariantCulture),
          true));
    }
  }

  private static PlaybackRequestException Unsupported(string reason)
  {
    return new PlaybackRequestException(StatusCodes.Status412PreconditionFailed, reason);
  }
}

internal sealed record SubtitleCandidate(
    int Index,
    string? Codec,
    string? Language,
    bool IsDefault,
    bool IsForced);

internal static class PlaybackSubtitleSelector
{
  public static int? Select(
      IReadOnlyList<SubtitleCandidate> candidates,
      int? providerDefaultIndex,
      string? preference,
      IReadOnlyList<string> preferredLanguages,
      IReadOnlyList<SubtitleCapabilityInput>? capabilities)
  {
    if (string.Equals(preference, "off", StringComparison.Ordinal) || candidates.Count == 0)
    {
      return null;
    }
    var supported = candidates
        .Where(candidate => Supports(candidate, capabilities))
        .ToArray();
    if (string.Equals(preference, "forced_only", StringComparison.Ordinal))
    {
      var forcedOnly = supported.Where(candidate => candidate.IsForced).ToArray();
      return Preferred(forcedOnly, preferredLanguages)?.Index
          ?? forcedOnly.FirstOrDefault()?.Index;
    }
    if (string.Equals(preference, "always", StringComparison.Ordinal))
    {
      return Preferred(supported, preferredLanguages)?.Index
          ?? supported.FirstOrDefault(candidate => candidate.Index == providerDefaultIndex)?.Index
          ?? supported.FirstOrDefault(candidate => candidate.IsDefault)?.Index
          ?? supported.FirstOrDefault()?.Index;
    }
    if (!string.Equals(preference, "auto", StringComparison.Ordinal))
    {
      throw new PlaybackRequestException(StatusCodes.Status400BadRequest);
    }
    var providerDefault = supported.FirstOrDefault(
        candidate => candidate.Index == providerDefaultIndex);
    var forced = supported.Where(candidate => candidate.IsForced).ToArray();
    return providerDefault?.Index
        ?? Preferred(forced, preferredLanguages)?.Index
        ?? forced.FirstOrDefault()?.Index;
  }

  private static SubtitleCandidate? Preferred(
      IReadOnlyList<SubtitleCandidate> candidates,
      IReadOnlyList<string> languages)
  {
    foreach (var language in languages)
    {
      var match = candidates.FirstOrDefault(
          candidate => string.Equals(
              candidate.Language,
              language,
              StringComparison.OrdinalIgnoreCase));
      if (match is not null)
      {
        return match;
      }
    }
    return null;
  }

  private static bool Supports(
      SubtitleCandidate? candidate,
      IReadOnlyList<SubtitleCapabilityInput>? capabilities)
  {
    return candidate is not null
        && capabilities?.Any(capability =>
            string.Equals(capability.Format, candidate.Codec, StringComparison.OrdinalIgnoreCase)
            && capability.DeliveryModes is { Count: > 0 }) == true;
  }
}

internal static class PlaybackCapabilityValidator
{
  public static void Validate(PlaybackCapabilitiesInput capabilities)
  {
    if (capabilities.DynamicRanges is not { Count: > 0 })
    {
      throw new PlaybackRequestException(
          StatusCodes.Status412PreconditionFailed,
          "DYNAMIC_RANGE_UNSUPPORTED");
    }
  }
}
