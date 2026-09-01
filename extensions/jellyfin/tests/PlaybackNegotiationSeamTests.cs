using Microsoft.AspNetCore.Http;
using Microsoft.VisualStudio.TestTools.UnitTesting;

namespace Nama.Jellyfin.Extension.Tests;

[TestClass]
public sealed class PlaybackNegotiationSeamTests
{
  [TestMethod]
  public async Task OpenRejectsAudioSelectionFromSubtitleTrack()
  {
    var plan = CreateSelectionPlan();
    var request = new PlaybackOpenRequest(
        "wrong-type-operation",
        "wrong-type-plan",
        2,
        true,
        null);

    var exception = await Assert.ThrowsExactlyAsync<PlaybackRequestException>(async () =>
    {
      await new PlaybackSessionStore().OpenAsync(
          request,
          () => plan,
          _ => throw new AssertFailedException("invalid selection created a session"));
    });

    Assert.AreEqual(StatusCodes.Status412PreconditionFailed, exception.StatusCode);
    Assert.AreEqual("TRACK_SELECTION_REQUIRES_REPLAN", exception.Reason);
  }

  [TestMethod]
  public async Task OpenRejectsSubtitleAbsentFromPlan()
  {
    var plan = CreateSelectionPlan();
    var request = new PlaybackOpenRequest(
        "missing-track-operation",
        "missing-track-plan",
        1,
        false,
        99);

    var exception = await Assert.ThrowsExactlyAsync<PlaybackRequestException>(async () =>
    {
      await new PlaybackSessionStore().OpenAsync(
          request,
          () => plan,
          _ => throw new AssertFailedException("invalid selection created a session"));
    });

    Assert.AreEqual(StatusCodes.Status412PreconditionFailed, exception.StatusCode);
    Assert.AreEqual("TRACK_SELECTION_REQUIRES_REPLAN", exception.Reason);
  }

  [TestMethod]
  [DataRow("always")]
  [DataRow("forced_only")]
  [DataRow("auto")]
  public void SubtitleFallbackRespectsHardCapabilities(string preference)
  {
    IReadOnlyList<SubtitleCandidate> candidates =
    [
      new SubtitleCandidate(3, "ass", "eng", false, true),
      new SubtitleCandidate(4, "srt", "fra", false, true)
    ];
    IReadOnlyList<SubtitleCapabilityInput> capabilities =
    [
      new SubtitleCapabilityInput("srt", ["embedded"])
    ];

    var selected = PlaybackSubtitleSelector.Select(
        candidates,
        -1,
        preference,
        ["eng"],
        capabilities);

    Assert.AreEqual(4, selected);
  }

  [TestMethod]
  public void EmptyDynamicRangeCapabilitiesAreRejected()
  {
    var exception = Assert.ThrowsExactly<PlaybackRequestException>(() =>
        PlaybackCapabilityValidator.Validate(
            new PlaybackCapabilitiesInput([], ["http_progressive"], [], null, null, null, null, [])));

    Assert.AreEqual(StatusCodes.Status412PreconditionFailed, exception.StatusCode);
    Assert.AreEqual("DYNAMIC_RANGE_UNSUPPORTED", exception.Reason);
  }

  private static PlaybackPlan CreateSelectionPlan()
  {
    return new PlaybackPlan(
        "selection-plan",
        Guid.NewGuid(),
        "selection-source",
        Guid.NewGuid(),
        TimeSpan.TicksPerMinute,
        0,
        null!,
        null!,
        [
          new PlaybackTrackModel(1, "audio", "aac", 2, true, false, null, null, null),
          new PlaybackTrackModel(2, "subtitle", "srt", null, false, false, null, null, "text")
        ]);
  }
}
