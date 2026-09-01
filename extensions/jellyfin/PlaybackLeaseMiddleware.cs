using System.Text;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.WebUtilities;
using Microsoft.Extensions.Primitives;

namespace Nama.Jellyfin.Extension;

internal sealed class PlaybackLeaseMiddleware
{
  private const int MaximumControlDocumentBytes = 1_048_576;
  private const string MediaPrefix = "/Nama/v1/playback/";
  private readonly RequestDelegate _next;
  private readonly ExtensionHostCompatibility _compatibility;
  private readonly PlaybackPlaylistRewriter _playlistRewriter;
  private readonly PlaybackTokenService _tokens;

  public PlaybackLeaseMiddleware(
      RequestDelegate next,
      ExtensionHostCompatibility compatibility,
      PlaybackTokenService tokens)
  {
    _next = next;
    _compatibility = compatibility;
    _playlistRewriter = new PlaybackPlaylistRewriter(tokens);
    _tokens = tokens;
  }

  public async Task InvokeAsync(HttpContext context)
  {
    var path = context.Request.Path.Value;
    if (path is null
        || !path.StartsWith(MediaPrefix, StringComparison.Ordinal)
        || context.Request.Method is not ("GET" or "HEAD"))
    {
      await _next(context).ConfigureAwait(false);
      return;
    }

    var mediaResource = path[MediaPrefix.Length..];
    if (!_compatibility.IsCompatible
        || mediaResource.Length is 0 or > PlaybackConstants.MaximumMediaResourceLength
        || mediaResource.Contains('/', StringComparison.Ordinal)
        || !context.Request.Headers.TryGetValue(PlaybackConstants.LeaseHeader, out var leaseHeaders)
        || leaseHeaders.Count != 1
        || !_tokens.TryUnprotectMediaLease(
            leaseHeaders[0] ?? string.Empty,
            out var lease,
            out var leaseExpiration)
        || lease is null
        || !_tokens.TryUnprotectMediaResource(
            mediaResource,
            out var resource,
            out var resourceExpiration)
        || resource is null
        || !string.Equals(lease.SessionId, resource.SessionId, StringComparison.Ordinal)
        || leaseExpiration != resourceExpiration
        || !TryApplyStockTarget(context.Request, resource.StockTarget))
    {
      context.Response.StatusCode = StatusCodes.Status401Unauthorized;
      return;
    }

    context.Request.Headers.Remove(PlaybackConstants.LeaseHeader);
    context.Request.Headers.Authorization = new StringValues($"MediaBrowser Token=\"{lease.ApiKey}\"");
    var publicPrefix = $"{context.Request.PathBase}{MediaPrefix}";
    RedirectSuppressingStream? redirectBody = null;
    context.Response.OnStarting(() =>
    {
      var statusCode = context.Response.StatusCode;
      var wasRedirect = statusCode is >= 300 and < 400
          && statusCode != StatusCodes.Status304NotModified;
      RewriteRedirect(
          context.Response,
          _playlistRewriter,
          resource,
          resourceExpiration,
          publicPrefix);
      if (wasRedirect)
      {
        redirectBody?.SuppressRedirectBody();
      }
      return Task.CompletedTask;
    });
    if (string.Equals(context.Request.Method, "HEAD", StringComparison.Ordinal))
    {
      await _next(context).ConfigureAwait(false);
      return;
    }
    if (!resource.RewritePlaylist)
    {
      var responseBody = context.Response.Body;
      redirectBody = new RedirectSuppressingStream(responseBody, context.Response);
      context.Response.Body = redirectBody;
      try
      {
        await _next(context).ConfigureAwait(false);
      }
      finally
      {
        context.Response.Body = responseBody;
      }
      return;
    }

    await RewriteControlDocumentAsync(
        context,
        resource,
        resourceExpiration).ConfigureAwait(false);
  }

  private async Task RewriteControlDocumentAsync(
      HttpContext context,
      MediaResourcePayload resource,
      DateTimeOffset expiration)
  {
    var responseBody = context.Response.Body;
    using var buffer = new BoundedMemoryStream(MaximumControlDocumentBytes);
    context.Response.Body = buffer;
    try
    {
      await _next(context).ConfigureAwait(false);
      context.Response.Body = responseBody;
      if (context.Response.StatusCode is < 200 or >= 300)
      {
        context.Response.ContentLength = 0;
        return;
      }
      if (!IsPlaylistContentType(context.Response.ContentType))
      {
        context.Response.Clear();
        context.Response.StatusCode = StatusCodes.Status502BadGateway;
        return;
      }

      var encoded = buffer.ToArray();
      string playlist;
      try
      {
        playlist = new UTF8Encoding(false, true).GetString(encoded);
      }
      catch (DecoderFallbackException)
      {
        context.Response.Clear();
        context.Response.StatusCode = StatusCodes.Status502BadGateway;
        return;
      }
      var publicPrefix = $"{context.Request.PathBase}{MediaPrefix}";
      var rewritten = _playlistRewriter.Rewrite(
          playlist,
          resource.StockTarget,
          publicPrefix,
          resource.SessionId,
          expiration,
          MaximumControlDocumentBytes);
      var rewrittenBytes = Encoding.UTF8.GetBytes(rewritten);
      if (rewrittenBytes.Length > MaximumControlDocumentBytes)
      {
        context.Response.Clear();
        context.Response.StatusCode = StatusCodes.Status502BadGateway;
        return;
      }
      context.Response.ContentLength = rewrittenBytes.Length;
      await responseBody.WriteAsync(rewrittenBytes, context.RequestAborted).ConfigureAwait(false);
    }
    catch (PlaybackRequestException)
    {
      context.Response.Body = responseBody;
      context.Response.Clear();
      context.Response.StatusCode = StatusCodes.Status502BadGateway;
    }
    finally
    {
      context.Response.Body = responseBody;
    }
  }


  private static bool TryApplyStockTarget(HttpRequest request, string stockTarget)
  {
    if (stockTarget.Length is 0 or > 4096
        || stockTarget[0] != '/'
        || stockTarget.Contains("://", StringComparison.Ordinal))
    {
      return false;
    }
    var queryIndex = stockTarget.IndexOf('?', StringComparison.Ordinal);
    var path = queryIndex < 0 ? stockTarget : stockTarget[..queryIndex];
    var query = queryIndex < 0 ? string.Empty : stockTarget[queryIndex..];
    if (path.Length == 0
        || QueryHelpers.ParseQuery(query).Any(pair =>
            PlaybackStockTarget.IsCredentialQueryName(pair.Key)))
    {
      return false;
    }
    request.Path = path;
    request.QueryString = new QueryString(query);
    return true;
  }

  private static bool IsPlaylistContentType(string? contentType)
  {
    return contentType?.StartsWith(
        "application/vnd.apple.mpegurl",
        StringComparison.OrdinalIgnoreCase) == true
        || contentType?.StartsWith(
            "application/x-mpegurl",
            StringComparison.OrdinalIgnoreCase) == true;
  }

  private static bool IsRedirectStatus(int statusCode)
  {
    return statusCode is StatusCodes.Status301MovedPermanently
        or StatusCodes.Status302Found
        or StatusCodes.Status303SeeOther
        or StatusCodes.Status307TemporaryRedirect
        or StatusCodes.Status308PermanentRedirect;
  }

  private static void RejectRedirect(HttpResponse response)
  {
    response.Headers.Remove("Location");
    response.ContentLength = 0;
    response.StatusCode = StatusCodes.Status502BadGateway;
  }

  internal static void RewriteRedirect(
      HttpResponse response,
      PlaybackPlaylistRewriter rewriter,
      MediaResourcePayload resource,
      DateTimeOffset expiration,
      string publicPrefix)
  {
    if (response.StatusCode == StatusCodes.Status304NotModified
        || response.StatusCode is < 300 or >= 400)
    {
      return;
    }
    if (!IsRedirectStatus(response.StatusCode))
    {
      RejectRedirect(response);
      return;
    }
    var locations = response.Headers.Location;
    try
    {
      if (locations.Count != 1)
      {
        throw new PlaybackRequestException(StatusCodes.Status502BadGateway);
      }
      response.Headers.Location = rewriter.RewriteLocation(
          locations[0] ?? string.Empty,
          resource.StockTarget,
          publicPrefix,
          resource.SessionId,
          expiration,
          resource.RewritePlaylist);
      response.ContentLength = 0;
    }
    catch (PlaybackRequestException)
    {
      RejectRedirect(response);
    }
  }

}

internal sealed class BoundedMemoryStream : Stream
{
  private readonly MemoryStream _inner = new();
  private readonly long _maximumBytes;

  public BoundedMemoryStream(long maximumBytes)
  {
    _maximumBytes = maximumBytes;
  }

  public override bool CanRead => true;
  public override bool CanSeek => true;
  public override bool CanWrite => true;
  public override long Length => _inner.Length;
  public override long Position
  {
    get => _inner.Position;
    set => _inner.Position = value;
  }

  public byte[] ToArray()
  {
    return _inner.ToArray();
  }

  public override void Flush()
  {
    _inner.Flush();
  }

  public override Task FlushAsync(CancellationToken cancellationToken)
  {
    return _inner.FlushAsync(cancellationToken);
  }

  public override int Read(byte[] buffer, int offset, int count)
  {
    return _inner.Read(buffer, offset, count);
  }

  public override long Seek(long offset, SeekOrigin origin)
  {
    return _inner.Seek(offset, origin);
  }

  public override void SetLength(long value)
  {
    RequireCapacity(value);
    _inner.SetLength(value);
  }

  public override void Write(byte[] buffer, int offset, int count)
  {
    RequireCapacity(checked(Position + count));
    _inner.Write(buffer, offset, count);
  }

  public override void Write(ReadOnlySpan<byte> buffer)
  {
    RequireCapacity(checked(Position + buffer.Length));
    _inner.Write(buffer);
  }

  public override Task WriteAsync(
      byte[] buffer,
      int offset,
      int count,
      CancellationToken cancellationToken)
  {
    RequireCapacity(checked(Position + count));
    return _inner.WriteAsync(buffer, offset, count, cancellationToken);
  }

  public override ValueTask WriteAsync(
      ReadOnlyMemory<byte> buffer,
      CancellationToken cancellationToken = default)
  {
    RequireCapacity(checked(Position + buffer.Length));
    return _inner.WriteAsync(buffer, cancellationToken);
  }

  protected override void Dispose(bool disposing)
  {
    if (disposing)
    {
      _inner.Dispose();
    }
    base.Dispose(disposing);
  }

  private void RequireCapacity(long length)
  {
    if (length > _maximumBytes)
    {
      throw new PlaybackRequestException(StatusCodes.Status502BadGateway);
    }
  }
}

internal sealed class RedirectSuppressingStream : Stream
{
  private readonly Stream _inner;
  private readonly HttpResponse _response;
  private bool _suppress;

  public RedirectSuppressingStream(Stream inner, HttpResponse response)
  {
    _inner = inner;
    _response = response;
  }

  public void SuppressRedirectBody()
  {
    _suppress = true;
  }

  public override bool CanRead => _inner.CanRead;
  public override bool CanSeek => _inner.CanSeek;
  public override bool CanWrite => _inner.CanWrite;
  public override long Length => _inner.Length;
  public override long Position
  {
    get => _inner.Position;
    set => _inner.Position = value;
  }

  public override void Flush()
  {
    _inner.Flush();
  }

  public override Task FlushAsync(CancellationToken cancellationToken)
  {
    return _inner.FlushAsync(cancellationToken);
  }

  public override int Read(byte[] buffer, int offset, int count)
  {
    return _inner.Read(buffer, offset, count);
  }

  public override long Seek(long offset, SeekOrigin origin)
  {
    return _inner.Seek(offset, origin);
  }

  public override void SetLength(long value)
  {
    _inner.SetLength(value);
  }

  public override void Write(byte[] buffer, int offset, int count)
  {
    if (!Suppress)
    {
      _inner.Write(buffer, offset, count);
    }
  }

  public override void Write(ReadOnlySpan<byte> buffer)
  {
    if (!Suppress)
    {
      _inner.Write(buffer);
    }
  }

  public override Task WriteAsync(
      byte[] buffer,
      int offset,
      int count,
      CancellationToken cancellationToken)
  {
    return Suppress
        ? Task.CompletedTask
        : _inner.WriteAsync(buffer, offset, count, cancellationToken);
  }

  public override ValueTask WriteAsync(
      ReadOnlyMemory<byte> buffer,
      CancellationToken cancellationToken = default)
  {
    return Suppress
        ? ValueTask.CompletedTask
        : _inner.WriteAsync(buffer, cancellationToken);
  }

  private bool Suppress => _suppress || _response.StatusCode is >= 300 and < 400;
}
