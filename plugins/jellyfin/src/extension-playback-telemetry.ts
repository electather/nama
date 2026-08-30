import { Code, ConnectError } from "@connectrpc/connect";
import { PlaybackCloseReason, PlaybackState } from "@nama/api/nama/plugin/v1/playback_pb.js";
import type {
  ClosePlaybackRequest,
  ReportPlaybackRequest,
} from "@nama/api/nama/plugin/v1/playback_pb.js";

import { extensionRequest, postExtension } from "./extension-playback-client.ts";
import { durationBody, trackIndex } from "./extension-playback-values.ts";
import type { ProviderLaunchDocument } from "./launch-document.ts";

const stateName = (state: PlaybackState): string => {
  if (state === PlaybackState.PLAYING) {
    return "playing";
  }
  if (state === PlaybackState.PAUSED) {
    return "paused";
  }
  if (state === PlaybackState.BUFFERING) {
    return "buffering";
  }
  throw new ConnectError("playback state is invalid", Code.InvalidArgument);
};

const closeReasonName = (reason: PlaybackCloseReason): string => {
  if (reason === PlaybackCloseReason.STOPPED) {
    return "stopped";
  }
  if (reason === PlaybackCloseReason.COMPLETED) {
    return "completed";
  }
  if (reason === PlaybackCloseReason.FAILED) {
    return "failed";
  }
  if (reason === PlaybackCloseReason.CANCELLED) {
    return "cancelled";
  }
  throw new ConnectError("playback close reason is invalid", Code.InvalidArgument);
};

const reportJellyfinPlayback = async (
  launch: ProviderLaunchDocument,
  input: ReportPlaybackRequest,
  signal: AbortSignal,
) => {
  const request = extensionRequest(launch);
  await postExtension({
    body: {
      duration: durationBody(input.duration),
      event_id: input.eventId,
      position: durationBody(input.position),
      selected_audio_track_index: trackIndex(input.selectedAudioTrackReference),
      selected_subtitle_track_index: trackIndex(input.selectedSubtitleTrackReference),
      sequence: input.sequence.toString(),
      session_context: Buffer.from(input.sessionContext).toString("base64url"),
      state: stateName(input.state),
    },
    path: ["sessions", input.sessionId, "reports"],
    request,
    signal,
  });
  return { $typeName: "nama.plugin.v1.ReportPlaybackResponse" as const };
};

const closeJellyfinPlayback = async (
  launch: ProviderLaunchDocument,
  input: ClosePlaybackRequest,
  signal: AbortSignal,
) => {
  const request = extensionRequest(launch);
  await postExtension({
    body: {
      duration: durationBody(input.duration),
      final_position: durationBody(input.finalPosition),
      operation_id: input.operationId,
      reason: closeReasonName(input.reason),
      session_context: Buffer.from(input.sessionContext).toString("base64url"),
    },
    path: ["sessions", input.sessionId, "close"],
    request,
    signal,
  });
  return { $typeName: "nama.plugin.v1.ClosePlaybackResponse" as const };
};

export { closeJellyfinPlayback, reportJellyfinPlayback };
