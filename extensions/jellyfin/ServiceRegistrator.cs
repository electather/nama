using MediaBrowser.Controller;
using MediaBrowser.Controller.Plugins;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.DependencyInjection;

namespace Nama.Jellyfin.Extension;

public sealed class ServiceRegistrator : IPluginServiceRegistrator
{
  private const string DataProtectionApplicationName = "Nama.Jellyfin.Extension.v1";
  private static IServerApplicationPaths FindApplicationPaths(IServiceCollection serviceCollection)
  {
    var descriptor = serviceCollection.LastOrDefault(
        service => service.ServiceType == typeof(IServerApplicationPaths));
    return descriptor?.ImplementationInstance as IServerApplicationPaths
        ?? throw new InvalidOperationException(
            "The exact Jellyfin host did not register its application paths before plugins.");
  }


  public void RegisterServices(
      IServiceCollection serviceCollection,
      IServerApplicationHost applicationHost)
  {
    ArgumentNullException.ThrowIfNull(serviceCollection);
    ArgumentNullException.ThrowIfNull(applicationHost);

    var applicationPaths = FindApplicationPaths(serviceCollection);
    var keyRingDirectory = new DirectoryInfo(
        Path.Combine(applicationPaths.ProgramDataPath, "nama", "playback-keys-v1"));
    keyRingDirectory.Create();
    if (!OperatingSystem.IsWindows())
    {
      File.SetUnixFileMode(
          keyRingDirectory.FullName,
          UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
    }

    serviceCollection.AddSingleton(
        _ => new PlaybackTokenService(
            DataProtectionProvider.Create(
                keyRingDirectory,
                builder => builder.SetApplicationName(DataProtectionApplicationName))));
    serviceCollection.AddSingleton(new ExtensionHostCompatibility(applicationHost));
    serviceCollection.AddSingleton<PlaybackSessionStore>();
    serviceCollection.AddSingleton<PlaybackNegotiationService>();
    serviceCollection.AddSingleton<PlaybackRuntimeService>();
    serviceCollection.AddSingleton<ProgressRuntimeService>();
    serviceCollection.AddTransient<IStartupFilter, PlaybackStartupFilter>();
  }
}
