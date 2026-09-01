using System.Text.Json;
using MediaBrowser.Controller.Net;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.DependencyInjection;

namespace Nama.Jellyfin.Extension;

[ApiController]
[Authorize]
[Route("Nama/v1/playback")]
public sealed class PlaybackController : ControllerBase
{
  private readonly PlaybackRuntimeService _runtime;
#if NAMA_TEST_FAULTS
  private const string OpenSourceChangeHeader = "x-nama-test-open-source-change";
#endif
  private readonly IAuthService _authService;

  public PlaybackController(IServiceProvider services)
  {
    ArgumentNullException.ThrowIfNull(services);
    _runtime = services.GetRequiredService<PlaybackRuntimeService>();
    _authService = services.GetRequiredService<IAuthService>();
  }

  private async Task<bool> HasApiKeyAsync()
  {
    return (await _authService.Authenticate(Request).ConfigureAwait(false)).IsApiKey;
  }

  [HttpPost("plans")]
  public async Task<IActionResult> Plan(JsonElement body, CancellationToken cancellationToken)
  {
    if (!await HasApiKeyAsync().ConfigureAwait(false))
    {
      return Forbid();
    }

    try
    {
      return Ok(await _runtime.PlanAsync(body, cancellationToken).ConfigureAwait(false));
    }
    catch (PlaybackRequestException exception)
    {
      return StatusCode(exception.StatusCode, new { reason = exception.Reason });
    }
  }

  [HttpPost("sessions")]
  public async Task<IActionResult> Open(JsonElement body, CancellationToken cancellationToken)
  {
    if (!await HasApiKeyAsync().ConfigureAwait(false))
    {
      return Forbid();
    }
#if NAMA_TEST_FAULTS
    var testSourceChange = Request.Headers[OpenSourceChangeHeader].ToString();
#else
    string? testSourceChange = null;
#endif

    try
    {
      return Ok(await _runtime.OpenAsync(
          body,
          Request.Headers.Authorization,
          cancellationToken,
          testSourceChange).ConfigureAwait(false));
    }
    catch (PlaybackRequestException exception)
    {
      return StatusCode(exception.StatusCode, new { reason = exception.Reason });
    }
  }

  [HttpPost("sessions/{sessionId}/reports")]
  public async Task<IActionResult> Report(
      [FromRoute] string sessionId,
      JsonElement body,
      CancellationToken cancellationToken)
  {
    if (!await HasApiKeyAsync().ConfigureAwait(false))
    {
      return Forbid();
    }

    try
    {
      await _runtime.ReportAsync(sessionId, body, cancellationToken).ConfigureAwait(false);
      return Ok(new { });
    }
    catch (PlaybackRequestException exception)
    {
      return StatusCode(exception.StatusCode, new { reason = exception.Reason });
    }
  }

  [HttpPost("sessions/{sessionId}/close")]
  public async Task<IActionResult> Close(
      [FromRoute] string sessionId,
      JsonElement body,
      CancellationToken cancellationToken)
  {
    if (!await HasApiKeyAsync().ConfigureAwait(false))
    {
      return Forbid();
    }

    try
    {
      await _runtime.CloseAsync(sessionId, body, cancellationToken).ConfigureAwait(false);
      return Ok(new { });
    }
    catch (PlaybackRequestException exception)
    {
      return StatusCode(exception.StatusCode, new { reason = exception.Reason });
    }
  }
}
