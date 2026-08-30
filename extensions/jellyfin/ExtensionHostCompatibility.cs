using MediaBrowser.Controller;
using MediaBrowser.Model.Dto;

namespace Nama.Jellyfin.Extension;

public sealed class ExtensionHostCompatibility
{
  private static readonly Version SupportedVersion = new(10, 11, 11, 0);

  public ExtensionHostCompatibility(IServerApplicationHost applicationHost)
  {
    ArgumentNullException.ThrowIfNull(applicationHost);

    var hostType = applicationHost.GetType();
    var hostBaseType = hostType.BaseType;
    IsCompatible = applicationHost.ApplicationVersion == SupportedVersion
        && typeof(IServerApplicationHost).Assembly.GetName().Version == SupportedVersion
        && typeof(MediaSourceInfo).Assembly.GetName().Version == SupportedVersion
        && hostType.FullName == "Jellyfin.Server.CoreAppHost"
        && hostType.Assembly.GetName().Version == SupportedVersion
        && hostBaseType?.FullName == "Emby.Server.Implementations.ApplicationHost"
        && hostBaseType.Assembly.GetName().Version == SupportedVersion;
  }

  public bool IsCompatible { get; }
}
