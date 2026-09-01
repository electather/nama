using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.Http;
using Microsoft.VisualStudio.TestTools.UnitTesting;

namespace Nama.Jellyfin.Extension.Tests;

[TestClass]
public sealed class PlaybackTokenServiceTests
{
  [TestMethod]
  public void PurposeSeparatedTokensRoundTrip()
  {
    using var fixture = new TokenFixture();
    var expiration = DateTimeOffset.UtcNow.AddMinutes(5);
    var session = new SessionContextPayload("session");
    var lease = new MediaLeasePayload("session", Guid.NewGuid(), "source", "api-key");
    var resource = new MediaResourcePayload("session", "/Videos/item/stream", true);

    var planToken = fixture.Tokens.ProtectPlan("plan", expiration);
    var sessionToken = fixture.Tokens.ProtectSessionContext(session, expiration);
    var leaseToken = fixture.Tokens.ProtectMediaLease(lease, expiration);
    var resourceToken = fixture.Tokens.ProtectMediaResource(resource, expiration);

    Assert.AreEqual("plan", fixture.Tokens.UnprotectPlan(planToken, out var planExpiration));
    Assert.AreEqual(expiration, planExpiration);
    Assert.AreEqual(session, fixture.Tokens.UnprotectSessionContext(sessionToken));
    Assert.IsTrue(fixture.Tokens.TryUnprotectMediaLease(leaseToken, out var unprotectedLease, out var leaseExpiration));
    Assert.AreEqual(lease, unprotectedLease);
    Assert.AreEqual(expiration, leaseExpiration);
    Assert.IsTrue(fixture.Tokens.TryUnprotectMediaResource(
        resourceToken,
        out var unprotectedResource,
        out var resourceExpiration));
    Assert.AreEqual(resource, unprotectedResource);
    Assert.AreEqual(expiration, resourceExpiration);
  }

  [TestMethod]
  public void TokensRejectCrossPurposeUse()
  {
    using var fixture = new TokenFixture();
    var expiration = DateTimeOffset.UtcNow.AddMinutes(5);
    var planToken = fixture.Tokens.ProtectPlan("plan", expiration);
    var sessionToken = fixture.Tokens.ProtectSessionContext(
        new SessionContextPayload("session"),
        expiration);
    var leaseToken = fixture.Tokens.ProtectMediaLease(
        new MediaLeasePayload("session", Guid.NewGuid(), "source", "api-key"),
        expiration);
    var resourceToken = fixture.Tokens.ProtectMediaResource(
        new MediaResourcePayload("session", "/Videos/item/stream", false),
        expiration);

    var sessionException = Assert.ThrowsExactly<PlaybackRequestException>(
        () => fixture.Tokens.UnprotectSessionContext(planToken));
    var planException = Assert.ThrowsExactly<PlaybackRequestException>(
        () => fixture.Tokens.UnprotectPlan(sessionToken, out _));

    Assert.AreEqual(StatusCodes.Status404NotFound, sessionException.StatusCode);
    Assert.AreEqual(StatusCodes.Status410Gone, planException.StatusCode);
    Assert.IsFalse(fixture.Tokens.TryUnprotectMediaResource(leaseToken, out _, out _));
    Assert.IsFalse(fixture.Tokens.TryUnprotectMediaLease(resourceToken, out _, out _));
  }

  [TestMethod]
  public void MalformedTokensMapToSafeFailures()
  {
    using var fixture = new TokenFixture();
    const string malformed = "not+a+base64url+token";

    var planException = Assert.ThrowsExactly<PlaybackRequestException>(
        () => fixture.Tokens.UnprotectPlan(malformed, out _));
    var sessionException = Assert.ThrowsExactly<PlaybackRequestException>(
        () => fixture.Tokens.UnprotectSessionContext(malformed));

    AssertSafeFailure(planException, StatusCodes.Status410Gone, malformed);
    AssertSafeFailure(sessionException, StatusCodes.Status404NotFound, malformed);
    Assert.IsFalse(fixture.Tokens.TryUnprotectMediaLease(malformed, out _, out _));
    Assert.IsFalse(fixture.Tokens.TryUnprotectMediaResource(malformed, out _, out _));
  }

  [TestMethod]
  public void TamperedTokensMapToSafeFailures()
  {
    using var fixture = new TokenFixture();
    var token = fixture.Tokens.ProtectPlan("protected-plan-material", DateTimeOffset.UtcNow.AddMinutes(5));
    var tampered = TamperNonFinalCharacter(token);

    var exception = Assert.ThrowsExactly<PlaybackRequestException>(
        () => fixture.Tokens.UnprotectPlan(tampered, out _));

    AssertSafeFailure(exception, StatusCodes.Status410Gone, token);
  }

  [TestMethod]
  public void ExpiredTokensMapToSafeFailures()
  {
    using var fixture = new TokenFixture();
    var expiration = DateTimeOffset.UtcNow.AddMinutes(-1);
    var planToken = fixture.Tokens.ProtectPlan("expired-plan", expiration);
    var leaseToken = fixture.Tokens.ProtectMediaLease(
        new MediaLeasePayload("session", Guid.NewGuid(), "source", "api-key"),
        expiration);

    var exception = Assert.ThrowsExactly<PlaybackRequestException>(
        () => fixture.Tokens.UnprotectPlan(planToken, out _));

    AssertSafeFailure(exception, StatusCodes.Status410Gone, planToken);
    Assert.IsFalse(fixture.Tokens.TryUnprotectMediaLease(leaseToken, out _, out _));
  }

  private static void AssertSafeFailure(
      PlaybackRequestException exception,
      int expectedStatus,
      string protectedMaterial)
  {
    Assert.AreEqual(expectedStatus, exception.StatusCode);
    Assert.AreEqual("PLAYBACK_REQUEST_REJECTED", exception.Reason);
    Assert.AreEqual("The playback request was rejected.", exception.Message);
    Assert.IsFalse(exception.ToString().Contains(protectedMaterial, StringComparison.Ordinal));
  }

  private static string TamperNonFinalCharacter(string token)
  {
    var characters = token.ToCharArray();
    var index = Math.Min(4, characters.Length - 2);
    characters[index] = characters[index] == 'A' ? 'B' : 'A';
    return new string(characters);
  }

  private sealed class TokenFixture : IDisposable
  {
    private readonly DirectoryInfo _keyDirectory =
        Directory.CreateTempSubdirectory("nama-token-tests-");

    public TokenFixture()
    {
      Tokens = new PlaybackTokenService(DataProtectionProvider.Create(_keyDirectory));
    }

    public PlaybackTokenService Tokens { get; }

    public void Dispose()
    {
      _keyDirectory.Delete(recursive: true);
    }
  }
}
