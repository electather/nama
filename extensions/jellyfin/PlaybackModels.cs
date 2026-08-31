using System.Text.Json.Serialization;
using MediaBrowser.Model.Dlna;

namespace Nama.Jellyfin.Extension;

internal static class PlaybackConstants
{
  public const long JellyfinTicksPerSecond = 10_000_000;
  public const int ReportIntervalSeconds = 15;
  public static readonly TimeSpan MaximumSessionLifetime = TimeSpan.FromHours(24);
  public static readonly TimeSpan PlanLifetime = TimeSpan.FromMinutes(5);
  public static readonly TimeSpan SessionGrace = TimeSpan.FromMinutes(30);
  public const string LeaseHeader = "X-Nama-Playback-Lease";
}

internal sealed record DurationInput(
    [property: JsonPropertyName("seconds")] string? Seconds,
    [property: JsonPropertyName("nanos")] int Nanos);

internal sealed record DirectPlayProfileInput(
    [property: JsonPropertyName("container")] string? Container,
    [property: JsonPropertyName("video_codec")] string? VideoCodec,
    [property: JsonPropertyName("audio_codecs")] IReadOnlyList<string>? AudioCodecs);

internal sealed record SubtitleCapabilityInput(
    [property: JsonPropertyName("format")] string? Format,
    [property: JsonPropertyName("delivery_modes")] IReadOnlyList<string>? DeliveryModes);

internal sealed record PlaybackCapabilitiesInput(
    [property: JsonPropertyName("direct_play_profiles")] IReadOnlyList<DirectPlayProfileInput>? DirectPlayProfiles,
    [property: JsonPropertyName("protocols")] IReadOnlyList<string>? Protocols,
    [property: JsonPropertyName("subtitle_capabilities")] IReadOnlyList<SubtitleCapabilityInput>? SubtitleCapabilities,
    [property: JsonPropertyName("max_width")] uint? MaxWidth,
    [property: JsonPropertyName("max_height")] uint? MaxHeight,
    [property: JsonPropertyName("max_video_bit_depth")] uint? MaxVideoBitDepth,
    [property: JsonPropertyName("max_audio_channels")] uint? MaxAudioChannels,
    [property: JsonPropertyName("dynamic_ranges")] IReadOnlyList<string>? DynamicRanges);

internal sealed record PlaybackPreferencesInput(
    [property: JsonPropertyName("quality")] string? Quality,
    [property: JsonPropertyName("max_bit_rate_bps")] string? MaxBitRateBps,
    [property: JsonPropertyName("preferred_audio_languages")] IReadOnlyList<string>? PreferredAudioLanguages,
    [property: JsonPropertyName("preferred_subtitle_languages")] IReadOnlyList<string>? PreferredSubtitleLanguages,
    [property: JsonPropertyName("subtitle_preference")] string? SubtitlePreference);

internal sealed record PlanPlaybackInput(
    [property: JsonPropertyName("item_id")] string? ItemId,
    [property: JsonPropertyName("source_id")] string? SourceId,
    [property: JsonPropertyName("user_id")] string? UserId,
    [property: JsonPropertyName("capabilities")] PlaybackCapabilitiesInput? Capabilities,
    [property: JsonPropertyName("preferences")] PlaybackPreferencesInput? Preferences,
    [property: JsonPropertyName("start_position")] DurationInput? StartPosition);

internal sealed record OpenPlaybackInput(
    [property: JsonPropertyName("operation_id")] string? OperationId,
    [property: JsonPropertyName("plan_id")] string? PlanId,
    [property: JsonPropertyName("audio_track_index")] int? AudioTrackIndex,
    [property: JsonPropertyName("subtitle_disabled")] bool SubtitleDisabled,
    [property: JsonPropertyName("subtitle_track_index")] int? SubtitleTrackIndex);

internal sealed record ReportPlaybackInput(
    [property: JsonPropertyName("event_id")] string? EventId,
    [property: JsonPropertyName("sequence")] string? Sequence,
    [property: JsonPropertyName("state")] string? State,
    [property: JsonPropertyName("position")] DurationInput? Position,
    [property: JsonPropertyName("duration")] DurationInput? Duration,
    [property: JsonPropertyName("selected_audio_track_index")] int? SelectedAudioTrackIndex,
    [property: JsonPropertyName("selected_subtitle_track_index")] int? SelectedSubtitleTrackIndex,
    [property: JsonPropertyName("session_context")] string? SessionContext);

internal sealed record ClosePlaybackInput(
    [property: JsonPropertyName("operation_id")] string? OperationId,
    [property: JsonPropertyName("reason")] string? Reason,
    [property: JsonPropertyName("final_position")] DurationInput? FinalPosition,
    [property: JsonPropertyName("duration")] DurationInput? Duration,
    [property: JsonPropertyName("session_context")] string? SessionContext);

internal sealed record PlaybackTrackModel(
    [property: JsonPropertyName("index")] int Index,
    [property: JsonPropertyName("type")] string Type,
    [property: JsonPropertyName("codec")] string Codec,
    [property: JsonPropertyName("channels")] int? Channels,
    [property: JsonPropertyName("is_default")] bool IsDefault,
    [property: JsonPropertyName("is_forced")] bool IsForced,
    [property: JsonPropertyName("label")] string? Label,
    [property: JsonPropertyName("language")] string? Language,
    [property: JsonPropertyName("representation")] string? Representation);

internal sealed record PlaybackActionModel(
    [property: JsonPropertyName("track_index")] int TrackIndex,
    [property: JsonPropertyName("action")] string Action);

internal sealed record PlanPlaybackOutput(
    [property: JsonPropertyName("plan_id")] string PlanId,
    [property: JsonPropertyName("expires_at")] DateTimeOffset ExpiresAt,
    [property: JsonPropertyName("strategy")] string Strategy,
    [property: JsonPropertyName("container")] string Container,
    [property: JsonPropertyName("video_codec")] string VideoCodec,
    [property: JsonPropertyName("audio_codec")] string AudioCodec,
    [property: JsonPropertyName("protocol")] string Protocol,
    [property: JsonPropertyName("tracks")] IReadOnlyList<PlaybackTrackModel> Tracks,
    [property: JsonPropertyName("default_audio_track_index")] int DefaultAudioTrackIndex,
    [property: JsonPropertyName("default_subtitle_track_index")] int? DefaultSubtitleTrackIndex,
    [property: JsonPropertyName("actions")] IReadOnlyList<PlaybackActionModel> Actions);

internal sealed record SessionTrackModel(
    [property: JsonPropertyName("index")] int Index,
    [property: JsonPropertyName("switchable_without_reopen")] bool SwitchableWithoutReopen);

internal sealed record ExternalSubtitleModel(
    [property: JsonPropertyName("track_index")] int TrackIndex,
    [property: JsonPropertyName("media_resource")] string MediaResource,
    [property: JsonPropertyName("mime_type")] string MimeType);

internal sealed record OpenPlaybackOutput(
    [property: JsonPropertyName("session_id")] string SessionId,
    [property: JsonPropertyName("item_id")] string ItemId,
    [property: JsonPropertyName("source_id")] string SourceId,
    [property: JsonPropertyName("media_resource")] string MediaResource,
    [property: JsonPropertyName("lease")] string Lease,
    [property: JsonPropertyName("protocol")] string Protocol,
    [property: JsonPropertyName("mime_type")] string MimeType,
    [property: JsonPropertyName("expires_at")] DateTimeOffset ExpiresAt,
    [property: JsonPropertyName("report_interval_seconds")] int ReportIntervalSeconds,
    [property: JsonPropertyName("tracks")] IReadOnlyList<SessionTrackModel> Tracks,
    [property: JsonPropertyName("selected_audio_track_index")] int SelectedAudioTrackIndex,
    [property: JsonPropertyName("selected_subtitle_track_index")] int? SelectedSubtitleTrackIndex,
    [property: JsonPropertyName("external_subtitles")] IReadOnlyList<ExternalSubtitleModel> ExternalSubtitles,
    [property: JsonPropertyName("session_context")] string SessionContext);

internal sealed record NegotiatedPlayback(
    StreamInfo Stream,
    string Strategy,
    string Container,
    string VideoCodec,
    string AudioCodec,
    string Protocol,
    string MimeType,
    int AudioTrackIndex,
    int? SubtitleTrackIndex,
    string? SubtitleAction,
    IReadOnlyList<PlaybackActionModel> Actions);

internal sealed record PlaybackPlan(
    string Nonce,
    Guid ItemId,
    string SourceId,
    Guid UserId,
    long RuntimeTicks,
    long StartPositionTicks,
    PlanPlaybackInput Input,
    NegotiatedPlayback Negotiation,
    IReadOnlyList<PlaybackTrackModel> Tracks);

internal sealed record SessionContextPayload(string SessionId);

internal sealed record MediaLeasePayload(
    string SessionId,
    Guid ItemId,
    string SourceId,
    string ApiKey);

internal sealed record MediaResourcePayload(
    string SessionId,
    string StockTarget,
    bool RewritePlaylist);
