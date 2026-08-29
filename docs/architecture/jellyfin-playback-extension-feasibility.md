# Jellyfin playback server extension feasibility (Jellyfin 10.11.11)

Status: accepted architecture direction under [ADR-0035](../adr/0035-first-party-jellyfin-server-extension.md) and [issue #231](https://github.com/electather/nama/issues/231); implementation and release evidence remain incomplete.

## Verdict

**Still plausible/unproved after an exact Jellyfin 10.11.11 runtime spike.**

**[FACT]** The spike compiled, loaded, registered an `IStartupFilter`, and
enforced a test HMAC lease before stock `CustomAuthentication` on progressive,
Dynamic HLS, and direct-subtitle routes. It also constructed the exact-tag
`StreamBuilder` and read `StreamInfo` at runtime. **[FACT]** It found a
blocking coverage gap: the stock HLS-subtitle playlist emitted the configured
broad `ApiKey` in a child URI after the guard's in-process header replacement.
The spike did not rewrite response bodies into scoped child leases, and it did
not establish complete legacy/encrypted-HLS/plan-action/telemetry coverage.

The technical mechanism is real for the tested routes and supports the accepted
server-extension direction. It does **not** authorize capability advertisement:
full media graph coverage, response-side token removal where Jellyfin generates
tokenized children, negotiation, telemetry ambiguity, and version-coupled
operating constraints remain release-blocking.

This record does not create a broad-token exception. Nama still rejects
`PROVIDER_ACCOUNT`; a public lease must be `SESSION` or sufficiently constrained
`MEDIA_ITEM` ([private schema](../../proto/nama/plugin/v1/playback.proto#L77-L82),
[contract](api-contracts.md#plugin-playbackservice)).

## Accepted direction

Nama will publish an exact-versioned first-party .NET extension artifact for
manual installation into Jellyfin. The extension validates its own host and
exposes one bounded private JSON/HTTP protocol to Nama's existing Jellyfin
provider plugin; Nama checks only the extension protocol and capabilities.
Missing, unhealthy, or incompatible extensions add no playback or coherent-
progress capabilities.

The extension owns a purpose-separated ASP.NET Data Protection key ring in
stable Jellyfin program data and mints five-minute plans plus scoped session
leases lasting the complete expected runtime plus 30 minutes, capped at
24 hours. Public locators contain an opaque extension URL and scoped request
header. The extension rewrites bounded media-control documents so stock paths,
provider identifiers, and reusable credentials do not escape. Stock Jellyfin
routes remain unchanged; Nama's guarantee covers only access conferred through
the extension namespace.

Jellyfin registers plugin services before host construction
([plugin registration](https://github.com/jellyfin/jellyfin/blob/v10.11.11/Emby.Server.Implementations/Plugins/PluginManager.cs#L203-L227)),
so the extension can explicitly register the .NET Data Protection services and
persist a purpose-bound ring
([purpose separation](https://github.com/dotnet/aspnetcore/blob/v9.0.0/src/DataProtection/Abstractions/src/IDataProtectionProvider.cs#L8-L24),
[file persistence](https://github.com/dotnet/aspnetcore/blob/v9.0.0/src/DataProtection/DataProtection/src/DataProtectionBuilderExtensions.cs#L168-L188)).
Jellyfin's supported `IUserDataManager` saves one `UserItemData` target
([interface](https://github.com/jellyfin/jellyfin/blob/v10.11.11/MediaBrowser.Controller/Library/IUserDataManager.cs#L15-L78))
inside one database transaction
([implementation](https://github.com/jellyfin/jellyfin/blob/v10.11.11/Emby.Server.Implementations/Library/UserDataManager.cs#L50-L92)).
Watched state and position therefore commit together; duration remains current
item metadata and is validated before the write. A separate readback proves the
observed target, while a lost or conflicting result remains ambiguous because
Jellyfin exposes no revision, compare-and-swap, or idempotency key.

Umbrella issue #231 owns the accepted boundary. Issue #232 is the
runtime/direct-progressive tracer, issue #233 completes HLS, negotiation, and
Track delivery, and issue #234 implements coherent progress. They supersede
issues #96 and #97.

## Scope and Nama constraints

A **Jellyfin server extension** means a component installed in the Jellyfin
server process. It is distinct from Nama's existing supervised subprocess, the
**Jellyfin provider plugin**. The core owns all durable state, credentials,
restarts, and provider-plugin lifecycle; a provider plugin may be replaced while
an active session retains opaque context ([plugin boundary](plugin-system.md),
[plugin session context](api-contracts.md#plugin-playbackservice)). Nama remains
a control plane: ordinary media bytes must go directly between the provider and
client, locators must be short-lived and narrowly scoped, and reusable provider
credentials must not reach the client ([architecture](../architecture.md),
[ADR-0013](../adr/0013-origin-scoped-short-lived-locators.md),
[issue #231](https://github.com/electather/nama/issues/231)).

The public lifecycle is side-effect-free plan, idempotent open, ordered report,
and idempotent close. Core state commits before provider telemetry; an ambiguous
provider mutation must not be replayed ([lifecycle contract](api-contracts.md#playbackservice),
[ADR-0014](../adr/0014-four-stage-playback-lifecycle.md)). Those rules, and the
terms *locator*, *playback plan*, and *playback session*, are authoritative here
([context](../../CONTEXT.md#language)).

## What Jellyfin 10.11.11 proves

### Registration, controllers, and pipeline order

| Question | Evidence and finding |
| --- | --- |
| Can a Jellyfin server extension register services? | **Yes.** `IPluginServiceRegistrator.RegisterServices(IServiceCollection, IServerApplicationHost)` is the plugin contract; `ApplicationHost.Init` calls the host registration and then `PluginManager.RegisterServices` before the web host's `Startup.ConfigureServices` runs ([plugin interface](https://github.com/jellyfin/jellyfin/blob/v10.11.11/MediaBrowser.Controller/Plugins/IPluginServiceRegistrator.cs#L7-L21), [invocation](https://github.com/jellyfin/jellyfin/blob/v10.11.11/Emby.Server.Implementations/Plugins/PluginManager.cs#L172-L213), [order](https://github.com/jellyfin/jellyfin/blob/v10.11.11/Emby.Server.Implementations/ApplicationHost.cs#L428-L456)). |
| Can it add a controller? | **Yes.** Jellyfin discovers controller-derived plugin assemblies, clears MVC application parts, then explicitly adds the core and plugin parts before mapping controllers ([controller discovery](https://github.com/jellyfin/jellyfin/blob/v10.11.11/Emby.Server.Implementations/ApplicationHost.cs#L950-L961), [MVC registration](https://github.com/jellyfin/jellyfin/blob/v10.11.11/Jellyfin.Server/Extensions/ApiServiceCollectionExtensions.cs#L117-L171), [endpoint map](https://github.com/jellyfin/jellyfin/blob/v10.11.11/Jellyfin.Server/Startup.cs#L185-L197)). A new controller is additive; it does not replace a selected core action. |
| What is the stock order? | Jellyfin registers its MVC API, its `CustomAuthentication` scheme, and Jellyfin authorization policies. Its mapped branch then calls `UseAuthentication`, `UseRouting`, `UseAuthorization`, and `UseEndpoints(MapControllers)` in that order ([service registration](https://github.com/jellyfin/jellyfin/blob/v10.11.11/Jellyfin.Server/Startup.cs#L66-L79), [pipeline](https://github.com/jellyfin/jellyfin/blob/v10.11.11/Jellyfin.Server/Startup.cs#L124-L197)). |
| Can it install middleware before stock authentication? | **Technically yes, not a Jellyfin-guaranteed extension surface.** The raw service collection can register ASP.NET Core `IStartupFilter`. That interface explicitly extends the pipeline at its beginning or end; the .NET 9 host reverses filters, wraps `Startup.Configure`, invokes the wrapper, then builds the request delegate ([ASP.NET `IStartupFilter`](https://github.com/dotnet/aspnetcore/blob/v9.0.11/src/Hosting/Abstractions/src/IStartupFilter.cs#L7-L21), [hosting order](https://github.com/dotnet/aspnetcore/blob/v9.0.11/src/Hosting/Hosting/src/Internal/WebHost.cs#L228-L243)). A filter that adds middleware before invoking `next` therefore precedes Jellyfin's `UseAuthentication`. Jellyfin 10.11.11 targets `net9.0` ([project](https://github.com/jellyfin/jellyfin/blob/v10.11.11/Jellyfin.Server/Jellyfin.Server.csproj#L10-L17)). **[INFERENCE]** This works at that exact composition point but is an ASP.NET hosting hook reached through plugin DI, not a documented promise that Jellyfin will preserve this extension behavior. |

A custom authentication scheme, authorization handler/policy, `IStartupFilter`,
or `IConfigureOptions<MvcOptions>` global filter/convention can be registered
through the raw service collection. ASP.NET Core exposes MVC conventions and
filters, but Jellyfin later configures its own `CustomAuthentication` default
scheme and policies; its default policy explicitly names that scheme
([Jellyfin auth setup](https://github.com/jellyfin/jellyfin/blob/v10.11.11/Jellyfin.Server/Extensions/ApiServiceCollectionExtensions.cs#L55-L115),
[ASP authentication registration](https://github.com/dotnet/aspnetcore/blob/v9.0.11/src/Security/Authentication/Core/src/AuthenticationServiceCollectionExtensions.cs#L14-L65),
[MVC options](https://github.com/dotnet/aspnetcore/blob/v9.0.11/src/Mvc/Mvc.Core/src/MvcOptions.cs#L20-L72)). Thus custom scheme/policy registration is technically possible but not a
safe replacement for stock authorization by itself.

`UseAuthorization` consumes selected-endpoint authorization metadata and can
short-circuit before MVC. A new controller's filters never execute for an
already-selected core controller ([ASP authorization middleware](https://github.com/dotnet/aspnetcore/blob/v9.0.11/src/Security/Authorization/Policy/src/AuthorizationMiddleware.cs#L80-L170)). A global MVC authorization filter or convention might deny an eventual
core MVC action, but it runs too late to make a lease visible to the earlier
stock authentication step and is not proof of coverage for every core endpoint.
Controller-only is therefore insufficient.

### Stock credentials and stock routes

Jellyfin's custom handler authenticates through `IAuthService` and turns its
result into a `ClaimsPrincipal`; it does not know a Nama item-/route-/expiry-
scoped lease ([handler](https://github.com/jellyfin/jellyfin/blob/v10.11.11/Jellyfin.Api/Auth/CustomAuthenticationHandler.cs#L38-L81)). The authorization
context parses a `MediaBrowser` `Authorization` header, legacy token headers,
or `ApiKey`/`api_key` query values, then looks the token up as a device access
token or API-key access token ([parser](https://github.com/jellyfin/jellyfin/blob/v10.11.11/Jellyfin.Server.Implementations/Security/AuthorizationContext.cs#L226-L279),
[lookup](https://github.com/jellyfin/jellyfin/blob/v10.11.11/Jellyfin.Server.Implementations/Security/AuthorizationContext.cs#L89-L205)). There is no
item, media-source, route-class, or expiry constraint in that lookup. An API key
is treated as an administrator role by the custom handler
([role assignment](https://github.com/jellyfin/jellyfin/blob/v10.11.11/Jellyfin.Api/Auth/CustomAuthenticationHandler.cs#L46-L73)).

The relevant controller action set is heterogeneous:

- Video and audio progressive `GET`/`HEAD` routes have no controller-level
  authorization attribute ([video](https://github.com/jellyfin/jellyfin/blob/v10.11.11/Jellyfin.Api/Controllers/VideosController.cs#L312-L314),
  [audio](https://github.com/jellyfin/jellyfin/blob/v10.11.11/Jellyfin.Api/Controllers/AudioController.cs#L89-L91)).
- `DynamicHlsController` is `[Authorize]` and owns video/audio master and main
  playlists plus `hls1` child segments
  ([controller and routes](https://github.com/jellyfin/jellyfin/blob/v10.11.11/Jellyfin.Api/Controllers/DynamicHlsController.cs#L39-L41),
  [video children](https://github.com/jellyfin/jellyfin/blob/v10.11.11/Jellyfin.Api/Controllers/DynamicHlsController.cs#L755-L1102),
  [audio children](https://github.com/jellyfin/jellyfin/blob/v10.11.11/Jellyfin.Api/Controllers/DynamicHlsController.cs#L927-L1287)).
- The legacy video HLS playlist is `[Authorize]`, but legacy video and audio
  segment actions deliberately have their authentication attribute commented
  out because Chrome requests may lack the full query string
  ([legacy routes](https://github.com/jellyfin/jellyfin/blob/v10.11.11/Jellyfin.Api/Controllers/HlsSegmentController.cs#L50-L145)).
- Direct subtitle stream routes lack a local authorization attribute while the
  HLS subtitle playlist is `[Authorize]`
  ([subtitle routes](https://github.com/jellyfin/jellyfin/blob/v10.11.11/Jellyfin.Api/Controllers/SubtitleController.cs#L208-L339)).

There is no separate media-key controller action in this tag's controller
catalog. That is not permission to omit key handling: an `EXT-X-KEY` URI, if
emitted for a fixture, is a playlist child request and must be treated as a
lease-bound HLS-key route class. The actual emitted URI set needs the runtime
spike below.

## Could an outer lease guard be secure?

### The mechanically plausible portion

Before `UseAuthentication`, middleware can read and change `HttpRequest.Headers`:
ASP.NET exposes an `IHeaderDictionary` whose indexer has a setter
([request](https://github.com/dotnet/aspnetcore/blob/v9.0.11/src/Http/Http.Abstractions/src/HttpRequest.cs#L67-L73),
[header dictionary](https://github.com/dotnet/aspnetcore/blob/v9.0.11/src/Http/Http.Features/src/IHeaderDictionary.cs#L7-L21)). Therefore, **[INFERENCE]** an outer middleware could verify a
self-contained, short-lived lease against the request method/path/query and,
only after that check, replace the inbound authorization value with a correctly
formatted `MediaBrowser Token="…"` value. The configured Jellyfin token would
then be consumed only by the in-process custom handler before the request
reaches the controller; it need not be in a public locator URL, response header,
or redirect. The client-supplied lease header must be removed or ignored before
any later response/header copying.

For this to preserve Nama's scope, the verifier would have to reject rather than
normalize a wrong server instance, expiry, HTTP method, item, media source,
play-session correlation, route class, or child identity. A generic valid
Jellyfin credential is insufficient because the stock token lookup has no such
claims. This is a required property, not an established Jellyfin API feature.

### The unproved and conflicting portion

The filter runs **before** `UseRouting`; it has the raw request path, not the
endpoint selected by routing. Its simple before-`next` placement cannot insert
middleware between Jellyfin's later `UseRouting` and `UseAuthorization` without
changing the host's `Startup.Configure` ([Jellyfin pipeline](https://github.com/jellyfin/jellyfin/blob/v10.11.11/Jellyfin.Server/Startup.cs#L124-L197),
[filter composition](https://github.com/dotnet/aspnetcore/blob/v9.0.11/src/Hosting/Hosting/src/Internal/WebHost.cs#L228-L243)). **[INFERENCE]** A verifier can parse and
strictly match every current route template itself, but no source proves that
this remains complete for generated playlist children, URL encoding/base paths,
new routes, or future Jellyfin versions.

The legacy anonymous segments make the compatibility conflict concrete. A guard
that rejects every media request without a scoped lease closes those existing
routes but breaks their documented-in-source compatibility case. A guard that
allows them preserves ordinary clients but fails the proposition that *every*
media byte route requires a scoped lease. Passing requests with a normal
Jellyfin credential can preserve authenticated non-Nama clients, but cannot
help headerless legacy children. The sources do not prove a mode that both
blocks all non-lease playback access and leaves all pre-existing Jellyfin
clients unchanged. This alone requires the spike; it must not be assumed away.

A global authorization MVC filter/convention can be investigated as a defense
in depth for MVC actions, but cannot supply endpoint matching to the early
header mutation and cannot make a controller-only extension own the legacy
segment delegate. Replacing Jellyfin's custom scheme/default policy would risk
changing the authentication semantics of unrelated Jellyfin APIs and clients.
No such replacement is supported by the Jellyfin plugin contract.

## NamaPlayer bridge and locator graph

The player does not receive provider headers directly. NamaPlayer registers both
the main media locator and each external-subtitle locator with a per-load
loopback bridge ([bridge preparation](../../apps/ios/Nama/Playback/NamaPlaybackHTTPBridge.swift#L130-L147)); upstream requests explicitly apply the stored resource headers
([header application](../../apps/ios/Nama/Playback/NamaPlaybackBridgeRequest+Playlist.swift#L21-L25),
[request creation](../../apps/ios/Nama/Playback/NamaPlaybackBridgeRequest.swift#L49-L57)).
For HLS, the bridge rewrites ordinary URI lines and URI attributes to new local
resources carrying the same header set and expiry
([playlist rewrite](../../apps/ios/Nama/Playback/NamaPlaybackBridgeRequest+Playlist.swift#L95-L166)). This is also the architectural boundary: the engine gets opaque
loopback locators without upstream headers; the bridge validates destinations,
rewrites HLS children, and reapplies headers only within the allowed origin set
([playback architecture](playback.md#playback)).

Accordingly, the extension's scoped lease must work on the main progressive or
playlist request, every rewritten HLS playlist/segment/key child, and every
external-subtitle locator. It must not assume an upstream media engine will
propagate a main-request header. The lease and redirect/header rules for an
external subtitle are independently required by the private contract
([private external locator](../../proto/nama/plugin/v1/playback.proto#L297-L323),
[contract](api-contracts.md#plugin-playbackservice)).

## Negotiation evidence

### What the public Jellyfin API supplies

`POST /Items/{itemId}/PlaybackInfo` accepts a Jellyfin `PlaybackInfoDto`, chosen
media source/indexes, and direct-play/direct-stream/transcoding switches, then
calls Jellyfin's device-specific negotiation
([endpoint](https://github.com/jellyfin/jellyfin/blob/v10.11.11/Jellyfin.Api/Controllers/MediaInfoController.cs#L137-L266)). Its response gives media
sources and a `PlaySessionId` ([response DTO](https://github.com/jellyfin/jellyfin/blob/v10.11.11/MediaBrowser.Model/MediaInfo/PlaybackInfoResponse.cs#L11-L37)).
`MediaSourceInfo` exposes media streams, direct/transcode support, a transcoding
URL/subprotocol/container, and selected default stream indexes, but marks
`TranscodeReasons` `JsonIgnore`
([DTO](https://github.com/jellyfin/jellyfin/blob/v10.11.11/MediaBrowser.Model/Dto/MediaSourceInfo.cs#L14-L125)).

That public response cannot be used as a safe Nama locator: Jellyfin's own
negotiation calls `StreamInfo.ToUrl` with the current claim token, and `ToUrl`
adds it as `ApiKey` to the query. It does likewise for generated external
subtitle URLs ([negotiation](https://github.com/jellyfin/jellyfin/blob/v10.11.11/Jellyfin.Api/Helpers/MediaInfoHelper.cs#L278-L334),
[URL generation](https://github.com/jellyfin/jellyfin/blob/v10.11.11/MediaBrowser.Model/Dlna/StreamInfo.cs#L882-L1046),
[subtitle generation](https://github.com/jellyfin/jellyfin/blob/v10.11.11/MediaBrowser.Model/Dlna/StreamInfo.cs#L1155-L1260)).

It also does not directly declare Nama's required strategy, per-track action,
or `switchable_without_reopen`. Therefore public DTOs alone are **not proven**
to furnish truthful `PluginPlaybackPlan` fields. Guessing from codecs or from a
URL is forbidden by [issue #233](https://github.com/electather/nama/issues/233)
and the plan contract ([private plan schema](../../proto/nama/plugin/v1/playback.proto#L234-L290),
[public semantics](api-contracts.md#planplayback)).

### Internal exact-tag possibility and its boundary

At this tag, `MediaInfoHelper` itself constructs a `StreamBuilder`, asks it for
the optimal audio/video `StreamInfo`, records the selected stream indices,
play method/subprotocol, transcode reasons, and subtitle profiles
([helper](https://github.com/jellyfin/jellyfin/blob/v10.11.11/Jellyfin.Api/Helpers/MediaInfoHelper.cs#L170-L334),
[subtitle copy-out](https://github.com/jellyfin/jellyfin/blob/v10.11.11/Jellyfin.Api/Helpers/MediaInfoHelper.cs#L470-L490)). `StreamBuilder` and
`StreamInfo` are public concrete classes in Jellyfin assemblies and expose the
chosen play method, subtitle delivery method, transcode reasons, optimal stream
methods, and a profile method that can enumerate non-selected subtitles
([builder](https://github.com/jellyfin/jellyfin/blob/v10.11.11/MediaBrowser.Model/Dlna/StreamBuilder.cs#L19-L65),
[stream result](https://github.com/jellyfin/jellyfin/blob/v10.11.11/MediaBrowser.Model/Dlna/StreamInfo.cs#L22-L270),
[subtitle profiles](https://github.com/jellyfin/jellyfin/blob/v10.11.11/MediaBrowser.Model/Dlna/StreamInfo.cs#L1155-L1260)). `IMediaEncoder` is registered by Jellyfin and implements the
`ITranscoderSupport` needed by that builder
([interface](https://github.com/jellyfin/jellyfin/blob/v10.11.11/MediaBrowser.Controller/MediaEncoding/IMediaEncoder.cs#L15-L24)).

**[INFERENCE]** A Jellyfin server extension compiled exactly against 10.11.11
could invoke the same negotiation classes rather than independently inventing
compatibility. This is version-coupled use of internal server composition, not
a documented provider-plugin negotiation API. The evidence still does not say
that invoking it for every Nama source/track choice is side-effect-free, gives a
one-to-one `COPY`/`TRANSCODE`/`BURN`/`EXTERNAL`/`OMIT` action for every track, or
permits a selected stream to switch without a new URI/transcode. Until those are
measured, the only truthful switchability value is conservatively `false`.

## Lifecycle, telemetry, restarts, and secrets

A self-contained lease can avoid dependence on a particular Jellyfin provider
plugin process only if its verifier has stable verification material and every
later report/close request receives the retained private `session_context`. The
Nama core already retains that context across process replacement and never
exposes it publicly ([contract](api-contracts.md#plugin-playbackservice)).
**[INFERENCE]** A server extension can likewise verify a cryptographic lease
after a provider-plugin replacement, provided its key material and configured
Jellyfin credential survive there. This says nothing about whether the underlying
Jellyfin stream/transcode or session survives a Jellyfin restart.

A Jellyfin restart creates a new `SessionManager` with in-memory active
connection/live-stream dictionaries
([manager state](https://github.com/jellyfin/jellyfin/blob/v10.11.11/Emby.Server.Implementations/Session/SessionManager.cs#L39-L127)). **[INFERENCE]** Existing
play-session/transcoding resources can therefore disappear even while a
cryptographically valid lease has not expired. The safe observable result is a
failed media/report/close operation and bounded Nama cleanup, never a claimed
remote release. A server extension restart must be treated the same way until a
spike proves a recovery behavior.

Jellyfin's standard playback routes are real user-state writers: start increments
play count and writes user data; progress updates position and writes user data;
stop updates played/progress, kills an associated transcode, and writes user
data ([routes](https://github.com/jellyfin/jellyfin/blob/v10.11.11/Jellyfin.Api/Controllers/PlaystateController.cs#L199-L260),
[effects](https://github.com/jellyfin/jellyfin/blob/v10.11.11/Emby.Server.Implementations/Session/SessionManager.cs#L746-L960),
[stop effects](https://github.com/jellyfin/jellyfin/blob/v10.11.11/Emby.Server.Implementations/Session/SessionManager.cs#L1012-L1139)). The `PlaybackProgressInfo` DTO has
no Nama event ID or equivalent provider idempotency field
([DTO](https://github.com/jellyfin/jellyfin/blob/v10.11.11/MediaBrowser.Model/Session/PlaybackProgressInfo.cs#L11-L120)). A lost `204` response is therefore
an ambiguous side effect that cannot be safely replayed.

Consequences for Nama are exact: the core may only advertise
`PLAYBACK_REPORTS_USER_STATE` if this telemetry path is the sole provider-side
writer for that same local event; it must not also enqueue `PushWatchStates`
([sole-writer rule](api-contracts.md#plugin-playbackservice)). Report/close can
be sent once and their uncertain result retained diagnostically, but neither
standard Jellyfin telemetry nor the source inspection proves safe retry,
provider-side idempotency, or post-restart cleanup. That is compatible with
Nama's "commit locally first; never replay ambiguous provider mutation" rule,
not proof that the capability is ready.

The Jellyfin server extension necessarily holds both the configured broad
Jellyfin credential used only for in-process stock authorization and lease
verification material. Jellyfin's conventional plugin configuration is an XML
file under the plugin configurations directory, serialized by `BasePlugin<T>`;
this source establishes no encrypted secret store
([persistence](https://github.com/jellyfin/jellyfin/blob/v10.11.11/MediaBrowser.Common/Plugins/BasePluginOfT.cs#L86-L172)). Jellyfin's official documentation says
manual plugins are placed in the server plugin directory and become visible
after a server restart, while configuration XML is retained separately
([official plugin documentation](https://jellyfin.org/docs/general/server/plugins/#manual)).

Thus installation, filesystem permissions, secret provisioning, replacement,
rotation overlap, revocation, rollback, and exact Jellyfin/plugin version
compatibility are deployment requirements. Rotation must fail closed for unknown
or retired verification material; removing it invalidates outstanding leases.
A compromise of the broad credential or lease-signing authority is a security
incident, not a reason to return that credential to a client. This record does
not select a key format, transport, installer, or rotation protocol.

## Exact 10.11.11 runtime spike

This disposable experiment used only `/tmp/nama-jellyfin-extension-spike` and
the pinned server image from
`apps/server/integration/tests/compose.yaml`:
`jellyfin/jellyfin:10.11.11@sha256:aefb67e6a7ff1debdd154a78a7bbb780fd0c873d8639210a7f6a2016ad2b35db`.
It built `net9.0` with `Jellyfin.Controller` **10.11.11**,
`Jellyfin.Model` **10.11.11**, and the `Microsoft.AspNetCore.App` framework
reference in
`mcr.microsoft.com/dotnet/sdk:9.0.203@sha256:fe3c1ed472bb0964c100f06aa9b1759f5ed84e0dfe6904d60f6a82159d3c7ae4`.
The summarized commands were the pinned SDK `dotnet build`, isolated
`docker compose ... up`, Jellyfin's startup/auth/key APIs, and focused HTTP
requests. The fixture was a one-second H.264/AAC MP4 with an external SRT.
Neither the fixture API key nor a complete lease was printed, logged, returned,
or recorded here.

The plugin was deliberately small: `BasePlugin`, a public
`IPluginServiceRegistrator`, one `IStartupFilter`, the lease middleware, and
two test-only controllers. The middleware matched the exercised raw paths
before routing; required a base64url-canonical HMAC lease over expiry, method,
route class, item, source where present, play-session/playlist identity where
present, and the sorted percent-encoded path/query fields; then removed the
lease and installed the configured fixture `MediaBrowser Token` header
in-process. Its response marker was evidence only, not a production protocol.

| Runtime question | Observed result | Status |
| --- | --- | --- |
| Compile and discovery | Pinned SDK build: `0` warnings, `0` errors. Jellyfin logged `Loaded assembly Nama.Spike, Version=1.0.0.0` from its plugin directory. | **[FACT] pass** |
| Middleware order and stock authentication | Dynamic HLS master with a valid lease returned **200** and `X-Nama-Spike-Pipeline: pre-custom-auth/post-authenticated`; headerless master returned **401**; ordinary fixture API-key master access returned **200**. | **[FACT] pass** for this route and image |
| Master lease bindings | A valid Dynamic HLS master lease returned **200**. Headerless, tampered, expired, wrong-method, wrong-item, wrong-source, wrong-session, and wrong-route-class requests each returned **401**. | **[FACT] pass** for the exact exercised master URL/query |
| Progressive | The negotiated `/videos/{item}/stream.ts` returned **200** for both scoped `GET` and scoped `HEAD` (`HEAD` body length 0); headerless `GET` returned **401**. | **[FACT] pass** for this video stream URL |
| Dynamic HLS graph | Master `GET` and `HEAD` returned **200**. The emitted `main.m3u8` variant and its emitted `hls1` child were each fetched with independently canonicalized leases and returned **200**; each headerless and first-signature-byte-tampered child request returned **401**. Inspected master/variant/child bodies contained neither the fixture key nor an `ApiKey` field. | **[FACT] pass** for the two emitted children of this fixture |
| Direct external subtitle | The external SRT stream route returned **200** with the exact source-bound lease, **401** headerless, and **401** tampered; its body did not contain the fixture key. | **[FACT] pass** |
| HLS external subtitle | `/Videos/{item}/{source}/Subtitles/{index}/subtitles.m3u8?segmentLength=1` returned **200** with a scoped lease and **401** headerless, but its emitted VTT child URI contained `ApiKey` and the exact configured fixture key. The key is not reproduced here. | **[FACT] fail**: ingress-only replacement cannot meet the no-broad-token invariant for this stock response |
| Legacy and encrypted HLS | This Dynamic HLS fixture emitted no legacy URL and no `EXT-X-KEY`; no encrypted key URI was available. The legacy templates were classified so a headerless representative legacy request was rejected before stock handling, which is explicitly incompatible with Jellyfin's source-documented headerless-segment compatibility behavior. | **[FACT] no encrypted-key proof; [INFERENCE] legacy clients that omit credentials break** |
| Exact-tag negotiation | The plugin endpoint instantiated `MediaBrowser.Model.Dlna.StreamBuilder` and returned `StreamInfo`; loaded `MediaBrowser.Model` was **10.11.11.0**, and DI supplied `MediaSourceManager` and `MediaEncoder`. The external-SRT fixture observed: “direct” profile → `Transcode`/`http`, audio index 2, subtitle index 0, `Encode`, `SubtitleCodecNotSupported`; forced-transcode profile → `Transcode`/`http`, `DirectPlayError`. It returned no locator. | **[FACT] access and these decisions pass** |
| Telemetry service reachability | A test-only extension controller created a stock session and invoked stock `OnPlaybackStart`, `OnPlaybackProgress`, and `OnPlaybackStopped`; its HTTP result was **204**. | **[FACT] the extension can invoke this underlying stock telemetry path** |
| Stateless caller and restart | Two separate stateless caller processes used the same still-valid self-contained master lease and each received **200**. In one controlled Jellyfin restart, the already-created `hls1` child was **200** before and **200** after restart, and the existing lease verified on master (**200**). | **[FACT] this fixture/cache survived once; not a general session-recovery guarantee** |

### Limits that remain decisive

The HLS-subtitle result is a concrete failure of the minimal request-only
mechanism. A response-rewriting design that replaces generated tokenized child
URIs with new exact scoped leases is an unimplemented, separately auditable
proposal—not a pass inferred from the startup hook.

Only the two observed negotiation configurations are truthful. The spike did
not realize or compare direct play, remux, isolated audio conversion, video
transcode without the external-subtitle interaction, embedded/burned/external
subtitle action mappings, track switching, or
`switchable_without_reopen`; all corresponding Nama plan fields remain
unproved and must not be guessed. It also did not produce an encrypted-HLS key
URI, exercise an emitted legacy route, or prove all media controller templates.

The telemetry endpoint proves invocation, not idempotency. No controlled lost
response was executed; a response loss remains an unresolved provider outcome
and must not be replayed or recorded as remote success. The single restart
observation does not override the source-based conservative cleanup rule.

**Revised verdict: accepted direction, unproved implementation.** An
exact-version, highly version-coupled extension can load and enforce a
self-contained lease before stock authentication on the tested routes. The
token-bearing HLS-subtitle response and the remaining graph, negotiation, and
telemetry gaps mean it cannot yet advertise the capabilities tracked by
issue #231.

## Decisive option matrix

| Option | Status for #231 | Nama invariants that remain intact | Limitation |
| --- | --- | --- | --- |
| Stock Jellyfin locator/token | **Infeasible.** | The core can still refuse playback capability. | Stock tokens have no item/route/expiry scope and generated playback/subtitle URLs put `ApiKey` in the client-visible query. |
| Additive controller only | **Infeasible.** | None of the missing lease invariants become true. | A controller cannot interpose on a selected stock stream/segment action; redirects retain the stock credential problem. |
| Middleware/auth-integrated Jellyfin server extension | **Accepted target; implementation incomplete.** | Tested paths preserve direct provider-to-client bytes, in-process fixture authorization, and a narrow expiring lease. | Exact 10.11.11 proved the hook, but stock HLS-subtitle output leaks the broad key without response rewriting; graph coverage, plan evidence, telemetry ambiguity, and host validation remain unproved. |
| Provider-side byte gateway | **Infeasible.** | It could enforce a narrow authorization boundary. | It relays media through a gateway, violating the no-Nama-media-proxy/direct-delivery constraint. |
| Jellyfin core/fork change | **Feasible in principle; not a plugin result.** | A native scoped media authorization model and explicit negotiation/telemetry contracts could preserve every listed invariant. | It requires a separately accepted server distribution, security, and compatibility decision. |

## Remaining required evidence matrix

| Unknown | Minimum exact-10.11.11 proof | Passing observation |
| --- | --- | --- |
| Hook and header order | Install only a minimal Jellyfin server extension that registers `IStartupFilter`; send a signed test lease to a protected core media route. | The filter runs before `CustomAuthenticationHandler`; a server-only rewritten `MediaBrowser` header authenticates the request; no response, redirect, log, or playlist contains the broad token. |
| Route guard and compatibility | Exercise `GET`/`HEAD` progressive audio/video, dynamic HLS master/main/`hls1` playlist and children, legacy playlist/segments, direct/HLS subtitles, and an encrypted-HLS fixture's key URI. For each extension URL, test valid, expired, tampered, wrong-item, wrong-media-source, wrong-session, wrong-route-class, and no-lease requests; separately replay normal stock Jellyfin clients. | Every extension-namespace request succeeds only with the exact bound lease; no stock path, provider identifier, or credential appears in a locator or rewritten child; ordinary stock routes retain their existing behavior. |
| Negotiation truth | Compare public `PlaybackInfo` and exact internal builder output for fixture combinations spanning direct, remux, audio transcode, video transcode, embedded/external/burned subtitles, each selectable track, and each Nama capability/preference. | Every advertised strategy, protocol, selected track, and action is observed from the Jellyfin decision path; unsupported or non-switchable choices are rejected/marked false rather than guessed; no returned locator contains `ApiKey`. |
| Statelessness and restart | Replace the Jellyfin provider plugin during active plan/open/report/close; then restart the Jellyfin server extension/Jellyfin before a child request and before report/close. | Self-contained verification works across provider-plugin replacement; server-resource loss becomes safe failure and bounded cleanup, with no fabricated success or stale session acceptance. |
| Telemetry ambiguity and sole writer | Make Jellyfin commit start/progress/stop while withholding the response; verify the core's report/close behavior and a later watch-state export attempt. | Nama does not replay the uncertain write, does not claim remote cleanup, and never sends an equivalent `PushWatchStates` write when telemetry is advertised as the sole writer. |

Issues #232, #233, and #234 must pass every applicable row on the exact pinned
server before the provider plugin advertises their capabilities. The resulting
operating and upgrade constraints remain part of that acceptance.
