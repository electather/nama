# Milestone 0 Plugin Contracts and Conformance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Define the complete private provider-plugin contract and close Milestone 0 with handwritten policy, normalization, boundary, generation, application-compilation, and breaking-change evidence.

**Architecture:** `nama.plugin.v1` is an independent, authenticated subprocess boundary. It duplicates normalized concepts where necessary, retains opaque provider references only inside the private package, and returns bounded observations or leases for the core to validate and map. Final conformance checks compile the real TypeScript applications and test only handwritten authorization, CEL execution, field-error normalization, and real adapter behavior.

**Tech Stack:** Protobuf, Protovalidate annotations, Buf, Protobuf-ES, Node.js built-in tests, TypeScript, mise, existing GitHub Actions.

## Global Constraints

- This is plan 4 of 4 and depends on all three earlier Milestone 0 plans.
- Complete and commit the approved documentation changes before starting implementation; do not overwrite the existing `docs/architecture/api-contracts.md` amendments.
- Plugin schemas generate TypeScript only. Go, Swift, the CLI, and tvOS must not contain or import `nama.plugin.v1` types.
- Plugin requests never carry provider account credentials. The supervised process receives candidate/stored configuration and credentials out of band at launch.
- Every plugin call is unary, authenticated by the per-launch bearer, deadline/cancellation aware at runtime, and represented by a method-specific request/response message.
- Plugins are stateless translators: no database, durable cursor, durable credential refresh, account selection per request, or provider SDK payload crosses the boundary.
- Package-local provider references are opaque and hierarchical. The configured instance and immutable provider-user binding are implied by the authenticated process.
- Plugin URL/header/origin/session-context fields are untrusted and bounded. The core's later handler remains responsible for safe-origin, authorization-scope, and credential validation.
- Catalog and watch scans are best effort. Do not invent snapshot revisions, durable provider change cursors, webhooks, subscriptions, or event streams.
- Playback mirrors plan/open/report/close. Provider track references are mapped to public IDs by the core; report fields are observations, not switch commands.
- Watch-state batches are explicitly non-atomic, use per-mutation results, and never expose toggle or “maximum progress wins” semantics.
- Required enum fields use `(buf.validate.field).enum = { not_in: [0] }`; never use `defined_only`, because unknown future numeric values must remain valid.
- Every present Timestamp carries `(buf.validate.field).timestamp = {}`. Every present Duration is non-negative with `(buf.validate.field).duration.gte = {}`; every returned `report_interval` is required and strictly positive with `(buf.validate.field).duration.gt = {}`.
- Use exact field/enum numbers listed here, plan 1 structural bounds, and required oneofs. Regenerate; never hand-edit generated code.

### Wire Type Key

Field tables and numbered lists fix tags by left-to-right order. Unless a row names a message type explicitly, use these exact protobuf types:

- `string`: every ID/reference leaf/revision/token plus textual names, `build_version`, descriptions, summaries, titles, labels, codecs, containers, formats, languages, locales, namespaces, external/header values, MIME types, URLs, redirect origins, and page continuations. `contract_major` and `schema_profile_version` are the explicit `uint32` exceptions below.
- `bool`: every `is_*` field plus `complete`, `watched`, `disabled`, and `switchable_without_reopen`.
- `uint32`: `contract_major`, `schema_profile_version`, `release_year`, `season_number`, `episode_number`, `season_count`, `episode_count`, `order`, `width`, `height`, `bit_depth`, `channel_count`, `sample_rate_hz`, `page_size`, `max_width`, `max_height`, `max_video_bit_depth`, and `max_audio_channels`.
- `uint64`: `size_bytes`, every `bit_rate_bps` field, and playback `sequence`.
- `double`: `frame_rate`.
- `bytes`: `session_context`.
- `google.protobuf.Duration`: runtime, position, duration, start/final position, and report interval fields.
- `google.protobuf.Timestamp`: every field ending in `_at`, including plan/lease/sidecar expiry and provider/client observation time.
- `google.type.Date`: every release-date field.
- `google.protobuf.Struct`: `configuration_schema`.
- The declared enum type: `status`, `capabilities`, `kind`, `role`, `availability`, `dynamic_range`, `spatial_format`, `text_presence`, `representation`, `consistency`, `authorization_scope`, `protocol`/`protocols`, `delivery_modes`, `quality`, `subtitle_preference`, `strategy`, `type`, `action`, `ReportPlaybackRequest.state`, `reason`, `reliability`, and `semantics`.
- Reference fields map by exact noun: `item_reference`/`item_references`/`show_reference`/`season_reference` → `ProviderItemReference`; `source_reference` → `ProviderSourceReference`; `part_reference` → `ProviderPartReference`; every `track_reference`, `default_audio_track_reference`, `audio_track_reference`, `selected_audio_track_reference`, and `selected_subtitle_track_reference` → `ProviderTrackReference`; and `artwork_reference`/`portrait_artwork_reference` → `ProviderArtworkReference`.
- Identity/media fields map exactly: `plugin_info` → `PluginInfo`; `connection` → `PluginConnection`; `credits` → `ProviderMediaCredit`; `external_identifiers` → `ExternalIdentifier`; media `artwork` → `ProviderArtwork`; `sources` → `ProviderMediaSource`; source `parts` → `ProviderMediaPart`; part `tracks` → `ProviderMediaTrack`; media-track oneof `video`/`audio`/`subtitle` → `ProviderVideoTrack`/`ProviderAudioTrack`/`ProviderSubtitleTrack`; and kind oneofs → `ProviderMovieDetails`, `ProviderShowDetails`, `ProviderSeasonDetails`, or `ProviderEpisodeDetails`.
- Library fields map exactly: ListItems `begin` → `BeginListItems`; `items` and GetItem `item` → `ProviderMediaItem`; and ResolveArtwork `lease` → `ProviderArtworkLease`.
- Playback fields map exactly: `direct_play_profiles` → `DirectPlayProfile`; `subtitle_capabilities` → `SubtitleCapability`; `capabilities` → `PlaybackCapabilities`; `preferences` → `PlaybackPreferences`; track `audio`/`subtitle` → `PlaybackAudioTrackDetails`/`PlaybackSubtitleTrackDetails`; plan `tracks` → `ProviderPlaybackTrack`; `default_subtitle`/request `subtitle`/`selected_subtitle` → `ProviderSubtitleSelection`; `actions` → `ProviderTrackAction`; `plan` → `PluginPlaybackPlan`; lease `tracks` → `ProviderSessionTrack`; `external_subtitles` → `ProviderExternalSubtitleLocator`; and OpenPlayback `lease` → `PlaybackLease`.
- Watch-state fields map exactly: `provider_activity` → `ProviderActivity`; list `begin` → `BeginWatchStateList`; `states`, read `state`, and mutation-result `observed_state` → `ProviderWatchState`; read `results` → `WatchStateReadResult`; mutation oneof `set_watched`/`set_progress` → `SetWatched`/`SetProgress`; `mutations` → `WatchStateMutation`; and push `results` → `WatchStateMutationResult`.
- Every remaining scalar field, including `format`, `summary`, and header `name`/`value`, is `string`; do not infer another wire type from a sample value.

An `optional` marker means proto3 explicit presence for a scalar/enum. Message fields already have presence; “required” means attach `(buf.validate.field).required = true`. `headers` is always `repeated nama.plugin.v1.HttpHeader`; `allowed_redirect_origins` is always `repeated string`.

---

### Task 1: Add plugin identity, capability, and connection contracts

**Files:**

- Modify: `proto/nama/plugin/v1/health.proto`
- Create: `proto/nama/plugin/v1/plugin.proto`
- Modify: `plugins/jellyfin/src/contract-probe.ts`
- Regenerate: `gen/ts/src/**`

**Interfaces:**

- Consumes: private `HttpHeader`/provider references from plan 1 and the existing plugin Health anchor.
- Produces: discovery-safe plugin information and configured/candidate connection inspection.

- [ ] **Step 1: Declare private capability and connection enums**

```proto
enum ProviderCapability {
  PROVIDER_CAPABILITY_UNSPECIFIED = 0;
  PROVIDER_CAPABILITY_LIBRARY_READ = 1;
  PROVIDER_CAPABILITY_ARTWORK_RESOLVE = 2;
  PROVIDER_CAPABILITY_PLAYBACK_PLAN = 3;
  PROVIDER_CAPABILITY_PLAYBACK_OPEN = 4;
  PROVIDER_CAPABILITY_PLAYBACK_REPORT = 5;
  PROVIDER_CAPABILITY_PLAYBACK_REPORTS_USER_STATE = 6;
  PROVIDER_CAPABILITY_WATCH_STATE_READ = 7;
  PROVIDER_CAPABILITY_WATCHED_WRITE = 8;
  PROVIDER_CAPABILITY_PROGRESS_WRITE = 9;
}

enum PluginConnectionStatus {
  PLUGIN_CONNECTION_STATUS_UNSPECIFIED = 0;
  PLUGIN_CONNECTION_STATUS_CONNECTED = 1;
  PLUGIN_CONNECTION_STATUS_AUTHENTICATION_FAILED = 2;
  PLUGIN_CONNECTION_STATUS_UNREACHABLE = 3;
  PLUGIN_CONNECTION_STATUS_INCOMPATIBLE = 4;
}
```

These values deliberately match public capability semantics without importing the public package.

- [ ] **Step 2: Declare plugin resources and RPCs**

| Message | Fields in tag order |
| --- | --- |
| `PluginInfo` | `provider_type_id`, `display_name`, `description`, `build_version`, `contract_major`, repeated `capabilities`, required `configuration_schema`, `schema_profile_version`, `schema_revision` |
| `PluginConnection` | `status`, optional `remote_name`, optional `remote_version`, optional `provider_user_reference`, repeated `capabilities` |
| `GetInfoRequest` | no fields |
| `GetInfoResponse` | required `plugin_info` |
| `GetConnectionRequest` | no fields |
| `GetConnectionResponse` | required `connection` |

```proto
service PluginService {
  rpc GetInfo(GetInfoRequest) returns (GetInfoResponse);
  rpc GetConnection(GetConnectionRequest) returns (GetConnectionResponse);
}
```

Require positive `contract_major`, bound capability lists to 32 unique values, and apply the same schema-text bounds as public ProviderService. Do not add instance configuration or credentials to either request.

- [ ] **Step 3: Add validation without changing the Health anchor**

Import `buf/validate/validate.proto` and attach `(buf.validate.field).enum = { not_in: [0] }` to `CheckResponse.status`. Do not contact a provider or add connection fields. Preserve `ServingStatus` values, `CheckResponse.status = 1`, and `HealthService.Check` exactly.

- [ ] **Step 4: Generate the plugin identity client**

Run: `mise run generate`

- [ ] **Step 5: Run the plugin identity schema and application checks**

Run:

```bash
mise run check:contracts
mise run check:ts
```

Expected: PASS.

- [ ] **Step 6: Commit plugin identity**

```bash
git add proto/nama/plugin/v1/health.proto proto/nama/plugin/v1/plugin.proto plugins/jellyfin/src/contract-probe.ts gen/ts
git commit -m "feat(plugin): add identity and connection contracts"
```

### Task 2: Add normalized plugin media and library scans

**Files:**

- Create: `proto/nama/plugin/v1/media.proto`
- Create: `proto/nama/plugin/v1/library.proto`
- Modify: `plugins/jellyfin/src/contract-probe.ts`
- Regenerate: `gen/ts/src/**`

**Interfaces:**

- Consumes: hierarchical provider references and private plugin identity capabilities.
- Produces: bounded normalized provider observations, best-effort scans, targeted repair, and artwork leases.

- [ ] **Step 1: Declare private media-kind and availability enums**

Declare these package-local values; do not import `nama.api.v1`:

```proto
enum MediaKind {
  MEDIA_KIND_UNSPECIFIED = 0;
  MEDIA_KIND_MOVIE = 1;
  MEDIA_KIND_SHOW = 2;
  MEDIA_KIND_SEASON = 3;
  MEDIA_KIND_EPISODE = 4;
}
enum SourceAvailability {
  SOURCE_AVAILABILITY_UNSPECIFIED = 0;
  SOURCE_AVAILABILITY_AVAILABLE = 1;
  SOURCE_AVAILABILITY_PROVIDER_UNAVAILABLE = 2;
  SOURCE_AVAILABILITY_UNSUPPORTED = 3;
}
```

- [ ] **Step 2: Declare private audiovisual enums**

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

- [ ] **Step 3: Declare private artwork and credit enums**

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

- [ ] **Step 4: Declare credits and kind-specific observations**

| Message | Fields in tag order |
| --- | --- |
| `ExternalIdentifier` | `namespace`, `value` |
| `ProviderMediaCredit` | `name`, `role`, optional `character_name`, optional `portrait_artwork_reference` |
| `ProviderMovieDetails` | optional `release_date` |
| `ProviderShowDetails` | optional `first_release_date`, optional `last_release_date`, optional `season_count`, optional `episode_count` |
| `ProviderSeasonDetails` | optional `show_reference`, `season_number`, optional `episode_count` |
| `ProviderEpisodeDetails` | optional `show_reference`, optional `season_reference`, `season_number`, `episode_number`, optional `release_date` |

- [ ] **Step 5: Declare artwork and technical-track observations**

| Message | Fields in tag order |
| --- | --- |
| `ProviderArtwork` | required `artwork_reference`, `role`, optional `width`, optional `height`, optional `locale`, `text_presence` |
| `ProviderVideoTrack` | `codec`, optional `width`, optional `height`, optional `frame_rate`, optional `bit_depth`, optional `dynamic_range` |
| `ProviderAudioTrack` | `codec`, optional `title`, optional `language`, optional `channel_count`, optional `channel_layout`, optional `sample_rate_hz`, optional `spatial_format`, `is_default`, `is_commentary` |
| `ProviderSubtitleTrack` | `codec`, optional `title`, optional `language`, `representation`, `is_default`, `is_forced`, `is_hearing_impaired`, `is_commentary` |

- [ ] **Step 6: Declare part, source, and track wrappers**

| Message | Fields in tag order |
| --- | --- |
| `ProviderMediaPart` | required `part_reference`, `order`, `container`, optional `runtime`, optional `size_bytes`, optional `bit_rate_bps`, repeated `tracks` |
| `ProviderMediaSource` | required `source_reference`, optional `label`, `availability`, optional `runtime`, optional `bit_rate_bps`, repeated `parts` |

Declare `ProviderMediaTrack` as required `track_reference = 1`, `order = 2`, and required oneof group `details`: `video = 3`, `audio = 4`, `subtitle = 5`.

- [ ] **Step 7: Declare the normalized ProviderMediaItem**

Declare `ProviderMediaItem` fields exactly:

1. required `item_reference`
2. `kind`
3. `title`
4. optional `original_title`
5. optional `synopsis`
6. optional `tagline`
7. optional `release_year`
8. optional `runtime`
9. optional `content_rating`
10. repeated `genres`
11. repeated `studios`
12. repeated `credits`
13. repeated `external_identifiers`
14. repeated `artwork`
15. repeated `sources`
16–19. required oneof group `kind_details`: `movie`, `show`, `season`, `episode`

Set `genres` and `studios` to at most 50; `credits`, `external_identifiers`, and `sources` to at most 100; and `artwork` to at most 20. Each source has at most 100 parts and each part at most 100 tracks. Never add raw JSON, a display-derived inferred value, a provider SDK object, a filesystem path, or an already-authorized media URL.

- [ ] **Step 8: Declare scan consistency and artwork scope enums**

```proto
enum ListConsistency {
  LIST_CONSISTENCY_UNSPECIFIED = 0;
  LIST_CONSISTENCY_BEST_EFFORT_SCAN = 1;
}

enum ArtworkAuthorizationScope {
  ARTWORK_AUTHORIZATION_SCOPE_UNSPECIFIED = 0;
  ARTWORK_AUTHORIZATION_SCOPE_PUBLIC = 1;
  ARTWORK_AUTHORIZATION_SCOPE_MEDIA_ITEM = 2;
  ARTWORK_AUTHORIZATION_SCOPE_PROVIDER_ACCOUNT = 3;
}
```

- [ ] **Step 9: Declare paged scan and targeted-get messages**

| Message | Fields in tag order |
| --- | --- |
| `BeginListItems` | `page_size` |
| `ListItemsRequest` | required oneof group `scan`: `begin`, `continuation` |
| `ListItemsResponse` | repeated `items`, optional `next_page_token`, `complete`, `consistency` |
| `GetItemRequest` | required `item_reference` |
| `GetItemResponse` | required `item` |

For continuation, use a bounded string directly in the oneof; do not wrap it with mutable scan parameters. Cap pages at 100.

- [ ] **Step 10: Declare artwork resolution messages**

| Message | Fields in tag order |
| --- | --- |
| `ResolveArtworkRequest` | required `artwork_reference`, optional `max_width`, optional `max_height` |
| `ProviderArtworkLease` | `url`, repeated `headers`, repeated `allowed_redirect_origins`, optional `access_expires_at`, `mime_type`, `authorization_scope` |
| `ResolveArtworkResponse` | required `lease` |

Scope/expiry and header/origin safety relationships are core validation, not trusted plugin assertions.

- [ ] **Step 11: Declare the private LibraryService**

```proto
service LibraryService {
  rpc ListItems(ListItemsRequest) returns (ListItemsResponse);
  rpc GetItem(GetItemRequest) returns (GetItemResponse);
  rpc ResolveArtwork(ResolveArtworkRequest) returns (ResolveArtworkResponse);
}
```

- [ ] **Step 12: Generate the private media/library client**

Run: `mise run generate`

- [ ] **Step 13: Run the private media/library schema and application checks**

Run:

```bash
mise run check:contracts
mise run check:ts
```

Expected: PASS.

- [ ] **Step 14: Prove package isolation**

Run:

```bash
if rg -n 'nama/plugin/v1' gen/go gen/swift; then
  printf '%s\n' 'unexpected private contract in a public generated client' >&2
  exit 1
else
  search_status=$?
  test "$search_status" -eq 1
fi
```

Expected: no matches.

- [ ] **Step 15: Commit plugin media/library contracts**

```bash
git add proto/nama/plugin/v1/media.proto proto/nama/plugin/v1/library.proto plugins/jellyfin/src/contract-probe.ts gen/ts
git commit -m "feat(plugin): add media and library contracts"
```

### Task 3: Add plugin playback planning and leases

**Files:**

- Create: `proto/nama/plugin/v1/playback.proto`
- Modify: `plugins/jellyfin/src/contract-probe.ts`
- Regenerate: `gen/ts/src/**`

**Interfaces:**

- Consumes: plugin item/source/track references and package-local normalized media enums.
- Produces: private provider plans, materialized leases, session-track mappings, external subtitle locators, telemetry, and cleanup messages.

- [ ] **Step 1: Declare exact transport and preference enums**

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

- [ ] **Step 2: Declare exact strategy and track-action enums**

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

- [ ] **Step 3: Declare exact lifecycle and authorization enums**

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
enum PlaybackAuthorizationScope {
  PLAYBACK_AUTHORIZATION_SCOPE_UNSPECIFIED = 0;
  PLAYBACK_AUTHORIZATION_SCOPE_SESSION = 1;
  PLAYBACK_AUTHORIZATION_SCOPE_MEDIA_ITEM = 2;
  PLAYBACK_AUTHORIZATION_SCOPE_PROVIDER_ACCOUNT = 3;
}
```

- [ ] **Step 4: Declare exact private capability and format messages**

| Message | Fields in tag order |
| --- | --- |
| `DirectPlayProfile` | `container`, optional `video_codec`, repeated `audio_codecs` |
| `SubtitleCapability` | `format`, repeated `delivery_modes` |
| `PlaybackCapabilities` | repeated `direct_play_profiles`, repeated `protocols`, repeated `subtitle_capabilities`, optional `max_width`, optional `max_height`, optional `max_video_bit_depth`, optional `max_audio_channels`, repeated `dynamic_ranges` |
| `PlaybackPreferences` | `quality`, optional `max_bit_rate_bps`, repeated `preferred_audio_languages`, repeated `preferred_subtitle_languages`, `subtitle_preference` |
| `PlaybackAudioTrackDetails` | `codec`, optional `channel_count`, optional `spatial_format` |
| `PlaybackSubtitleTrackDetails` | `codec`, `representation` |

Use package-local enum/message types. Cap each repeated list at 100 and require unique enum/string capability lists where order is not semantic. Place this exact package-local rule inside `PlaybackPreferences`:

```proto
option (buf.validate.message).cel = {
  id: "playback_preferences.capped_bit_rate"
  message: "max_bit_rate_bps must be positive exactly when quality is CAPPED"
  expression: "(this.quality == 3 && has(this.max_bit_rate_bps) && this.max_bit_rate_bps > 0u) || (this.quality != 3 && !has(this.max_bit_rate_bps))"
};
```

- [ ] **Step 5: Declare provider playback tracks and plans**

| Message | Fields in tag order |
| --- | --- |
| `ProviderPlaybackTrack` | required `track_reference`, `type`, optional `label`, optional `language`, `is_default`, `is_forced`, required oneof group `details`: `audio`, `subtitle` |
| `ProviderSubtitleSelection` | required oneof group `selection`: `track_reference`, `disabled` |
| `ProviderTrackAction` | required `track_reference`, `action` |
| `PluginPlaybackPlan` | `id`, required `expires_at`, `strategy`, `container`, optional `video_codec`, optional `audio_codec`, `protocol`, repeated `tracks`, optional `default_audio_track_reference`, required `default_subtitle`, repeated `actions` |

Require the plan expiry to be a valid Timestamp. Track references in every selection/action must come from the plan at runtime; the wire schema only enforces presence and bounds.

- [ ] **Step 6: Declare PlanPlayback method messages**

| Message | Fields in tag order |
| --- | --- |
| `PlanPlaybackRequest` | required `item_reference`, required `source_reference`, required `capabilities`, optional `start_position`, required `preferences` |
| `PlanPlaybackResponse` | required `plan` |

- [ ] **Step 7: Declare open-selection and session-track messages**

| Message | Fields in tag order |
| --- | --- |
| `OpenPlaybackRequest` | `operation_id`, `plan_id`, optional `audio_track_reference`, required `subtitle` |
| `ProviderSessionTrack` | required `track_reference`, `switchable_without_reopen` |
| `ProviderExternalSubtitleLocator` | required `track_reference`, `url`, repeated `headers`, repeated `allowed_redirect_origins`, `mime_type`, required `expires_at` |

- [ ] **Step 8: Declare the PlaybackLease and open response**

| Message | Fields in tag order |
| --- | --- |
| `PlaybackLease` | `session_id`, `url`, repeated `headers`, `protocol`, `mime_type`, repeated `allowed_redirect_origins`, required `expires_at`, required `report_interval`, `authorization_scope`, repeated `tracks`, optional `selected_audio_track_reference`, required `selected_subtitle`, repeated `external_subtitles`, `session_context` |
| `OpenPlaybackResponse` | required `lease` |

- [ ] **Step 9: Declare report and close messages**

| Message | Fields in tag order |
| --- | --- |
| `ReportPlaybackRequest` | `event_id`, `session_id`, `sequence`, `state`, required `position`, optional `duration`, optional `client_observed_at`, optional `selected_audio_track_reference`, optional `selected_subtitle_track_reference`, `session_context` |
| `ReportPlaybackResponse` | no fields |
| `ClosePlaybackRequest` | `operation_id`, `session_id`, required `final_position`, optional `duration`, `reason`, optional `client_observed_at`, `session_context` |
| `ClosePlaybackResponse` | no fields |

Bound `session_context` to 65,536 bytes, tracks/sidecars to 100, and require positive report interval/sequence. Do not add public IDs, account credentials, provider write outcomes, or a switch-track method.

- [ ] **Step 10: Declare the mirrored lifecycle service**

```proto
service PlaybackService {
  rpc PlanPlayback(PlanPlaybackRequest) returns (PlanPlaybackResponse);
  rpc OpenPlayback(OpenPlaybackRequest) returns (OpenPlaybackResponse);
  rpc ReportPlayback(ReportPlaybackRequest) returns (ReportPlaybackResponse);
  rpc ClosePlayback(ClosePlaybackRequest) returns (ClosePlaybackResponse);
}
```

- [ ] **Step 11: Generate the private playback client**

Run: `mise run generate`

- [ ] **Step 12: Run the private playback schema and application checks**

Run:

```bash
mise run check:contracts
mise run check:ts
```

Expected: PASS with the generated private playback client compiled by the server and plugin applications.

- [ ] **Step 13: Commit the private playback contract**

```bash
git add proto/nama/plugin/v1/playback.proto plugins/jellyfin/src/contract-probe.ts gen/ts
git commit -m "feat(plugin): add playback lease contract"
```

### Task 4: Add best-effort watch-state reads and explicit writes

**Files:**

- Create: `proto/nama/plugin/v1/watch_state.proto`
- Modify: `plugins/jellyfin/src/contract-probe.ts`
- Regenerate: `gen/ts/src/**`

**Interfaces:**

- Consumes: provider item references, Timestamp, and Duration.
- Produces: full-pass scans, targeted read results, explicit watched/progress mutations, and per-member non-atomic outcomes.

- [ ] **Step 1: Declare watch-state enums exactly**

```proto
enum WatchStateConsistency {
  WATCH_STATE_CONSISTENCY_UNSPECIFIED = 0;
  WATCH_STATE_CONSISTENCY_BEST_EFFORT_SCAN = 1;
}
enum ProviderActivitySemantics {
  PROVIDER_ACTIVITY_SEMANTICS_UNSPECIFIED = 0;
  PROVIDER_ACTIVITY_SEMANTICS_UNKNOWN = 1;
  PROVIDER_ACTIVITY_SEMANTICS_PLAYBACK_STARTED = 2;
  PROVIDER_ACTIVITY_SEMANTICS_PLAYBACK_COMPLETED = 3;
  PROVIDER_ACTIVITY_SEMANTICS_STATE_CHANGED = 4;
}
enum ProviderActivityReliability {
  PROVIDER_ACTIVITY_RELIABILITY_UNSPECIFIED = 0;
  PROVIDER_ACTIVITY_RELIABILITY_RELIABLE = 1;
  PROVIDER_ACTIVITY_RELIABILITY_HEURISTIC = 2;
}
enum WatchStateReadStatus {
  WATCH_STATE_READ_STATUS_UNSPECIFIED = 0;
  WATCH_STATE_READ_STATUS_FOUND = 1;
  WATCH_STATE_READ_STATUS_NOT_FOUND = 2;
  WATCH_STATE_READ_STATUS_FORBIDDEN = 3;
  WATCH_STATE_READ_STATUS_RETRYABLE_FAILURE = 4;
  WATCH_STATE_READ_STATUS_PERMANENT_FAILURE = 5;
}
enum WatchStateMutationStatus {
  WATCH_STATE_MUTATION_STATUS_UNSPECIFIED = 0;
  WATCH_STATE_MUTATION_STATUS_APPLIED = 1;
  WATCH_STATE_MUTATION_STATUS_ALREADY_APPLIED = 2;
  WATCH_STATE_MUTATION_STATUS_UNSUPPORTED = 3;
  WATCH_STATE_MUTATION_STATUS_NOT_FOUND = 4;
  WATCH_STATE_MUTATION_STATUS_FORBIDDEN = 5;
  WATCH_STATE_MUTATION_STATUS_INVALID = 6;
  WATCH_STATE_MUTATION_STATUS_RETRYABLE_FAILURE = 7;
  WATCH_STATE_MUTATION_STATUS_RETRYABLE_AMBIGUOUS = 8;
  WATCH_STATE_MUTATION_STATUS_PERMANENT_FAILURE = 9;
}
```

- [ ] **Step 2: Declare observations and read methods**

| Message | Fields in tag order |
| --- | --- |
| `ProviderActivity` | required `occurred_at`, `semantics`, `reliability` |
| `ProviderWatchState` | required `item_reference`, `watched`, optional `position`, optional `duration`, required `observed_at`, optional `provider_activity`, optional `revision` |
| `BeginWatchStateList` | `page_size` |
| `ListWatchStatesRequest` | required oneof group `scan`: `begin`, `continuation` |
| `ListWatchStatesResponse` | repeated `states`, optional `next_page_token`, `complete`, `consistency` |
| `GetWatchStatesRequest` | repeated `item_references` |
| `WatchStateReadResult` | required `item_reference`, optional `state`, `status` |
| `GetWatchStatesResponse` | repeated `results` |

Require 1–100 targeted references and preserve result order. FOUND/state agreement and non-FOUND absence are handler/plugin conformance rules.

- [ ] **Step 3: Declare explicit mutation targets and results**

| Message | Fields in tag order |
| --- | --- |
| `SetWatched` | `watched` |
| `SetProgress` | `watched`, required `position`, optional `duration` |
| `WatchStateMutation` | `mutation_id`, required `item_reference`, required oneof group `target`: `set_watched`, `set_progress` |
| `WatchStateMutationResult` | `mutation_id`, optional `observed_state`, `status` |
| `PushWatchStatesRequest` | `batch_id`, repeated `mutations` |
| `PushWatchStatesResponse` | repeated `results` |

Cap mutations/results at 100. Do not add toggle, play count, percentage, last-played setter, atomic flag, checkpoint, or provider idempotency claim.

- [ ] **Step 4: Declare the WatchStateService inventory**

```proto
service WatchStateService {
  rpc ListWatchStates(ListWatchStatesRequest) returns (ListWatchStatesResponse);
  rpc GetWatchStates(GetWatchStatesRequest) returns (GetWatchStatesResponse);
  rpc PushWatchStates(PushWatchStatesRequest) returns (PushWatchStatesResponse);
}
```

- [ ] **Step 5: Generate the private watch-state client**

Run: `mise run generate`

- [ ] **Step 6: Run the private watch-state schema and application checks**

Run:

```bash
mise run check:contracts
mise run check:ts
```

Expected: PASS.

- [ ] **Step 7: Commit the private watch-state contract**

```bash
git add proto/nama/plugin/v1/watch_state.proto plugins/jellyfin/src/contract-probe.ts gen/ts
git commit -m "feat(plugin): add watch state contract"
```

### Task 5: Close Milestone 0 conformance and documentation drift

**Files:**

- Modify: `apps/server/package.json`
- Modify: `apps/server/src/contract.test.ts`
- Modify: `apps/server/src/contract-authorization.ts`
- Modify: `apps/server/src/contract-probe.ts`
- Create: `apps/server/src/contract-errors.ts`
- Modify: `plugins/jellyfin/src/contract-probe.ts`
- Modify: `pnpm-lock.yaml`
- Modify: `docs/architecture.md`
- Modify: `docs/release-plan.md`
- Modify: `docs/architecture/core-server.md`
- Verify: `mise.toml`
- Verify: `.github/workflows/ci.yml`

**Interfaces:**

- Consumes: every generated public/plugin method descriptor, both package-local `PlaybackPreferences` schemas, validation violations, and the real application probes.
- Produces: complete handwritten authorization policy, executable CEL evidence, deterministic field-error normalization, source-level boundary evidence, reconciled companion summaries, and a demonstrated breaking gate.

- [ ] **Step 1: Add every private method to the authorization table**

Add `"plugin-bearer"` to `ContractAuthority` and enter every generated plugin method in `contractAuthorityByMethod`.

- [ ] **Step 2: Prove handwritten authorization completeness**

Use generated public and plugin method descriptors only as inputs to the existing comparison. Assert that every generated method key appears exactly once in `contractAuthorityByMethod`, every plugin key maps to `plugin-bearer`, and no handwritten key is stale. Do not assert generated RPC counts, descriptor construction, package names, symbols, reservations, or Health descriptor snapshots.

- [ ] **Step 3: Add the direct validation runtime**

Before importing `createValidator`, add the exact direct server dev dependency:

```bash
pnpm --filter @nama/server add --save-dev --save-exact @bufbuild/protovalidate@1.2.0
```

The application owns this dependency because the handwritten contract test executes validation. Do not add it to Go or Swift.

- [ ] **Step 4: Execute the CAPPED bit-rate invariant in both packages**

Import `PlaybackPreferencesSchema`, `PlaybackQuality`, and `SubtitlePreference` from both generated playback modules with `Public` and `Plugin` aliases. Use one `createValidator()` instance and assert all seven cases against each package-local schema, without serializing any message:

```ts
const validator = createValidator();

for (const { schema, capped, automatic, original, subtitleAuto } of [
  {
    schema: PublicPlaybackPreferencesSchema,
    capped: PublicPlaybackQuality.CAPPED,
    automatic: PublicPlaybackQuality.AUTO,
    original: PublicPlaybackQuality.ORIGINAL,
    subtitleAuto: PublicSubtitlePreference.AUTO,
  },
  {
    schema: PluginPlaybackPreferencesSchema,
    capped: PluginPlaybackQuality.CAPPED,
    automatic: PluginPlaybackQuality.AUTO,
    original: PluginPlaybackQuality.ORIGINAL,
    subtitleAuto: PluginSubtitlePreference.AUTO,
  },
]) {
  assert.equal(
    validator.validate(
      schema,
      create(schema, { quality: capped, maxBitRateBps: 1n, subtitlePreference: subtitleAuto }),
    ).kind,
    "valid",
  );
  assert.equal(
    validator.validate(schema, create(schema, { quality: capped, subtitlePreference: subtitleAuto })).kind,
    "invalid",
  );
  assert.equal(
    validator.validate(
      schema,
      create(schema, { quality: capped, maxBitRateBps: 0n, subtitlePreference: subtitleAuto }),
    ).kind,
    "invalid",
  );
  assert.equal(
    validator.validate(
      schema,
      create(schema, { quality: automatic, maxBitRateBps: 1n, subtitlePreference: subtitleAuto }),
    ).kind,
    "invalid",
  );
  assert.equal(
    validator.validate(
      schema,
      create(schema, { quality: original, maxBitRateBps: 1n, subtitlePreference: subtitleAuto }),
    ).kind,
    "invalid",
  );
  assert.equal(
    validator.validate(
      schema,
      create(schema, { quality: automatic, subtitlePreference: subtitleAuto }),
    ).kind,
    "valid",
  );
  assert.equal(
    validator.validate(
      schema,
      create(schema, { quality: original, subtitlePreference: subtitleAuto }),
    ).kind,
    "valid",
  );
}
```

This is the executable proof for the only custom CEL rule; no generated serialization assertion or hand-built `BadRequest` substitutes for it.

- [ ] **Step 5: Implement deterministic field-error normalization**

Create `apps/server/src/contract-errors.ts` exporting:

```ts
export type ContractFieldErrorInput = Readonly<{
  field: string;
  reason: string;
  description: string;
  localizedMessage?: Readonly<{ locale: string; message: string }>;
}>;

export type ContractFieldError = {
  field: string;
  reason: string;
  description: string;
  localizedMessage?: { locale: string; message: string };
};

export function normalizeContractFieldErrors(
  violations: readonly ContractFieldErrorInput[],
): ContractFieldError[];
```

Sort a copy by `field`, then `reason`, then `description`, comparing strings with JavaScript code-unit `<`/`>` comparisons rather than locale-aware sorting. Take the first 50 results, copy only those four fields, and deep-copy `localizedMessage` when present. Never mutate the input or pass through provider/private metadata.

- [ ] **Step 6: Test field-error ordering, copying, and cap**

Supply these six approved violations to `normalizeContractFieldErrors` in reverse order and assert the exact sorted result:

| Field | Reason | Description | Localized fallback |
| --- | --- | --- | --- |
| `clear_configuration_fields[0]` | `CONFLICT` | `cannot clear a field also present in configuration_patch` | absent |
| `configuration.api_key` | `REQUIRED` | `required by the selected provider schema` | absent |
| `configuration.base_url` | `INVALID_FORMAT` | `must be an absolute HTTP or HTTPS URL` | locale `en`, message `Enter a valid server URL.` |
| `configuration_patch.api_key` | `CONFLICT` | `cannot set a field also present in clear_configuration_fields` | absent |
| `max_bit_rate_bps` | `MISMATCH` | `must be positive when quality is CAPPED` | absent |
| `quality` | `MISMATCH` | `must omit max_bit_rate_bps unless quality is CAPPED` | absent |

Also pass 51 distinct reverse-ordered violations and assert that the result is sorted, contains exactly 50 entries, and omits the final entry after sorting. Confirm the returned objects and localized fallback are copies containing no field beyond `field`, `reason`, `description`, and optional `localizedMessage`.

- [ ] **Step 7: Keep adapter tests on handwritten behavior only**

Add or retain an adapter test only when an actual handwritten adapter's mapping, filtering, redaction, or fallback is the subject. Generated transport values may be inputs, but do not add a representative-message fixture before such an adapter exists.

- [ ] **Step 8: Reconcile the provider boundary summary**

In `docs/architecture.md`, replace the unqualified provider-boundary invariant with wording that remote provider resource IDs/errors/SDK types and provider-specific consumer shapes stop at the plugin, while installed provider type IDs and schema-driven configuration are authenticated Nama management resources. Do not duplicate the full API specification.

- [ ] **Step 9: Reconcile the deferred provider-user mapping summary**

In `docs/release-plan.md`, clarify that deferred provider-user mapping means mapping multiple Nama users to provider users; the immutable single provider principal configured for an MVP instance is not deferred. Do not expand the milestone scope.

- [ ] **Step 10: Reconcile request authentication/validation ordering**

In `docs/architecture/core-server.md`, order public request processing as request/correlation assignment first, authentication of protected methods second, then field validation/handler work, so unauthenticated callers receive no validation oracle. Do not duplicate the full API specification.

- [ ] **Step 11: Review source-level package and sensitive boundaries**

Run and review these source searches:

```bash
if rg -n 'nama/plugin/v1' gen/go gen/swift; then
  printf '%s\n' 'unexpected private contract in a public generated client' >&2
  exit 1
else
  search_status=$?
  test "$search_status" -eq 1
fi
if rg -n -i 'jellyfin|plex|provider_item|provider_source|stream_index|file_path|session_context' proto/nama/api; then
  printf '%s\n' 'unexpected provider-private symbol in public contract' >&2
  exit 1
else
  search_status=$?
  test "$search_status" -eq 1
fi
rg -n 'password|token|credential|url|headers|session_context|google\.protobuf\.Struct' proto/nama
```

Expected: package-isolation and public-boundary searches have no matches. Review every sensitive-surface match against the approved contract ownership; do not replace this source review with descriptor snapshots.

- [ ] **Step 12: Format the completed handwritten contract files**

Run: `mise run format`

- [ ] **Step 13: Run the complete repository verification**

Run:

```bash
mise run check:contracts
mise run check:ts
mise run check:go
mise run check:swift
mise run check:docker
mise run check
git diff --check
```

Expected: every command PASS. If the machine lacks the pinned Xcode, stop and use the existing macOS CI result; do not weaken the Swift check.

- [ ] **Step 14: Commit the complete contract baseline**

```bash
git add apps/server/package.json apps/server/src/contract.test.ts apps/server/src/contract-authorization.ts apps/server/src/contract-errors.ts apps/server/src/contract-probe.ts plugins/jellyfin/src/contract-probe.ts pnpm-lock.yaml docs/architecture.md docs/release-plan.md docs/architecture/core-server.md
git commit -m "feat(api): complete milestone 0 contracts"
```

- [ ] **Step 15: Prove one real breaking change is rejected**

After the complete baseline commit, run this single validation shell. It creates a unique module, patches only the copy, captures the expected failure, and removes the temporary directory on every shell exit:

```bash
set -eu
proof_dir="$(mktemp -d "${TMPDIR:-/tmp}/nama-m0-breaking-proof.XXXXXX")"
test -n "$proof_dir"
test -d "$proof_dir"
test ! -L "$proof_dir"
cleanup_proof() {
  test -n "$proof_dir"
  test -d "$proof_dir"
  test ! -L "$proof_dir"
  rm -rf -- "$proof_dir"
}
trap cleanup_proof EXIT
cp buf.yaml buf.lock "$proof_dir/"
cp -R proto "$proof_dir/proto"
(
  cd "$proof_dir"
 apply_patch <<'PATCH'
*** Begin Patch
*** Update File: proto/nama/api/v1/health.proto
@@
 message CheckResponse {
-  ServingStatus status = 1 [(buf.validate.field).enum = {
-    not_in: [0]
-  }];
   string server_version = 2;
*** End Patch
PATCH
)
breaking_output="$proof_dir/breaking.txt"
if (cd "$proof_dir" && buf breaking proto --against "/Users/omid/Code/Personal/nama/.git#ref=HEAD,subdir=proto") >"$breaking_output" 2>&1; then
  printf '%s\n' 'expected buf breaking to reject removal of CheckResponse.status' >&2
  exit 1
fi
rg -n 'CheckResponse|status|field.*1' "$breaking_output"
```

Expected: the breaking command fails and the captured output identifies removal of `CheckResponse.status` field 1. The validated `mktemp` directory is the only recursive cleanup target. Leave repository schemas untouched. Record the failure summary in the task report; no permanent proof script is needed because CI runs the real base comparison.

- [ ] **Step 16: Verify a clean deterministic rerun**

Run:

```bash
mise run generate
mise run check
git status --short
```

Expected: generation is a no-op, all checks PASS, and the working tree is clean.

## Milestone 0 Completion Gate

Milestone 0 is complete only when:

- all 18 source schema files exist: 11 public and 7 plugin;
- every generated public and plugin RPC has exactly one handwritten default-deny authorization entry;
- the real TypeScript server/plugin, Go CLI, and tvOS applications compile their generated clients;
- generated code is committed and deterministic;
- source-level package and provider-private boundary reviews pass;
- the package-local CAPPED CEL rule passes all seven valid/invalid cases in both packages;
- the handwritten field-error normalizer proves deterministic ordering, safe copying, and the 50-entry cap;
- the PR-base breaking gate is present and a deliberate removal has failed locally; and
- no handler, persistence, provider client, fake server, CLI behavior, or tvOS product behavior was added.
