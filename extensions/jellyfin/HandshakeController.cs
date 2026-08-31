using System.Text.Json.Serialization;
using MediaBrowser.Controller.Net;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;

namespace Nama.Jellyfin.Extension;

[ApiController]
[Authorize]
[Route("Nama/v1")]
public sealed class HandshakeController : ControllerBase
{
  private static readonly string[] Capabilities = ["direct_progressive", "playback_telemetry"];
  private readonly ExtensionHostCompatibility _compatibility;
  private readonly IAuthService _authService;

  public HandshakeController(
      ExtensionHostCompatibility compatibility,
      IAuthService authService)
  {
    _compatibility = compatibility;
    _authService = authService;
  }

  [HttpGet("handshake")]
  [ProducesResponseType<HandshakeResponse>(StatusCodes.Status200OK)]
  [ProducesResponseType(StatusCodes.Status503ServiceUnavailable)]
  [ProducesResponseType(StatusCodes.Status403Forbidden)]
  public async Task<ActionResult<HandshakeResponse>> GetHandshake()
  {
    if (!(await _authService.Authenticate(Request).ConfigureAwait(false)).IsApiKey)
    {
      return Forbid();
    }
    if (!_compatibility.IsCompatible)
    {
      return StatusCode(StatusCodes.Status503ServiceUnavailable);
    }

    return new HandshakeResponse(
        Capabilities,
        "1.0.0",
        "nama.jellyfin.extension",
        1);
  }
}

public sealed record HandshakeResponse(
    [property: JsonPropertyName("capabilities")] IReadOnlyList<string> Capabilities,
    [property: JsonPropertyName("extension_version")] string ExtensionVersion,
    [property: JsonPropertyName("protocol")] string Protocol,
    [property: JsonPropertyName("protocol_version")] int ProtocolVersion);
