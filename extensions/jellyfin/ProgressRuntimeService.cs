using System.Globalization;
using System.Text.Json;
using Jellyfin.Data;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Database.Implementations.Enums;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Entities;
using Microsoft.AspNetCore.Http;

namespace Nama.Jellyfin.Extension;

internal sealed class ProgressRuntimeService
{
  private const int NanosecondsPerJellyfinTick = 100;
  private const int NanosecondsPerSecond = 1_000_000_000;
  private const string AlreadyAppliedStatus = "already_applied";
  private const string AppliedStatus = "applied";
  private readonly ExtensionHostCompatibility _compatibility;
  private readonly ILibraryManager _libraryManager;
  private readonly IUserDataManager _userDataManager;
  private readonly IUserManager _userManager;

  public ProgressRuntimeService(
      ExtensionHostCompatibility compatibility,
      ILibraryManager libraryManager,
      IUserDataManager userDataManager,
      IUserManager userManager)
  {
    _compatibility = compatibility;
    _libraryManager = libraryManager;
    _userDataManager = userDataManager;
    _userManager = userManager;
  }

  public SetProgressOutput Set(
      JsonElement body,
      CancellationToken cancellationToken,
      ProgressTestFault testFault = ProgressTestFault.None)
  {
    if (!_compatibility.IsCompatible)
    {
      throw new PlaybackRequestException(StatusCodes.Status503ServiceUnavailable);
    }

    var input = Deserialize(body);
    var itemIdText = input.ItemId
        ?? throw new PlaybackRequestException(StatusCodes.Status400BadRequest);
    var itemId = RequiredGuid(itemIdText);
    var userId = RequiredGuid(input.UserId);
    if (!input.Watched.HasValue)
    {
      throw new PlaybackRequestException(StatusCodes.Status400BadRequest);
    }

    var user = _userManager.GetUserById(userId)
        ?? throw new PlaybackRequestException(StatusCodes.Status404NotFound);
    if (user.HasPermission(PermissionKind.IsDisabled))
    {
      throw new PlaybackRequestException(StatusCodes.Status403Forbidden);
    }

    var unscopedItem = _libraryManager.GetItemById<BaseItem>(itemId);
    if (unscopedItem is not Movie && unscopedItem is not Episode)
    {
      throw new PlaybackRequestException(StatusCodes.Status404NotFound);
    }
    var item = _libraryManager.GetItemById<BaseItem>(itemId, user)
        ?? throw new PlaybackRequestException(StatusCodes.Status403Forbidden);
    var runtimeTicks = RequiredRuntime(item);
    var positionTicks = DurationTicks(input.Position, runtimeTicks);
    ValidateDuration(input.Duration, runtimeTicks);

    cancellationToken.ThrowIfCancellationRequested();
    var current = _userDataManager.GetUserData(user, item)
        ?? throw new InvalidOperationException("Jellyfin user data was unavailable.");
    var alreadyApplied = current.Played == input.Watched.Value
        && current.PlaybackPositionTicks == positionTicks;
    if (!alreadyApplied)
    {
#if NAMA_TEST_FAULTS
      if (testFault == ProgressTestFault.Persistence)
      {
        throw new InvalidOperationException("Injected progress persistence failure.");
      }
#endif
      var target = CopyWithTarget(current, input.Watched.Value, positionTicks);
      _userDataManager.SaveUserData(
          user,
          item,
          target,
          UserDataSaveReason.UpdateUserData,
          cancellationToken);
    }

    if (alreadyApplied)
    {
      return ReadBack(user, itemId, itemIdText, true, cancellationToken);
    }

    try
    {
#if NAMA_TEST_FAULTS
      if (testFault == ProgressTestFault.Readback)
      {
        throw new InvalidOperationException("Injected progress readback failure.");
      }
#endif
      return ReadBack(user, itemId, itemIdText, false, cancellationToken);
    }
    catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
    {
      throw;
    }
    catch (Exception)
    {
      throw new PlaybackRequestException(
          StatusCodes.Status503ServiceUnavailable,
          "PROGRESS_READBACK_AMBIGUOUS");
    }
  }
  private SetProgressOutput ReadBack(
      User user,
      Guid itemId,
      string itemIdText,
      bool alreadyApplied,
      CancellationToken cancellationToken)
  {
    cancellationToken.ThrowIfCancellationRequested();
    var observedItem = _libraryManager.GetItemById<BaseItem>(itemId, user)
        ?? throw new PlaybackRequestException(StatusCodes.Status403Forbidden);
    var observedRuntimeTicks = RequiredRuntime(observedItem);
    var observed = _userDataManager.GetUserData(user, observedItem)
        ?? throw new InvalidOperationException("Jellyfin user data readback was unavailable.");
    return new SetProgressOutput(
        itemIdText,
        observed.Played,
        DurationOutput(observed.PlaybackPositionTicks),
        DurationOutput(observedRuntimeTicks),
        alreadyApplied ? AlreadyAppliedStatus : AppliedStatus);
  }


  private static UserItemData CopyWithTarget(
      UserItemData current,
      bool watched,
      long positionTicks)
  {
    return new UserItemData
    {
      AudioStreamIndex = current.AudioStreamIndex,
      IsFavorite = current.IsFavorite,
      Key = current.Key,
      LastPlayedDate = current.LastPlayedDate,
      Likes = current.Likes,
      PlaybackPositionTicks = positionTicks,
      PlayCount = current.PlayCount,
      Played = watched,
      Rating = current.Rating,
      SubtitleStreamIndex = current.SubtitleStreamIndex,
    };
  }

  private static SetProgressInput Deserialize(JsonElement body)
  {
    try
    {
      return body.Deserialize<SetProgressInput>()
          ?? throw new PlaybackRequestException(StatusCodes.Status400BadRequest);
    }
    catch (JsonException)
    {
      throw new PlaybackRequestException(StatusCodes.Status400BadRequest);
    }
  }

  private static Guid RequiredGuid(string? value)
  {
    if (!Guid.TryParse(value, out var parsed))
    {
      throw new PlaybackRequestException(StatusCodes.Status400BadRequest);
    }
    return parsed;
  }

  private static long RequiredRuntime(BaseItem item)
  {
    if (item.RunTimeTicks is not > 0)
    {
      throw new PlaybackRequestException(StatusCodes.Status400BadRequest);
    }
    return item.RunTimeTicks.Value;
  }

  private static long DurationTicks(DurationInput? input, long maximumTicks)
  {
    if (input is null
        || !long.TryParse(input.Seconds, NumberStyles.None, CultureInfo.InvariantCulture, out var seconds)
        || seconds < 0
        || input.Nanos is < 0 or >= NanosecondsPerSecond
        || input.Nanos % NanosecondsPerJellyfinTick != 0)
    {
      throw new PlaybackRequestException(StatusCodes.Status400BadRequest);
    }

    try
    {
      var ticks = checked(
          (seconds * PlaybackConstants.JellyfinTicksPerSecond)
          + (input.Nanos / NanosecondsPerJellyfinTick));
      if (ticks > maximumTicks)
      {
        throw new PlaybackRequestException(StatusCodes.Status400BadRequest);
      }
      return ticks;
    }
    catch (OverflowException)
    {
      throw new PlaybackRequestException(StatusCodes.Status400BadRequest);
    }
  }

  private static void ValidateDuration(DurationInput? input, long expectedTicks)
  {
    if (input is not null && DurationTicks(input, expectedTicks) != expectedTicks)
    {
      throw new PlaybackRequestException(StatusCodes.Status400BadRequest);
    }
  }

  private static ProgressDurationOutput DurationOutput(long ticks)
  {
    var seconds = ticks / PlaybackConstants.JellyfinTicksPerSecond;
    var nanos = checked((int)(ticks % PlaybackConstants.JellyfinTicksPerSecond)
        * NanosecondsPerJellyfinTick);
    return new ProgressDurationOutput(
        seconds.ToString(CultureInfo.InvariantCulture),
        nanos);
  }
}
