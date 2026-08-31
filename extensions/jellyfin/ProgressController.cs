using System.Text.Json;
using MediaBrowser.Controller.Net;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.DependencyInjection;

namespace Nama.Jellyfin.Extension;

[ApiController]
[Authorize]
[Route("Nama/v1/progress")]
public sealed class ProgressController : ControllerBase
{
  private readonly ProgressRuntimeService _runtime;
  private readonly IAuthService _authService;

  public ProgressController(IServiceProvider services)
  {
    ArgumentNullException.ThrowIfNull(services);
    _runtime = services.GetRequiredService<ProgressRuntimeService>();
    _authService = services.GetRequiredService<IAuthService>();
  }

  [HttpPost]
  public async Task<IActionResult> Set(JsonElement body, CancellationToken cancellationToken)
  {
    if (!(await _authService.Authenticate(Request).ConfigureAwait(false)).IsApiKey)
    {
      return Forbid();
    }

    try
    {
#if NAMA_TEST_FAULTS
      var testFault = ProgressTestFaultHeader.Parse(
          Request.Headers[ProgressTestFaultHeader.Name].ToString());
#else
      var testFault = ProgressTestFault.None;
#endif
      return Ok(_runtime.Set(body, cancellationToken, testFault));
    }
    catch (PlaybackRequestException exception)
    {
      return StatusCode(exception.StatusCode, new { reason = exception.Reason });
    }
  }
}
