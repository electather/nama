namespace Nama.Jellyfin.Extension.Tests;

internal sealed class ManualTimeProvider(DateTimeOffset utcNow) : TimeProvider
{
  private DateTimeOffset _utcNow = utcNow;

  public override DateTimeOffset GetUtcNow()
  {
    return _utcNow;
  }

  public void Advance(TimeSpan elapsed)
  {
    _utcNow += elapsed;
  }
}
