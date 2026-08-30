using System.Security.Cryptography;
using System.Text.Json;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.WebUtilities;

namespace Nama.Jellyfin.Extension;

internal sealed class PlaybackRequestException : Exception
{
  public PlaybackRequestException(
      int statusCode,
      string reason = "PLAYBACK_REQUEST_REJECTED")
      : base("The playback request was rejected.")
  {
    StatusCode = statusCode;
    Reason = reason;
  }

  public int StatusCode { get; }

  public string Reason { get; }
}

internal sealed class PlaybackTokenService
{
  private readonly ITimeLimitedDataProtector _planProtector;
  private readonly ITimeLimitedDataProtector _sessionContextProtector;
  private readonly ITimeLimitedDataProtector _mediaLeaseProtector;

  public PlaybackTokenService(IDataProtectionProvider provider)
  {
    ArgumentNullException.ThrowIfNull(provider);

    _planProtector = provider
        .CreateProtector("nama-jellyfin-extension", "playback-plan", "v1")
        .ToTimeLimitedDataProtector();
    _sessionContextProtector = provider
        .CreateProtector("nama-jellyfin-extension", "session-context", "v1")
        .ToTimeLimitedDataProtector();
    _mediaLeaseProtector = provider
        .CreateProtector("nama-jellyfin-extension", "media-lease", "v1")
        .ToTimeLimitedDataProtector();
  }

  public static string CreateOpaqueId()
  {
    return WebEncoders.Base64UrlEncode(RandomNumberGenerator.GetBytes(24));
  }

  public string ProtectPlan(string planNonce, DateTimeOffset expiration)
  {
    return Protect(_planProtector, planNonce, expiration);
  }

  public string UnprotectPlan(string token, out DateTimeOffset expiration)
  {
    return Unprotect<string>(
        _planProtector,
        token,
        StatusCodes.Status410Gone,
        out expiration);
  }

  public string ProtectSessionContext(SessionContextPayload payload, DateTimeOffset expiration)
  {
    return Protect(_sessionContextProtector, payload, expiration);
  }

  public SessionContextPayload UnprotectSessionContext(string token)
  {
    return Unprotect<SessionContextPayload>(
        _sessionContextProtector,
        token,
        StatusCodes.Status404NotFound,
        out _);
  }

  public string ProtectMediaLease(MediaLeasePayload payload, DateTimeOffset expiration)
  {
    return Protect(_mediaLeaseProtector, payload, expiration);
  }

  public bool TryUnprotectMediaLease(string token, out MediaLeasePayload? payload)
  {
    try
    {
      payload = Unprotect<MediaLeasePayload>(
          _mediaLeaseProtector,
          token,
          StatusCodes.Status401Unauthorized,
          out _);
      return true;
    }
    catch (PlaybackRequestException)
    {
      payload = null;
      return false;
    }
  }

  private static string Protect<T>(
      ITimeLimitedDataProtector protector,
      T payload,
      DateTimeOffset expiration)
  {
    var plaintext = JsonSerializer.SerializeToUtf8Bytes(payload);
    return WebEncoders.Base64UrlEncode(protector.Protect(plaintext, expiration));
  }

  private static T Unprotect<T>(
      ITimeLimitedDataProtector protector,
      string token,
      int failureStatusCode,
      out DateTimeOffset expiration)
  {
    try
    {
      var protectedBytes = WebEncoders.Base64UrlDecode(token);
      var plaintext = protector.Unprotect(protectedBytes, out expiration);
      return JsonSerializer.Deserialize<T>(plaintext)
          ?? throw new PlaybackRequestException(failureStatusCode);
    }
    catch (Exception exception) when (
        exception is CryptographicException
            or FormatException
            or JsonException)
    {
      throw new PlaybackRequestException(failureStatusCode);
    }
  }
}
