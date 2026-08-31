using System.Globalization;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Primitives;

namespace Nama.Jellyfin.Extension;

internal sealed class PlaybackLeaseMiddleware
{
  private const string MediaPrefix = "/Nama/v1/playback/";
  private readonly RequestDelegate _next;
  private readonly ExtensionHostCompatibility _compatibility;
  private readonly PlaybackTokenService _tokens;

  public PlaybackLeaseMiddleware(
      RequestDelegate next,
      ExtensionHostCompatibility compatibility,
      PlaybackTokenService tokens)
  {
    _next = next;
    _compatibility = compatibility;
    _tokens = tokens;
  }

  public async Task InvokeAsync(HttpContext context)
  {
    var path = context.Request.Path.Value;
    if (path is null || !path.StartsWith(MediaPrefix, StringComparison.Ordinal))
    {
      await _next(context).ConfigureAwait(false);
      return;
    }
    if (context.Request.Method is not ("GET" or "HEAD"))
    {
      await _next(context).ConfigureAwait(false);
      return;
    }


    var mediaResource = path[MediaPrefix.Length..];
    if (!_compatibility.IsCompatible
        || mediaResource.Length is 0 or > 1024
        || mediaResource.Contains('/', StringComparison.Ordinal)
        || !context.Request.Headers.TryGetValue(PlaybackConstants.LeaseHeader, out var leaseHeaders)
        || leaseHeaders.Count != 1
        || !_tokens.TryUnprotectMediaLease(leaseHeaders[0] ?? string.Empty, out var lease)
        || lease is null
        || !string.Equals(lease.MediaResource, mediaResource, StringComparison.Ordinal)
        || !string.Equals(lease.Container, "mp4", StringComparison.Ordinal))
    {
      context.Response.StatusCode = StatusCodes.Status401Unauthorized;
      return;
    }

    context.Request.Headers.Remove(PlaybackConstants.LeaseHeader);
    context.Request.Headers.Authorization = new StringValues($"MediaBrowser Token=\"{lease.ApiKey}\"");
    context.Request.Path = $"/Videos/{lease.ItemId.ToString("N", CultureInfo.InvariantCulture)}/stream.mp4";
    context.Request.QueryString = QueryString.Create(
    [
        new KeyValuePair<string, string?>("static", "true"),
            new KeyValuePair<string, string?>("mediaSourceId", lease.SourceId),
            new KeyValuePair<string, string?>("playSessionId", lease.SessionId)
    ]);
    await _next(context).ConfigureAwait(false);
  }
}
