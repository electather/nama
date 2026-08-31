using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;

namespace Nama.Jellyfin.Extension;

internal sealed class PlaybackStartupFilter : IStartupFilter
{
  public Action<IApplicationBuilder> Configure(Action<IApplicationBuilder> next)
  {
    ArgumentNullException.ThrowIfNull(next);

    return application =>
    {
      application.UseMiddleware<PlaybackLeaseMiddleware>();
      next(application);
    };
  }
}
