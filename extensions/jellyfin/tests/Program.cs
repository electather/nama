using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.DataProtection;
using Nama.Jellyfin.Extension;

var keyDirectory = Directory.CreateTempSubdirectory("nama-playlist-proof-");
try
{
  var provider = DataProtectionProvider.Create(keyDirectory);
  var tokens = new PlaybackTokenService(provider);
  var rewriter = new PlaybackPlaylistRewriter(tokens);
  var expiration = DateTimeOffset.UtcNow.AddMinutes(5);
  const string sessionId = "playlist-proof-session";
  const string publicPrefix = "/Nama/v1/playback/";
  const int maximumBytes = 1_048_576;
  const string playlist = """
      #EXTM3U
      #EXT-X-KEY:METHOD=AES-128,URI="../keys/provider-key.bin?ApiKey=broad-secret&version=1"
      #EXT-X-MEDIA:TYPE=SUBTITLES,URI="/Videos/provider-item/subtitles/main.m3u8?api_key=broad-secret"
      ../segments/provider-segment.ts?X-Emby-Token=broad-secret
      """;

  var rewritten = rewriter.Rewrite(
      playlist,
      "/Videos/provider-item/master.m3u8?MediaSourceId=provider-source",
      publicPrefix,
      sessionId,
      expiration,
      maximumBytes);
  Require(!rewritten.Contains("broad-secret", StringComparison.Ordinal), "credential escaped");
  Require(!rewritten.Contains("provider-item", StringComparison.Ordinal), "item identity escaped");
  Require(!rewritten.Contains("provider-source", StringComparison.Ordinal), "source identity escaped");
  Require(!rewritten.Contains("ApiKey", StringComparison.OrdinalIgnoreCase), "API key name escaped");
  Require(!rewritten.Contains("X-Emby-Token", StringComparison.OrdinalIgnoreCase), "token name escaped");

  var resources = Regex.Matches(
      rewritten,
      "/Nama/v1/playback/(?<resource>[A-Za-z0-9_-]+)",
      RegexOptions.CultureInvariant,
      TimeSpan.FromSeconds(1));
  Require(resources.Count == 3, "not every playlist child was rewritten");
  var targets = new List<MediaResourcePayload>();
  foreach (Match match in resources)
  {
    var encoded = match.Groups["resource"].Value;
    Require(
        tokens.TryUnprotectMediaResource(encoded, out var resource, out var resourceExpiration),
        "rewritten resource did not verify");
    if (resource is null)
    {
      throw new InvalidOperationException("rewritten resource was absent");
    }
    Require(resource.SessionId == sessionId, "rewritten resource changed session");
    Require(resourceExpiration == expiration, "rewritten resource changed expiry");
    Require(!resource.StockTarget.Contains("broad-secret", StringComparison.Ordinal), "target retained credential");
    targets.Add(resource);
  }
  Require(targets.Count(target => target.RewritePlaylist) == 1, "playlist child classification changed");
  Require(targets.Any(target => target.StockTarget.Contains("version=1", StringComparison.Ordinal)), "safe key query was lost");

  try
  {
    rewriter.Rewrite(
        "#EXTM3U\nhttps://attacker.example/segment.ts\n",
        "/Videos/provider-item/master.m3u8",
        publicPrefix,
        sessionId,
        expiration,
        maximumBytes);
    throw new InvalidOperationException("cross-origin child was accepted");
  }
  catch (PlaybackRequestException exception) when (exception.StatusCode == 502)
  {
  }

  try
  {
    rewriter.Rewrite(
        playlist,
        "/Videos/provider-item/master.m3u8",
        publicPrefix,
        sessionId,
        expiration,
        32);
    throw new InvalidOperationException("rewritten playlist exceeded its byte bound");
  }
  catch (PlaybackRequestException exception) when (exception.StatusCode == 502)
  {
  }

  var oversizedChild = "/" + new string('a', 6_000) + ".ts";
  try
  {
    rewriter.Rewrite(
        $"#EXTM3U\n{oversizedChild}\n",
        "/Videos/provider-item/master.m3u8",
        publicPrefix,
        sessionId,
        expiration,
        maximumBytes);
    throw new InvalidOperationException("unusable opaque child resource was emitted");
  }
  catch (PlaybackRequestException exception) when (exception.StatusCode == 502)
  {
  }

  await using (var bounded = new BoundedMemoryStream(1))
  {
    try
    {
      await bounded.WriteAsync(new byte[] { 1, 2 });
      throw new InvalidOperationException("response buffer exceeded its byte bound");
    }
    catch (PlaybackRequestException exception) when (exception.StatusCode == 502)
    {
    }
  }

  var redirectContext = new DefaultHttpContext();
  redirectContext.Response.StatusCode = StatusCodes.Status302Found;
  redirectContext.Response.Headers.Location =
      "/Videos/provider-item/redirected.ts?ApiKey=broad-secret&version=2";
  PlaybackLeaseMiddleware.RewriteRedirect(
      redirectContext.Response,
      rewriter,
      new MediaResourcePayload(
          sessionId,
          "/Videos/provider-item/original.ts",
          false),
      expiration,
      publicPrefix);
  var redirectLocation = redirectContext.Response.Headers.Location.ToString();
  Require(
      redirectLocation.StartsWith(publicPrefix, StringComparison.Ordinal),
      "safe redirect did not stay opaque");
  Require(redirectContext.Response.ContentLength == 0, "redirect body was not suppressed");
  Require(
      tokens.TryUnprotectMediaResource(
          redirectLocation[publicPrefix.Length..],
          out var redirectResource,
          out var redirectExpiration),
      "redirect resource did not verify");
  if (redirectResource is null)
  {
    throw new InvalidOperationException("redirect resource was absent");
  }
  Require(redirectResource.SessionId == sessionId, "redirect changed session");
  Require(redirectResource.StockTarget.Contains("version=2", StringComparison.Ordinal), "safe redirect query was lost");
  Require(!redirectResource.StockTarget.Contains("broad-secret", StringComparison.Ordinal), "redirect retained credential");
  Require(!redirectResource.RewritePlaylist, "redirect changed resource classification");
  Require(redirectExpiration == expiration, "redirect changed expiry");

  var notModifiedContext = new DefaultHttpContext();
  notModifiedContext.Response.StatusCode = StatusCodes.Status304NotModified;
  notModifiedContext.Response.Headers.ETag = "\"provider-etag\"";
  PlaybackLeaseMiddleware.RewriteRedirect(
      notModifiedContext.Response,
      rewriter,
      new MediaResourcePayload(
          sessionId,
          "/Videos/provider-item/original.ts",
          false),
      expiration,
      publicPrefix);
  Require(
      notModifiedContext.Response.StatusCode == StatusCodes.Status304NotModified,
      "not-modified response was treated as a redirect");
  Require(
      notModifiedContext.Response.Headers.ETag == "\"provider-etag\"",
      "not-modified response headers changed");

  var unsupportedRedirectContext = new DefaultHttpContext();
  unsupportedRedirectContext.Response.StatusCode = StatusCodes.Status305UseProxy;
  unsupportedRedirectContext.Response.Headers.Location =
      "/Videos/provider-item/redirected.ts?ApiKey=broad-secret";
  PlaybackLeaseMiddleware.RewriteRedirect(
      unsupportedRedirectContext.Response,
      rewriter,
      new MediaResourcePayload(
          sessionId,
          "/Videos/provider-item/original.ts",
          false),
      expiration,
      publicPrefix);
  Require(
      unsupportedRedirectContext.Response.StatusCode == StatusCodes.Status502BadGateway,
      "unsupported redirect status was forwarded");
  Require(
      !unsupportedRedirectContext.Response.Headers.ContainsKey("Location"),
      "unsupported redirect location escaped");

  var unsafeRedirectContext = new DefaultHttpContext();
  unsafeRedirectContext.Response.StatusCode = StatusCodes.Status302Found;
  unsafeRedirectContext.Response.Headers.Location = "https://attacker.example/media.ts";
  PlaybackLeaseMiddleware.RewriteRedirect(
      unsafeRedirectContext.Response,
      rewriter,
      new MediaResourcePayload(
          sessionId,
          "/Videos/provider-item/original.ts",
          false),
      expiration,
      publicPrefix);
  Require(
      unsafeRedirectContext.Response.StatusCode == StatusCodes.Status502BadGateway,
      "cross-origin redirect was accepted");
  Require(
      !unsafeRedirectContext.Response.Headers.ContainsKey("Location"),
      "cross-origin redirect location escaped");

  await using var redirectOutput = new MemoryStream();
  var redirectBodyContext = new DefaultHttpContext();
  redirectBodyContext.Response.StatusCode = StatusCodes.Status302Found;
  await using (var redirectBody = new RedirectSuppressingStream(
      redirectOutput,
      redirectBodyContext.Response))
  {
    await redirectBody.WriteAsync(new byte[] { 1, 2, 3 });
  }
  Require(redirectOutput.Length == 0, "redirect body escaped");

  var selectionPlan = new PlaybackPlan(
      "selection-plan",
      Guid.NewGuid(),
      "selection-source",
      Guid.NewGuid(),
      TimeSpan.TicksPerMinute,
      0,
      null!,
      null!,
      [
        new PlaybackTrackModel(1, "audio", "aac", 2, true, false, null, null, null),
        new PlaybackTrackModel(2, "subtitle", "srt", null, false, false, null, null, "text")
      ]);
  await RequireRejectedTrackSelection(
      selectionPlan,
      new PlaybackOpenRequest("wrong-type-operation", "wrong-type-plan", 2, true, null),
      "audio selection used a subtitle track");
  await RequireRejectedTrackSelection(
      selectionPlan,
      new PlaybackOpenRequest("missing-track-operation", "missing-track-plan", 1, false, 99),
      "subtitle selection was absent from the plan");

  IReadOnlyList<SubtitleCandidate> subtitleCandidates =
  [
    new SubtitleCandidate(3, "ass", "eng", false, true),
    new SubtitleCandidate(4, "srt", "fra", false, true)
  ];
  IReadOnlyList<SubtitleCapabilityInput> subtitleCapabilities =
  [
    new SubtitleCapabilityInput("srt", ["embedded"])
  ];
  foreach (var preference in new[] { "always", "forced_only", "auto" })
  {
    var selected = PlaybackSubtitleSelector.Select(
        subtitleCandidates,
        -1,
        preference,
        ["eng"],
        subtitleCapabilities);
    Require(
        selected is 4,
        $"{preference} subtitle fallback ignored hard capabilities");
  }

  try
  {
    PlaybackCapabilityValidator.Validate(
        new PlaybackCapabilitiesInput([], ["http_progressive"], [], null, null, null, null, []));
    throw new InvalidOperationException("empty dynamic-range capabilities were accepted");
  }
  catch (PlaybackRequestException exception) when (
      exception.StatusCode == StatusCodes.Status412PreconditionFailed
      && exception.Reason == "DYNAMIC_RANGE_UNSUPPORTED")
  {
  }
}
finally
{
  keyDirectory.Delete(recursive: true);
}

static async Task RequireRejectedTrackSelection(
    PlaybackPlan plan,
    PlaybackOpenRequest request,
    string message)
{
  var store = new PlaybackSessionStore();
  try
  {
    await store.OpenAsync(
        request,
        () => plan,
        _ => Task.FromException<PlaybackSessionState>(new InvalidOperationException(message)));
    throw new InvalidOperationException($"{message}: selection was accepted");
  }
  catch (PlaybackRequestException exception) when (
      exception.StatusCode == StatusCodes.Status412PreconditionFailed
      && exception.Reason == "TRACK_SELECTION_REQUIRES_REPLAN")
  {
  }
}

static void Require(bool condition, string message)
{
  if (!condition)
  {
    throw new InvalidOperationException(message);
  }
}
