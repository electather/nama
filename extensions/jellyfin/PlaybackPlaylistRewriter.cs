using System.Text;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.WebUtilities;

namespace Nama.Jellyfin.Extension;

internal sealed class PlaybackPlaylistRewriter
{
  private readonly PlaybackTokenService _tokens;

  public PlaybackPlaylistRewriter(PlaybackTokenService tokens)
  {
    _tokens = tokens;
  }

  public string Rewrite(
      string playlist,
      string stockTarget,
      string publicPrefix,
      string sessionId,
      DateTimeOffset expiration,
      int maximumBytes)
  {
    var lines = playlist.Split('\n');
    var rewritten = new BoundedUtf8Builder(maximumBytes);
    for (var index = 0; index < lines.Length; index++)
    {
      if (index > 0)
      {
        rewritten.Append("\n");
      }
      var line = lines[index].TrimEnd('\r');
      if (line.Length == 0)
      {
        continue;
      }
      rewritten.Append(line[0] == '#'
          ? RewriteUriAttributes(
              line,
              stockTarget,
              publicPrefix,
              sessionId,
              expiration,
              maximumBytes)
          : RewriteUri(
              line,
              stockTarget,
              publicPrefix,
              sessionId,
              expiration,
              null));
    }
    return rewritten.ToString();
  }

  public string RewriteLocation(
      string location,
      string stockTarget,
      string publicPrefix,
      string sessionId,
      DateTimeOffset expiration,
      bool rewritePlaylist)
  {
    return RewriteUri(
        location,
        stockTarget,
        publicPrefix,
        sessionId,
        expiration,
        rewritePlaylist);
  }

  private string RewriteUriAttributes(
      string line,
      string stockTarget,
      string publicPrefix,
      string sessionId,
      DateTimeOffset expiration,
      int maximumBytes)
  {
    const string marker = "URI=\"";
    var searchStart = 0;
    var rewritten = new BoundedUtf8Builder(maximumBytes);
    while (true)
    {
      var markerIndex = line.IndexOf(marker, searchStart, StringComparison.Ordinal);
      if (markerIndex < 0)
      {
        rewritten.Append(line.AsSpan(searchStart));
        return rewritten.ToString();
      }
      var valueStart = markerIndex + marker.Length;
      var valueEnd = line.IndexOf('"', valueStart);
      if (valueEnd < 0)
      {
        throw new PlaybackRequestException(StatusCodes.Status502BadGateway);
      }
      rewritten.Append(line.AsSpan(searchStart, valueStart - searchStart));
      rewritten.Append(RewriteUri(
          line[valueStart..valueEnd],
          stockTarget,
          publicPrefix,
          sessionId,
          expiration,
          null));
      searchStart = valueEnd;
    }
  }

  private string RewriteUri(
      string value,
      string stockTarget,
      string publicPrefix,
      string sessionId,
      DateTimeOffset expiration,
      bool? rewritePlaylist)
  {
    if (value.Length is 0 or > 8192)
    {
      throw new PlaybackRequestException(StatusCodes.Status502BadGateway);
    }
    var syntheticOrigin = new Uri("http://nama.invalid", UriKind.Absolute);
    var stockUri = new Uri(syntheticOrigin, stockTarget);
    if (!Uri.TryCreate(stockUri, value, out var child)
        || child.Scheme != syntheticOrigin.Scheme
        || child.Host != syntheticOrigin.Host
        || child.Port != syntheticOrigin.Port
        || !string.IsNullOrEmpty(child.UserInfo)
        || !string.IsNullOrEmpty(child.Fragment))
    {
      throw new PlaybackRequestException(StatusCodes.Status502BadGateway);
    }
    var query = QueryHelpers.ParseQuery(child.Query)
        .Where(pair => !PlaybackStockTarget.IsCredentialQueryName(pair.Key))
        .SelectMany(pair => pair.Value.Select(item =>
            new KeyValuePair<string, string?>(pair.Key, item)))
        .ToArray();
    var safeTarget = child.AbsolutePath + QueryString.Create(query);
    var mediaResource = _tokens.ProtectMediaResource(
        new MediaResourcePayload(
            sessionId,
            safeTarget,
            rewritePlaylist
                ?? child.AbsolutePath.EndsWith(".m3u8", StringComparison.OrdinalIgnoreCase)),
        expiration);
    if (mediaResource.Length > PlaybackConstants.MaximumMediaResourceLength)
    {
      throw new PlaybackRequestException(StatusCodes.Status502BadGateway);
    }
    return publicPrefix + mediaResource;
  }

}

internal static class PlaybackStockTarget
{
  public static bool IsCredentialQueryName(string value)
  {
    return value.Equals("ApiKey", StringComparison.OrdinalIgnoreCase)
        || value.Equals("api_key", StringComparison.OrdinalIgnoreCase)
        || value.Equals("X-Emby-Token", StringComparison.OrdinalIgnoreCase);
  }
}

internal sealed class BoundedUtf8Builder
{
  private readonly StringBuilder _builder = new();
  private readonly int _maximumBytes;
  private int _bytes;

  public BoundedUtf8Builder(int maximumBytes)
  {
    _maximumBytes = maximumBytes;
  }

  public void Append(string value)
  {
    var bytes = Encoding.UTF8.GetByteCount(value);
    if (bytes > _maximumBytes - _bytes)
    {
      throw new PlaybackRequestException(StatusCodes.Status502BadGateway);
    }
    _builder.Append(value);
    _bytes += bytes;
  }

  public void Append(ReadOnlySpan<char> value)
  {
    var bytes = Encoding.UTF8.GetByteCount(value);
    if (bytes > _maximumBytes - _bytes)
    {
      throw new PlaybackRequestException(StatusCodes.Status502BadGateway);
    }
    _builder.Append(value);
    _bytes += bytes;
  }

  public override string ToString()
  {
    return _builder.ToString();
  }
}
