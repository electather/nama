using System.Text.RegularExpressions;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.Http;
using Microsoft.VisualStudio.TestTools.UnitTesting;

namespace Nama.Jellyfin.Extension.Tests;

[TestClass]
public sealed class PlaybackMediaBoundaryTests
{
  private const int MaximumBytes = 1_048_576;
  private const string Playlist = """
      #EXTM3U
      #EXT-X-KEY:METHOD=AES-128,URI="../keys/provider-key.bin?ApiKey=broad-secret&version=1"
      #EXT-X-MEDIA:TYPE=SUBTITLES,URI="/Videos/provider-item/subtitles/main.m3u8?api_key=broad-secret"
      ../segments/provider-segment.ts?X-Emby-Token=broad-secret
      """;
  private const string PublicPrefix = "/Nama/v1/playback/";
  private const string SessionId = "playlist-proof-session";

  [TestMethod]
  public void PlaylistChildrenRemainOpaqueAndCredentialFree()
  {
    using var fixture = new MediaFixture();

    var rewritten = fixture.Rewriter.Rewrite(
        Playlist,
        "/Videos/provider-item/master.m3u8?MediaSourceId=provider-source",
        PublicPrefix,
        SessionId,
        fixture.Expiration,
        MaximumBytes);

    Assert.IsFalse(rewritten.Contains("broad-secret", StringComparison.Ordinal));
    Assert.IsFalse(rewritten.Contains("provider-item", StringComparison.Ordinal));
    Assert.IsFalse(rewritten.Contains("provider-source", StringComparison.Ordinal));
    Assert.IsFalse(rewritten.Contains("ApiKey", StringComparison.OrdinalIgnoreCase));
    Assert.IsFalse(rewritten.Contains("X-Emby-Token", StringComparison.OrdinalIgnoreCase));
    var resources = Regex.Matches(
        rewritten,
        "/Nama/v1/playback/(?<resource>[A-Za-z0-9_-]+)",
        RegexOptions.CultureInvariant,
        TimeSpan.FromSeconds(1));
    Assert.HasCount(3, resources);
    var targets = new List<MediaResourcePayload>();
    foreach (Match match in resources)
    {
      var encoded = match.Groups["resource"].Value;
      Assert.IsTrue(fixture.Tokens.TryUnprotectMediaResource(
          encoded,
          out var resource,
          out var resourceExpiration));
      Assert.IsNotNull(resource);
      Assert.AreEqual(SessionId, resource.SessionId);
      Assert.AreEqual(fixture.Expiration, resourceExpiration);
      Assert.IsFalse(resource.StockTarget.Contains("broad-secret", StringComparison.Ordinal));
      targets.Add(resource);
    }

    Assert.AreEqual(1, targets.Count(target => target.RewritePlaylist));
    Assert.IsTrue(targets.Any(
        target => target.StockTarget.Contains("version=1", StringComparison.Ordinal)));
  }

  [TestMethod]
  public void CrossOriginPlaylistChildIsRejected()
  {
    using var fixture = new MediaFixture();

    var exception = Assert.ThrowsExactly<PlaybackRequestException>(() => fixture.Rewriter.Rewrite(
        "#EXTM3U\nhttps://attacker.example/segment.ts\n",
        "/Videos/provider-item/master.m3u8",
        PublicPrefix,
        SessionId,
        fixture.Expiration,
        MaximumBytes));

    Assert.AreEqual(StatusCodes.Status502BadGateway, exception.StatusCode);
  }

  [TestMethod]
  public void RewrittenPlaylistCannotExceedByteBound()
  {
    using var fixture = new MediaFixture();

    var exception = Assert.ThrowsExactly<PlaybackRequestException>(() => fixture.Rewriter.Rewrite(
        Playlist,
        "/Videos/provider-item/master.m3u8",
        PublicPrefix,
        SessionId,
        fixture.Expiration,
        32));

    Assert.AreEqual(StatusCodes.Status502BadGateway, exception.StatusCode);
  }

  [TestMethod]
  public void OversizedOpaqueChildResourceIsRejected()
  {
    using var fixture = new MediaFixture();
    var oversizedChild = "/" + new string('a', 6_000) + ".ts";

    var exception = Assert.ThrowsExactly<PlaybackRequestException>(() => fixture.Rewriter.Rewrite(
        $"#EXTM3U\n{oversizedChild}\n",
        "/Videos/provider-item/master.m3u8",
        PublicPrefix,
        SessionId,
        fixture.Expiration,
        MaximumBytes));

    Assert.AreEqual(StatusCodes.Status502BadGateway, exception.StatusCode);
  }

  [TestMethod]
  public async Task ResponseBufferRejectsBytesBeyondBound()
  {
    await using var bounded = new BoundedMemoryStream(1);

    var exception = await Assert.ThrowsExactlyAsync<PlaybackRequestException>(
        async () => await bounded.WriteAsync(new byte[] { 1, 2 }));

    Assert.AreEqual(StatusCodes.Status502BadGateway, exception.StatusCode);
  }

  [TestMethod]
  public void SafeRedirectIsRemintedAsOpaqueResource()
  {
    using var fixture = new MediaFixture();
    var context = new DefaultHttpContext();
    context.Response.StatusCode = StatusCodes.Status302Found;
    context.Response.Headers.Location =
        "/Videos/provider-item/redirected.ts?ApiKey=broad-secret&version=2";

    PlaybackLeaseMiddleware.RewriteRedirect(
        context.Response,
        fixture.Rewriter,
        new MediaResourcePayload(SessionId, "/Videos/provider-item/original.ts", false),
        fixture.Expiration,
        PublicPrefix);

    var location = context.Response.Headers.Location.ToString();
    Assert.IsTrue(location.StartsWith(PublicPrefix, StringComparison.Ordinal));
    Assert.AreEqual(0, context.Response.ContentLength);
    Assert.IsTrue(fixture.Tokens.TryUnprotectMediaResource(
        location[PublicPrefix.Length..],
        out var resource,
        out var expiration));
    Assert.IsNotNull(resource);
    Assert.AreEqual(SessionId, resource.SessionId);
    Assert.IsTrue(resource.StockTarget.Contains("version=2", StringComparison.Ordinal));
    Assert.IsFalse(resource.StockTarget.Contains("broad-secret", StringComparison.Ordinal));
    Assert.IsFalse(resource.RewritePlaylist);
    Assert.AreEqual(fixture.Expiration, expiration);
  }

  [TestMethod]
  public void NotModifiedResponseIsNotRewrittenAsRedirect()
  {
    using var fixture = new MediaFixture();
    var context = new DefaultHttpContext();
    context.Response.StatusCode = StatusCodes.Status304NotModified;
    context.Response.Headers.ETag = "\"provider-etag\"";

    PlaybackLeaseMiddleware.RewriteRedirect(
        context.Response,
        fixture.Rewriter,
        new MediaResourcePayload(SessionId, "/Videos/provider-item/original.ts", false),
        fixture.Expiration,
        PublicPrefix);

    Assert.AreEqual(StatusCodes.Status304NotModified, context.Response.StatusCode);
    Assert.AreEqual("\"provider-etag\"", context.Response.Headers.ETag.ToString());
  }

  [TestMethod]
  public void UnsupportedRedirectStatusFailsClosed()
  {
    using var fixture = new MediaFixture();
    var context = new DefaultHttpContext();
    context.Response.StatusCode = StatusCodes.Status305UseProxy;
    context.Response.Headers.Location = "/Videos/provider-item/redirected.ts?ApiKey=broad-secret";

    PlaybackLeaseMiddleware.RewriteRedirect(
        context.Response,
        fixture.Rewriter,
        new MediaResourcePayload(SessionId, "/Videos/provider-item/original.ts", false),
        fixture.Expiration,
        PublicPrefix);

    Assert.AreEqual(StatusCodes.Status502BadGateway, context.Response.StatusCode);
    Assert.IsFalse(context.Response.Headers.ContainsKey("Location"));
  }

  [TestMethod]
  public void CrossOriginRedirectFailsClosed()
  {
    using var fixture = new MediaFixture();
    var context = new DefaultHttpContext();
    context.Response.StatusCode = StatusCodes.Status302Found;
    context.Response.Headers.Location = "https://attacker.example/media.ts";

    PlaybackLeaseMiddleware.RewriteRedirect(
        context.Response,
        fixture.Rewriter,
        new MediaResourcePayload(SessionId, "/Videos/provider-item/original.ts", false),
        fixture.Expiration,
        PublicPrefix);

    Assert.AreEqual(StatusCodes.Status502BadGateway, context.Response.StatusCode);
    Assert.IsFalse(context.Response.Headers.ContainsKey("Location"));
  }

  [TestMethod]
  public async Task RedirectResponseBodyIsSuppressed()
  {
    await using var output = new MemoryStream();
    var context = new DefaultHttpContext();
    context.Response.StatusCode = StatusCodes.Status302Found;
    await using (var redirectBody = new RedirectSuppressingStream(output, context.Response))
    {
      await redirectBody.WriteAsync(new byte[] { 1, 2, 3 });
    }

    Assert.AreEqual(0, output.Length);
  }

  private sealed class MediaFixture : IDisposable
  {
    private readonly DirectoryInfo _keyDirectory =
        Directory.CreateTempSubdirectory("nama-media-tests-");

    public MediaFixture()
    {
      Tokens = new PlaybackTokenService(DataProtectionProvider.Create(_keyDirectory));
      Rewriter = new PlaybackPlaylistRewriter(Tokens);
    }

    public DateTimeOffset Expiration { get; } = DateTimeOffset.UtcNow.AddMinutes(5);

    public PlaybackPlaylistRewriter Rewriter { get; }

    public PlaybackTokenService Tokens { get; }

    public void Dispose()
    {
      _keyDirectory.Delete(recursive: true);
    }
  }
}
