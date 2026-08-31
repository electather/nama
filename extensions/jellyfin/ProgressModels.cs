using System.Text.Json.Serialization;

namespace Nama.Jellyfin.Extension;
internal enum ProgressTestFault
{
  None,
  Persistence,
  Readback,
}

#if NAMA_TEST_FAULTS
internal static class ProgressTestFaultHeader
{
  public const string Name = "x-nama-test-progress-fault";

  public static ProgressTestFault Parse(string value)
  {
    return value switch
    {
      "persistence" => ProgressTestFault.Persistence,
      "readback" => ProgressTestFault.Readback,
      _ => ProgressTestFault.None,
    };
  }
}
#endif


internal sealed record SetProgressInput(
    [property: JsonPropertyName("item_id")] string? ItemId,
    [property: JsonPropertyName("user_id")] string? UserId,
    [property: JsonPropertyName("watched")] bool? Watched,
    [property: JsonPropertyName("position")] DurationInput? Position,
    [property: JsonPropertyName("duration")] DurationInput? Duration);

internal sealed record ProgressDurationOutput(
    [property: JsonPropertyName("seconds")] string Seconds,
    [property: JsonPropertyName("nanos")] int Nanos);

internal sealed record SetProgressOutput(
    [property: JsonPropertyName("item_id")] string ItemId,
    [property: JsonPropertyName("watched")] bool Watched,
    [property: JsonPropertyName("position")] ProgressDurationOutput Position,
    [property: JsonPropertyName("duration")] ProgressDurationOutput Duration,
    [property: JsonPropertyName("status")] string Status);
