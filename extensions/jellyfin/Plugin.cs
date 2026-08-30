using MediaBrowser.Common.Configuration;
using MediaBrowser.Common.Plugins;

namespace Nama.Jellyfin.Extension;

public sealed class Plugin : BasePlugin
{
  private static readonly Guid PluginId = new("e4d60914-192f-4e64-9d57-b3ca9f617844");

  public Plugin(IApplicationPaths applicationPaths)
  {
    ArgumentNullException.ThrowIfNull(applicationPaths);

    var assembly = GetType().Assembly;
    var assemblyPath = assembly.Location;
    var assemblyVersion = assembly.GetName().Version
        ?? throw new InvalidOperationException("The extension assembly version is unavailable.");
    SetAttributes(
        assemblyPath,
        Path.Combine(
            applicationPaths.PluginsPath,
            Path.GetFileNameWithoutExtension(assemblyPath)),
        assemblyVersion);
    SetId(PluginId);
  }

  public override string Name => "Nama Playback Extension";

  public override string Description =>
      "Provides versioned scoped playback leases for Nama through Jellyfin.";

}
