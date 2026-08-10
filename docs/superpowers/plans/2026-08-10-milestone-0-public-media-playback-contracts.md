# Milestone 0 Public Media and Playback Contracts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Define the complete provider-neutral public contract used by tvOS to browse canonical media, inspect technical sources, resolve artwork, negotiate playback, report playback, and manage the current principal's state.

**Architecture:** Lean `MediaSummary` values drive shelves and lists; explicit detail and source RPCs load heavier data. Playback uses plan/open/report/close with plan-scoped then session-scoped track IDs and safe direct locators. The public API exposes canonical Nama concepts only.

**Tech Stack:** Protobuf, Protovalidate annotations, Buf, ConnectRPC generated clients, Protobuf-ES, Connect-Go, SwiftProtobuf/Connect-Swift.

## Global Constraints

- This is plan 3 of 4 and depends on the contract-toolchain and public-management plans.
- Milestone 0 adds schemas, generated code, compile probes, and contract tests only. Do not add catalog storage, provider mapping, tvOS screens, playback engines, handlers, or fake media.
- Public descriptors must contain no provider brand, provider resource ID, stream index, filesystem path, SDK type, raw provider error, or reusable provider credential.
- A source is a playable representation of one edition; file size belongs to a part. Alternate cuts remain different canonical items.
- Lists use `MediaSummary`; `GetMedia` returns `MediaDetails`; `GetMediaSource` alone returns parts/tracks.
- Artwork references contain no URL or token. Resolution returns a refresh-bounded locator; access expiry is separate and present only when provider authorization is enforced.
- Playback supports one-part sources in the MVP. Do not add segment sequencing, a media proxy, a switch-track RPC, or streaming RPCs.
- Plan track IDs and session track IDs are distinct opaque namespaces. Technical source tracks are descriptive and never selected by provider index.
- Every locator has explicit allowed redirect origins, and custom headers are scoped to the initial origin. Headers, URLs, credentials, and session context are sensitive even though they are structurally valid.
- Required enum fields use `(buf.validate.field).enum = { not_in: [0] }`; never use `defined_only`, because unknown future numeric values must remain valid.
- Every present Timestamp carries `(buf.validate.field).timestamp = {}`. Every present Duration is non-negative with `(buf.validate.field).duration.gte = {}`; every returned `report_interval` is required and strictly positive with `(buf.validate.field).duration.gt = {}`.
- Use exact field/enum numbers listed below, plan 1 structural bounds, required oneofs, and collection caps. Regenerate; never hand-edit generated code.

### Wire Type Key

Field tables and numbered lists fix tags by left-to-right order. Unless a row names a message type explicitly, use these exact protobuf types:

- `string`: `id`, every field ending in `_id`, title/name/label/codec/container/language/locale/content-rating/genre/studio/channel-layout/MIME-type/URL/redirect-origin/page-token fields, plus `query`, `character_name`, `original_title`, `synopsis`, and `tagline`.
- `bool`: every `is_*` field plus `watched`, `playable_only`, `disabled`, and `switchable_without_reopen`.
- `uint32`: `release_year`, `season_number`, `episode_number`, `season_count`, `episode_count`, `order`, `width`, `height`, `bit_depth`, `channel_count`, `sample_rate_hz`, `page_size`, `section_size`, `max_width`, `max_height`, `max_video_bit_depth`, and `max_audio_channels`.
- `uint64`: `size_bytes`, every `bit_rate_bps` field, `sequence`, and `accepted_sequence`.
- `double`: `frame_rate`.
- `google.protobuf.Duration`: runtime, position, duration, start/final position, and report interval fields.
- `google.protobuf.Timestamp`: every field ending in `_at`, including locator/plan/session expiry and client-observed time.
- `google.type.Date`: every field ending in `_release_date` plus `release_date`.
- The declared enum type: fields named `kind`/`kinds`, `role`, `playability`, `availability`, `dynamic_range`/`dynamic_ranges`, `spatial_format`, `text_presence`, `representation`, `sort`, `watch_filter`, `protocol`/`protocols`, `delivery_modes`, `quality`, `subtitle_preference`, `strategy`, `type`, `action`, `state`, and `reason`.
- Media message fields map exactly as follows: `episode_position` → `EpisodePosition`; `user_state` → `MediaUserState`; `video_quality` → `VideoQuality`; `audio_quality` → `AudioQuality`; `default_source`/`source_summaries` → `MediaSourceSummary`; `artwork`/`portrait_artwork` → `ArtworkReference`; `summary`, `HomeSection.items`, `ListLibraryResponse.items`, `SearchResponse.items`, and `ListChildrenResponse.items` → `MediaSummary`; `parents` → `MediaParent`; `credits` → `MediaCredit`; `parts` → `MediaPart`; technical `tracks` → `MediaTrack`; and the media kind oneofs use `MovieDetails`, `ShowDetails`, `SeasonDetails`, and `EpisodeDetails`.
- Library message fields map exactly as follows: `filter` → `LibraryFilter`; `sections` → `HomeSection`; `media` → `MediaDetails`; `source` → `MediaSource`; and the Library `locator` → `ArtworkLocator`.
- Playback message fields map exactly as follows: `direct_play_profiles` → `DirectPlayProfile`; `subtitle_capabilities` → `SubtitleCapability`; request `capabilities` → `PlaybackCapabilities`; request `preferences` → `PlaybackPreferences`; track oneof `audio`/`subtitle` → `PlaybackAudioTrackDetails`/`PlaybackSubtitleTrackDetails`; plan `tracks` → `PlaybackTrack`; session `tracks` → `PlaybackSessionTrack`; `default_subtitle`/request `subtitle`/`selected_subtitle` → `SubtitleSelection`; `actions` → `TrackAction`; `plan` → `PlaybackPlan`; PlaybackSession `locator` → `PlaybackLocator`; `external_subtitles` → `ExternalSubtitleLocator`; and `session` → `PlaybackSession`.
- `ArtworkLocator.headers`, `PlaybackLocator.headers`, and `ExternalSubtitleLocator.headers` are `repeated nama.api.v1.HttpHeader`; every `allowed_redirect_origins` field is `repeated string`.
- Every remaining scalar field, including `format`, is `string`; do not infer another wire type from a sample value.

An `optional` marker means proto3 explicit presence for a scalar/enum. Message fields already have presence; “required” means attach `(buf.validate.field).required = true`. Repeated enum/string/message cardinality is always stated in the table or numbered list.

---

### Task 1: Define the canonical public media model

**Files:**

- Create: `proto/nama/api/v1/media.proto`
- Modify: `apps/server/src/contract.test.ts`
- Modify: `apps/cli/internal/cli/contracts_test.go`
- Modify: `gen/swift/Tests/NamaAPITests/ContractTests.swift`
- Regenerate: `gen/ts/src/nama/api/v1/**`
- Regenerate: `gen/go/nama/api/v1/**`
- Regenerate: `gen/swift/Sources/NamaAPI/**`

**Interfaces:**

- Consumes: public `HttpHeader`, Timestamp, Duration, and `google.type.Date`.
- Produces: summary, details, artwork, source, part, and technical-track messages shared by library, playback, and user-state contracts.

- [ ] **Step 1: Write the failing TypeScript movie round trip**

Construct a movie `MediaDetails` with its matching kind oneof, textless poster art, ordered actor/director credits, two source summaries, one part with video/audio/subtitle tracks, and a resumable `MediaUserState` whose position is explicitly zero.

- [ ] **Step 2: Run the TypeScript movie red check**

Run: `mise run check:ts`

Expected: FAIL because `media.proto` does not exist.

- [ ] **Step 3: Add TypeScript show, season, and episode fixtures**

Add one lean `MediaDetails` per hierarchy kind with the matching oneof, parent links, episode position, release metadata, and artwork.

- [ ] **Step 4: Run the TypeScript hierarchy red check**

Run: `mise run check:ts`

Expected: FAIL on the same absent schema.

- [ ] **Step 5: Mirror the movie fixture in Go**

Add the movie and nested source/track fixture to the existing Go harness.

- [ ] **Step 6: Run the Go movie red check**

Run: `mise run check:go`

Expected: FAIL because the generated public media package does not exist.

- [ ] **Step 7: Add Go hierarchy fixtures**

Add the show, season, and episode fixtures with their matching oneofs to the Go harness.

- [ ] **Step 8: Run the Go hierarchy red check**

Run: `mise run check:go`

Expected: FAIL on the same absent package.

- [ ] **Step 9: Mirror the movie fixture in Swift**

Add the movie and nested source/track fixture to the existing Swift package test.

- [ ] **Step 10: Run the Swift movie red check**

Run: `mise run check:swift`

Expected: FAIL because the generated public media types do not exist.

- [ ] **Step 11: Add Swift hierarchy fixtures**

Add the show, season, and episode fixtures with their matching oneofs to the Swift test.

- [ ] **Step 12: Run the Swift hierarchy red check**

Run: `mise run check:swift`

Expected: FAIL on the same absent types.

- [ ] **Step 13: Declare media-kind and availability enums**

```proto
enum MediaKind {
  MEDIA_KIND_UNSPECIFIED = 0;
  MEDIA_KIND_MOVIE = 1;
  MEDIA_KIND_SHOW = 2;
  MEDIA_KIND_SEASON = 3;
  MEDIA_KIND_EPISODE = 4;
}

enum Playability {
  PLAYABILITY_UNSPECIFIED = 0;
  PLAYABILITY_PLAYABLE = 1;
  PLAYABILITY_TEMPORARILY_UNAVAILABLE = 2;
  PLAYABILITY_NO_AVAILABLE_SOURCE = 3;
}

enum SourceAvailability {
  SOURCE_AVAILABILITY_UNSPECIFIED = 0;
  SOURCE_AVAILABILITY_AVAILABLE = 1;
  SOURCE_AVAILABILITY_PROVIDER_UNAVAILABLE = 2;
  SOURCE_AVAILABILITY_UNSUPPORTED = 3;
}
```

- [ ] **Step 14: Declare normalized audiovisual enums**

```proto
enum DynamicRange {
  DYNAMIC_RANGE_UNSPECIFIED = 0;
  DYNAMIC_RANGE_SDR = 1;
  DYNAMIC_RANGE_HDR10 = 2;
  DYNAMIC_RANGE_HDR10_PLUS = 3;
  DYNAMIC_RANGE_HLG = 4;
  DYNAMIC_RANGE_DOLBY_VISION = 5;
}

enum SpatialAudioFormat {
  SPATIAL_AUDIO_FORMAT_UNSPECIFIED = 0;
  SPATIAL_AUDIO_FORMAT_NONE = 1;
  SPATIAL_AUDIO_FORMAT_DOLBY_ATMOS = 2;
  SPATIAL_AUDIO_FORMAT_DTS_X = 3;
}

enum SubtitleRepresentation {
  SUBTITLE_REPRESENTATION_UNSPECIFIED = 0;
  SUBTITLE_REPRESENTATION_TEXT = 1;
  SUBTITLE_REPRESENTATION_IMAGE = 2;
}
```

- [ ] **Step 15: Declare artwork and credit enums**

```proto
enum ArtworkRole {
  ARTWORK_ROLE_UNSPECIFIED = 0;
  ARTWORK_ROLE_POSTER = 1;
  ARTWORK_ROLE_BACKDROP = 2;
  ARTWORK_ROLE_LOGO = 3;
  ARTWORK_ROLE_THUMBNAIL = 4;
  ARTWORK_ROLE_PORTRAIT = 5;
}

enum ArtworkTextPresence {
  ARTWORK_TEXT_PRESENCE_UNSPECIFIED = 0;
  ARTWORK_TEXT_PRESENCE_UNKNOWN = 1;
  ARTWORK_TEXT_PRESENCE_TEXTLESS = 2;
  ARTWORK_TEXT_PRESENCE_CONTAINS_TEXT = 3;
}

enum MediaCreditRole {
  MEDIA_CREDIT_ROLE_UNSPECIFIED = 0;
  MEDIA_CREDIT_ROLE_ACTOR = 1;
  MEDIA_CREDIT_ROLE_DIRECTOR = 2;
  MEDIA_CREDIT_ROLE_WRITER = 3;
}
```

- [ ] **Step 16: Declare state and compact quality messages**

Assign sequential tags using this inventory:

| Message | Fields in tag order |
| --- | --- |
| `EpisodePosition` | `season_number`, `episode_number` |
| `MediaUserState` | `watched`, optional `position`, optional `duration`, required `updated_at` |
| `VideoQuality` | `codec`, optional `width`, optional `height`, optional `dynamic_range` |
| `AudioQuality` | `codec`, optional `channel_count`, optional `spatial_format` |

Use positive values for present season/episode numbers and dimensions.

- [ ] **Step 17: Declare compact source and artwork references**

| Message | Fields in tag order |
| --- | --- |
| `MediaSourceSummary` | `id`, optional `label`, `is_default`, `availability`, optional `container`, optional `video_quality`, optional `audio_quality` |
| `ArtworkReference` | `id`, `role`, optional `width`, optional `height`, optional `locale`, `text_presence` |

Locale is a bounded BCP 47-shaped string; canonicalization remains handler/client behavior.

- [ ] **Step 18: Declare the lean MediaSummary**

| Message | Fields in tag order |
| --- | --- |
| `MediaSummary` | `id`, `kind`, `title`, optional `release_year`, optional `runtime`, optional `content_rating`, optional `primary_genre`, optional `episode_position`, repeated `artwork`, optional `user_state`, `playability`, optional `default_source` |

Artwork arrays are at most 20; source-summary arrays are at most 100.

- [ ] **Step 19: Declare detail support and kind-specific messages**

| Message | Fields in tag order |
| --- | --- |
| `MediaParent` | `id`, `kind`, `title` |
| `MediaCredit` | `name`, `role`, optional `character_name`, optional `portrait_artwork` |
| `MovieDetails` | optional `release_date` |
| `ShowDetails` | optional `first_release_date`, optional `last_release_date`, optional `season_count`, optional `episode_count` |
| `SeasonDetails` | `season_number`, optional `episode_count` |
| `EpisodeDetails` | `season_number`, `episode_number`, optional `release_date` |

- [ ] **Step 20: Declare MediaDetails and its required kind oneof**

Declare `MediaDetails` tags exactly:

```proto
message MediaDetails {
  MediaSummary summary = 1;
  optional string original_title = 2;
  optional string synopsis = 3;
  optional string tagline = 4;
  repeated string genres = 5;
  repeated string studios = 6;
  repeated MediaCredit credits = 7;
  repeated ArtworkReference artwork = 8;
  repeated MediaParent parents = 9;
  repeated MediaSourceSummary source_summaries = 10;
  oneof kind_details {
    option (buf.validate.oneof).required = true;
    MovieDetails movie = 11;
    ShowDetails show = 12;
    SeasonDetails season = 13;
    EpisodeDetails episode = 14;
  }
}
```

Require `summary`; cap ordered credits at 100, genres/studios at 50, parents at 3, and source summaries at 100. Matching the oneof member to `summary.kind` remains handler validation.

- [ ] **Step 21: Declare artwork locator, source, and part messages**

| Message | Fields in tag order |
| --- | --- |
| `ArtworkLocator` | `url`, repeated `headers`, repeated `allowed_redirect_origins`, required `refresh_at`, optional `access_expires_at`, optional `width`, optional `height` |
| `MediaSource` | `id`, `media_id`, optional `label`, `availability`, optional `runtime`, optional `bit_rate_bps`, repeated `parts` |
| `MediaPart` | `id`, `order`, `container`, optional `runtime`, optional `size_bytes`, optional `bit_rate_bps`, repeated `tracks` |

Cap parts at 100, validate absolute HTTP/HTTPS locator URLs, and cap headers/origins using plan 1 limits.

- [ ] **Step 22: Declare technical track messages**

| Message | Fields in tag order |
| --- | --- |
| `VideoTrack` | `codec`, optional `width`, optional `height`, optional `frame_rate`, optional `bit_depth`, optional `dynamic_range` |
| `AudioTrack` | `codec`, optional `title`, optional `language`, optional `channel_count`, optional `channel_layout`, optional `sample_rate_hz`, optional `spatial_format`, `is_default`, `is_commentary` |
| `SubtitleTrack` | `codec`, optional `title`, optional `language`, `representation`, `is_default`, `is_forced`, `is_hearing_impaired`, `is_commentary` |

Declare `MediaTrack` as `order = 1` plus required oneof group `details`: `video = 2`, `audio = 3`, `subtitle = 4`. Cap tracks at 100 and require non-zero dimensions/bit depth/rates when present.

- [ ] **Step 23: Generate the canonical media clients**

Run: `mise run generate`

- [ ] **Step 24: Run all public media round trips**

Run:

```bash
mise run check:contracts
mise run check:ts
mise run check:go
mise run check:swift
```

Expected: PASS, including `google.type.Date` compilation in every public language.

- [ ] **Step 25: Commit the canonical media model**

```bash
git add proto/nama/api/v1/media.proto apps/server/src/contract.test.ts apps/cli/internal/cli/contracts_test.go gen/swift/Tests gen/ts gen/go gen/swift/Sources/NamaAPI go.mod go.sum
git commit -m "feat(api): add canonical media contract"
```

### Task 2: Add stored-library and artwork RPCs

**Files:**

- Create: `proto/nama/api/v1/library.proto`
- Modify: `apps/server/src/contract.test.ts`
- Modify: `apps/cli/internal/cli/contracts_test.go`
- Modify: `gen/swift/Tests/NamaAPITests/ContractTests.swift`
- Regenerate: `gen/ts/src/nama/api/v1/**`
- Regenerate: `gen/go/nama/api/v1/**`
- Regenerate: `gen/swift/Sources/NamaAPI/**`

**Interfaces:**

- Consumes: canonical media and artwork messages from `media.proto`.
- Produces: bounded home, browse, search, hierarchy, source-detail, and artwork-resolution reads.

- [ ] **Step 1: Write failing home/list/detail tests**

Round-trip a three-section Home response, a filtered movie list, a cast-name search response, a season child page, a technical source response, and an artwork locator with distinct refresh/access deadlines.

- [ ] **Step 2: Run the public library red check**

Run: `mise run check:go`

Expected: FAIL because library messages do not exist.

- [ ] **Step 3: Declare the three library enums**

```proto
enum HomeSectionKind {
  HOME_SECTION_KIND_UNSPECIFIED = 0;
  HOME_SECTION_KIND_CONTINUE_WATCHING = 1;
  HOME_SECTION_KIND_MOVIES = 2;
  HOME_SECTION_KIND_SHOWS = 3;
}

enum WatchFilter {
  WATCH_FILTER_UNSPECIFIED = 0;
  WATCH_FILTER_ANY = 1;
  WATCH_FILTER_WATCHED = 2;
  WATCH_FILTER_UNWATCHED = 3;
  WATCH_FILTER_IN_PROGRESS = 4;
}

enum LibrarySort {
  LIBRARY_SORT_UNSPECIFIED = 0;
  LIBRARY_SORT_TITLE_ASC = 1;
  LIBRARY_SORT_RELEASE_DATE_DESC = 2;
  LIBRARY_SORT_DATE_ADDED_DESC = 3;
}
```

- [ ] **Step 4: Declare HomeSection and LibraryFilter**

Declare `HomeSection` fields `id = 1`, `title = 2`, `kind = 3`, repeated `items = 4`. Declare `LibraryFilter` fields repeated `kinds = 1`, optional `genre = 2`, optional `release_year = 3`, `watch_filter = 4`, `playable_only = 5`.

- [ ] **Step 5: Declare the seven-method LibraryService inventory**

```proto
service LibraryService {
  rpc GetHome(GetHomeRequest) returns (GetHomeResponse);
  rpc ListLibrary(ListLibraryRequest) returns (ListLibraryResponse);
  rpc Search(SearchRequest) returns (SearchResponse);
  rpc GetMedia(GetMediaRequest) returns (GetMediaResponse);
  rpc ListChildren(ListChildrenRequest) returns (ListChildrenResponse);
  rpc GetMediaSource(GetMediaSourceRequest) returns (GetMediaSourceResponse);
  rpc ResolveArtwork(ResolveArtworkRequest) returns (ResolveArtworkResponse);
}
```

- [ ] **Step 6: Declare home and library-list messages**

| Message | Fields in tag order |
| --- | --- |
| `GetHomeRequest` | optional `section_size` |
| `GetHomeResponse` | repeated `sections` |
| `ListLibraryRequest` | optional `filter`, `sort`, `page_size`, `page_token` |
| `ListLibraryResponse` | repeated `items`, `next_page_token` |

Section size is zero/default or 1–50. Home has at most three initial sections and 50 items per section. Page responses are at most 100.

- [ ] **Step 7: Declare search and media-detail messages**

| Message | Fields in tag order |
| --- | --- |
| `SearchRequest` | `query`, repeated `kinds`, `page_size`, `page_token` |
| `SearchResponse` | repeated `items`, `next_page_token` |
| `GetMediaRequest` | `media_id` |
| `GetMediaResponse` | required `media` |

Search query is trimmed, 1–256 characters; whitespace-only rejection remains handler validation.

- [ ] **Step 8: Declare hierarchy, source, and artwork messages**

| Message | Fields in tag order |
| --- | --- |
| `ListChildrenRequest` | `parent_media_id`, `page_size`, `page_token` |
| `ListChildrenResponse` | repeated `items`, `next_page_token` |
| `GetMediaSourceRequest` | `media_id`, `source_id` |
| `GetMediaSourceResponse` | required `source` |
| `ResolveArtworkRequest` | `artwork_id`, optional `max_width`, optional `max_height` |
| `ResolveArtworkResponse` | required `locator` |

Page responses are at most 100.

- [ ] **Step 9: Generate the library clients**

Run: `mise run generate`

- [ ] **Step 10: Run the library contract checks**

Run:

```bash
mise run check:contracts
mise run check:ts
mise run check:go
mise run check:swift
```

Expected: PASS.

- [ ] **Step 11: Commit the library contract slice**

```bash
git add proto/nama/api/v1/library.proto apps/server/src/contract.test.ts apps/cli/internal/cli/contracts_test.go gen/swift/Tests gen/ts gen/go gen/swift/Sources/NamaAPI
git commit -m "feat(api): add library read contracts"
```

### Task 3: Add the public playback lifecycle

**Files:**

- Create: `proto/nama/api/v1/playback.proto`
- Modify: `apps/server/src/contract.test.ts`
- Modify: `apps/cli/internal/cli/contracts_test.go`
- Modify: `gen/swift/Tests/NamaAPITests/ContractTests.swift`
- Regenerate: `gen/ts/src/nama/api/v1/**`
- Regenerate: `gen/go/nama/api/v1/**`
- Regenerate: `gen/swift/Sources/NamaAPI/**`

**Interfaces:**

- Consumes: public media quality/state types and `HttpHeader`.
- Produces: capability-aware planning, one logical open, session-scoped tracks/sidecars, ordered telemetry, and idempotent close messages.

- [ ] **Step 1: Write failing plan/session/sidecar round trips**

Create a plan with direct-play and subtitle actions, then a session with new session track IDs, one locally switchable audio track, one non-switchable subtitle track, and one external subtitle locator. Round-trip report sequence 7 and a completed close response.

- [ ] **Step 2: Run the public playback red check**

Run: `mise run check:swift`

Expected: FAIL because playback messages do not exist.

- [ ] **Step 3: Declare transport and preference enums**

```proto
enum DeliveryProtocol {
  DELIVERY_PROTOCOL_UNSPECIFIED = 0;
  DELIVERY_PROTOCOL_HTTP_PROGRESSIVE = 1;
  DELIVERY_PROTOCOL_HLS = 2;
}
enum SubtitleDeliveryMode {
  SUBTITLE_DELIVERY_MODE_UNSPECIFIED = 0;
  SUBTITLE_DELIVERY_MODE_EMBEDDED = 1;
  SUBTITLE_DELIVERY_MODE_EXTERNAL = 2;
  SUBTITLE_DELIVERY_MODE_BURNED_IN = 3;
}
enum PlaybackQuality {
  PLAYBACK_QUALITY_UNSPECIFIED = 0;
  PLAYBACK_QUALITY_AUTO = 1;
  PLAYBACK_QUALITY_ORIGINAL = 2;
  PLAYBACK_QUALITY_CAPPED = 3;
}
enum SubtitlePreference {
  SUBTITLE_PREFERENCE_UNSPECIFIED = 0;
  SUBTITLE_PREFERENCE_AUTO = 1;
  SUBTITLE_PREFERENCE_OFF = 2;
  SUBTITLE_PREFERENCE_FORCED_ONLY = 3;
  SUBTITLE_PREFERENCE_ALWAYS = 4;
}
```

- [ ] **Step 4: Declare strategy and track-action enums**

```proto
enum PlaybackStrategy {
  PLAYBACK_STRATEGY_UNSPECIFIED = 0;
  PLAYBACK_STRATEGY_DIRECT = 1;
  PLAYBACK_STRATEGY_REMUX = 2;
  PLAYBACK_STRATEGY_TRANSCODE_AUDIO = 3;
  PLAYBACK_STRATEGY_TRANSCODE_VIDEO = 4;
}
enum PlaybackTrackType {
  PLAYBACK_TRACK_TYPE_UNSPECIFIED = 0;
  PLAYBACK_TRACK_TYPE_AUDIO = 1;
  PLAYBACK_TRACK_TYPE_SUBTITLE = 2;
}
enum TrackActionKind {
  TRACK_ACTION_KIND_UNSPECIFIED = 0;
  TRACK_ACTION_KIND_COPY = 1;
  TRACK_ACTION_KIND_TRANSCODE = 2;
  TRACK_ACTION_KIND_BURN = 3;
  TRACK_ACTION_KIND_EXTERNAL = 4;
  TRACK_ACTION_KIND_OMIT = 5;
}
```

- [ ] **Step 5: Declare playback lifecycle enums**

```proto
enum PlaybackState {
  PLAYBACK_STATE_UNSPECIFIED = 0;
  PLAYBACK_STATE_PLAYING = 1;
  PLAYBACK_STATE_PAUSED = 2;
  PLAYBACK_STATE_BUFFERING = 3;
}
enum PlaybackCloseReason {
  PLAYBACK_CLOSE_REASON_UNSPECIFIED = 0;
  PLAYBACK_CLOSE_REASON_STOPPED = 1;
  PLAYBACK_CLOSE_REASON_COMPLETED = 2;
  PLAYBACK_CLOSE_REASON_FAILED = 3;
  PLAYBACK_CLOSE_REASON_CANCELLED = 4;
}
```

- [ ] **Step 6: Declare capabilities, preferences, and track formats**

| Message | Fields in tag order |
| --- | --- |
| `DirectPlayProfile` | `container`, optional `video_codec`, repeated `audio_codecs` |
| `SubtitleCapability` | `format`, repeated `delivery_modes` |
| `PlaybackCapabilities` | repeated `direct_play_profiles`, repeated `protocols`, repeated `subtitle_capabilities`, optional `max_width`, optional `max_height`, optional `max_video_bit_depth`, optional `max_audio_channels`, repeated `dynamic_ranges` |
| `PlaybackPreferences` | `quality`, optional `max_bit_rate_bps`, repeated `preferred_audio_languages`, repeated `preferred_subtitle_languages`, `subtitle_preference` |
| `PlaybackAudioTrackDetails` | `codec`, optional `channel_count`, optional `spatial_format` |
| `PlaybackSubtitleTrackDetails` | `codec`, `representation` |

Declare `PlaybackTrack` as `id = 1`, `type = 2`, optional `label = 3`, optional `language = 4`, `is_default = 5`, `is_forced = 6`, plus required oneof group `details`: `audio = 7` or `subtitle = 8`. Declare `SubtitleSelection` with required oneof group `selection`: `track_id = 1` or `disabled = 2`. Declare `TrackAction` fields `track_id = 1`, `action = 2`.

Place this exact rule inside `PlaybackPreferences`; track type/oneof agreement remains handler validation:

```proto
option (buf.validate.message).cel = {
  id: "playback_preferences.capped_bit_rate"
  message: "max_bit_rate_bps must be positive exactly when quality is CAPPED"
  expression: "(this.quality == 3 && has(this.max_bit_rate_bps) && this.max_bit_rate_bps > 0u) || (this.quality != 3 && !has(this.max_bit_rate_bps))"
};
```

- [ ] **Step 7: Declare planning and opening messages**

`PlaybackPlan` fields, in order:

1. `id`
2. `media_id`
3. `source_id`
4. required `expires_at`
5. `strategy`
6. `container`
7. optional `video_codec`
8. optional `audio_codec`
9. `protocol`
10. repeated `tracks`
11. optional `default_audio_track_id`
12. required `default_subtitle`
13. repeated `actions`

Declare method/resource fields:

| Message | Fields in tag order |
| --- | --- |
| `PlanPlaybackRequest` | `media_id`, optional `source_id`, required `capabilities`, optional `start_position`, required `preferences` |
| `PlanPlaybackResponse` | required `plan` |
| `OpenPlaybackRequest` | `operation_id`, `plan_id`, optional `audio_track_id`, required `subtitle` |
| `PlaybackLocator` | `url`, repeated `headers`, repeated `allowed_redirect_origins`, `mime_type`, required `expires_at` |
| `PlaybackSessionTrack` | `id`, `type`, optional `label`, optional `language`, `is_default`, `is_forced`, required oneof group `details`: `audio = 7` or `subtitle = 8`, `switchable_without_reopen = 9` |
| `ExternalSubtitleLocator` | `track_id`, `url`, repeated `headers`, repeated `allowed_redirect_origins`, `mime_type`, required `expires_at` |
| `PlaybackSession` | `id`, `strategy`, `protocol`, `container`, optional `video_codec`, optional `audio_codec`, required `locator`, required `report_interval`, repeated `tracks`, optional `selected_audio_track_id`, required `selected_subtitle`, repeated `external_subtitles` |
| `OpenPlaybackResponse` | required `session` |

Cap tracks/actions at 100, external sidecars at 100, and require every plan, locator, and sidecar expiry to be a present valid Timestamp. The exactly-one-sidecar-per-external-track, safe authorization scope, selected-track membership, plan single-open, and session mapping lifetime are handler rules.

- [ ] **Step 8: Declare report/close messages and service**

```proto
service PlaybackService {
  rpc PlanPlayback(PlanPlaybackRequest) returns (PlanPlaybackResponse);
  rpc OpenPlayback(OpenPlaybackRequest) returns (OpenPlaybackResponse);
  rpc ReportPlayback(ReportPlaybackRequest) returns (ReportPlaybackResponse);
  rpc ClosePlayback(ClosePlaybackRequest) returns (ClosePlaybackResponse);
}
```

| Message | Fields in tag order |
| --- | --- |
| `ReportPlaybackRequest` | `event_id`, `playback_session_id`, `sequence`, `state`, required `position`, optional `duration`, optional `client_observed_at`, optional `selected_audio_track_id`, optional `selected_subtitle_track_id` |
| `ReportPlaybackResponse` | `accepted_sequence`, required `user_state` |
| `ClosePlaybackRequest` | `operation_id`, `playback_session_id`, required `final_position`, optional `duration`, `reason`, optional `client_observed_at` |
| `ClosePlaybackResponse` | required `user_state` |

Require positive sequence numbers and valid non-negative durations. Do not encode provider telemetry results or cleanup state in public responses.

- [ ] **Step 9: Generate the public playback client**

Run: `mise run generate`

- [ ] **Step 10: Run the public playback checks**

Run:

```bash
mise run check:contracts
mise run check:ts
mise run check:go
mise run check:swift
```

Expected: PASS, including external-subtitle and session-track round trips.

- [ ] **Step 11: Commit public playback**

```bash
git add proto/nama/api/v1/playback.proto apps/server/src/contract.test.ts apps/cli/internal/cli/contracts_test.go gen/swift/Tests gen/ts gen/go gen/swift/Sources/NamaAPI
git commit -m "feat(api): add playback lifecycle contract"
```

### Task 4: Add current-principal user-state methods

**Files:**

- Create: `proto/nama/api/v1/user_state.proto`
- Modify: `apps/server/src/contract.test.ts`
- Modify: `apps/cli/internal/cli/contracts_test.go`
- Modify: `gen/swift/Tests/NamaAPITests/ContractTests.swift`
- Regenerate: `gen/ts/src/nama/api/v1/**`
- Regenerate: `gen/go/nama/api/v1/**`
- Regenerate: `gen/swift/Sources/NamaAPI/**`

**Interfaces:**

- Consumes: `MediaUserState` from `media.proto`.
- Produces: one read and one explicit watched-target mutation; no duplicate progress mutation path.

- [ ] **Step 1: Write failing watched/unwatched round trips**

Construct `SetWatchedRequest` once with `watched = true` and once with `watched = false`; verify false survives serialization as an explicit target because request presence comes from the containing message, not a toggle convention.

- [ ] **Step 2: Run the user-state red check**

Run: `mise run check:go`

Expected: FAIL because UserStateService is missing.

- [ ] **Step 3: Declare exact methods and messages**

```proto
service UserStateService {
  rpc GetUserState(GetUserStateRequest) returns (GetUserStateResponse);
  rpc SetWatched(SetWatchedRequest) returns (SetWatchedResponse);
}
```

| Message | Fields in tag order |
| --- | --- |
| `GetUserStateRequest` | `media_id` |
| `GetUserStateResponse` | required `user_state` |
| `SetWatchedRequest` | `operation_id`, `media_id`, `watched` |
| `SetWatchedResponse` | required `user_state` |

Do not add `user_id`, toggle, client timestamp, or `SetProgress`.

- [ ] **Step 4: Generate the user-state client**

Run: `mise run generate`

- [ ] **Step 5: Verify the user-state contract**

Run:

```bash
mise run check:contracts
mise run check:ts
mise run check:go
mise run check:swift
```

Expected: PASS.

- [ ] **Step 6: Commit the user-state contract**

```bash
git add proto/nama/api/v1/user_state.proto apps/server/src/contract.test.ts apps/cli/internal/cli/contracts_test.go gen/swift/Tests gen/ts gen/go gen/swift/Sources/NamaAPI
git commit -m "feat(api): add user state contract"
```

### Task 5: Complete the 36-method public contract inventory

**Files:**

- Modify: `apps/server/src/contract-authorization.ts`
- Modify: `apps/server/src/contract.test.ts`
- Modify: `apps/server/src/contract-probe.ts`

**Interfaces:**

- Consumes: the 23 management methods from plan 2 and 13 consumer methods from this plan.
- Produces: a complete public descriptor/authority inventory and consumer compile probes.

- [ ] **Step 1: Run the existing descriptor completeness test**

Run: `pnpm --filter @nama/server run check:contract`

Expected: FAIL with the seven Library, four Playback, and two UserState methods absent from the authority map.

- [ ] **Step 2: Add all 13 consumer methods**

Map every method in `LibraryService`, `PlaybackService`, and `UserStateService` to `administrator-or-device`. The sorted descriptor set must then equal the 36 map keys exactly.

- [ ] **Step 3: Add public boundary checks**

Extend the TypeScript contract test to inspect generated public descriptors and assert:

- no service, method, message, or field name contains `jellyfin`, `plex`, `provider_item`, `provider_source`, `stream_index`, `file_path`, or `session_context`;
- `BadRequest.FieldViolation` round-trips `field`, `description`, `reason`, and `localized_message` for `configuration.base_url`;
- an unknown future numeric enum value survives a representative TypeScript round trip (plan 4 mirrors and validates it natively);
- `SubtitleSelection` preserves both the track and disabled alternatives; and
- refresh and access expiries are distinct fields.

- [ ] **Step 4: Complete only the server compile probe**

Reference every public service descriptor from the existing TypeScript server probe. Keep the CLI and tvOS application entry points on their approved Health-only Milestone 0 probes; the Go and Swift native package tests compile and round-trip representative `MediaSummary`, `MediaDetails`, `PlaybackPlan`, and `PlaybackSession` values without importing plugin types or AetherEngine.

- [ ] **Step 5: Run all public checks**

Run:

```bash
mise run check:contracts
mise run check:ts
mise run check:go
mise run check:swift
```

Expected: PASS and exactly 36 public RPC descriptors.

- [ ] **Step 6: Commit the public contract inventory**

```bash
git add apps/server/src/contract-authorization.ts apps/server/src/contract.test.ts apps/server/src/contract-probe.ts
git commit -m "test(api): lock public contract surface"
```

## Plan 3 Completion Gate

Run:

```bash
mise run check:contracts
mise run check:ts
mise run check:go
mise run check:swift
if rg -n -i 'jellyfin|plex|provider_item|provider_source|stream_index|file_path|session_context' proto/nama/api; then
  printf '%s\n' 'unexpected provider-private symbol in public contract' >&2
  exit 1
else
  search_status=$?
  test "$search_status" -eq 1
fi
git status --short
```

Expected: all checks pass; the public-boundary search returns no matches; only plan 4 plugin/final-conformance work remains.
