import {
  PlaybackStrategy,
  PlaybackTrackType,
  SubtitleDeliveryMode,
  TrackActionKind,
} from "@nama/api/nama/plugin/v1/playback_pb.js";
import type {
  DeliveryProtocol,
  PlanPlaybackRequest,
} from "@nama/api/nama/plugin/v1/playback_pb.js";

import { invalidExtensionResponse } from "./extension-playback-values.ts";

const FIRST_ACTION_INDEX = 0;
const SINGLE_ACTION = 1;

interface ParsedPlanAction {
  readonly action: TrackActionKind;
  readonly trackReference:
    | {
        readonly trackId: string;
      }
    | undefined;
}

interface ParsedPlanTrack {
  readonly codec: string;
  readonly index: number;
  readonly type: PlaybackTrackType;
}

interface PlanOutputValidation {
  readonly actions: ParsedPlanAction[];
  readonly audioCodec: string;
  readonly container: string;
  readonly defaultAudioIndex: number;
  readonly defaultSubtitleIndex: number | undefined;
  readonly input: PlanPlaybackRequest;
  readonly protocol: DeliveryProtocol;
  readonly strategy: PlaybackStrategy;
  readonly tracks: ParsedPlanTrack[];
  readonly videoCodec: string;
}

interface SubtitleActionValidation {
  readonly actionByTrackId: ReadonlyMap<string | undefined, TrackActionKind>;
  readonly input: PlanPlaybackRequest;
  readonly strategy: PlaybackStrategy;
  readonly tracks: ParsedPlanTrack[];
}

type ActionValidation = Pick<
  PlanOutputValidation,
  "actions" | "defaultAudioIndex" | "defaultSubtitleIndex" | "tracks"
>;

const outputMatchesRequest = ({
  audioCodec,
  container,
  input,
  protocol,
  videoCodec,
}: PlanOutputValidation) =>
  input.capabilities?.protocols.includes(protocol) === true &&
  input.capabilities.directPlayProfiles.some(
    (profile) =>
      profile.container.toLowerCase() === container.toLowerCase() &&
      profile.videoCodec?.toLowerCase() === videoCodec.toLowerCase() &&
      profile.audioCodecs.some((codec) => codec.toLowerCase() === audioCodec.toLowerCase()),
  );

const selectedActions = ({
  actions,
  defaultAudioIndex,
  defaultSubtitleIndex,
  tracks,
}: ActionValidation) => {
  const trackIds = new Set(tracks.map(({ index }) => String(index)));
  const actionByTrackId = new Map(
    actions.map((action) => [action.trackReference?.trackId, action.action]),
  );
  const videoActions = actions.filter(
    ({ trackReference: reference }) => !trackIds.has(reference?.trackId ?? ""),
  );
  const audioAction = actionByTrackId.get(String(defaultAudioIndex));
  const subtitleAction = actionByTrackId.get(defaultSubtitleIndex?.toString());
  return { actionByTrackId, audioAction, subtitleAction, videoActions };
};

const expectedActions = (strategy: PlaybackStrategy, audioAction: TrackActionKind | undefined) => {
  let expectedVideoAction = TrackActionKind.COPY;
  if (strategy === PlaybackStrategy.TRANSCODE_VIDEO) {
    expectedVideoAction = TrackActionKind.TRANSCODE;
  }
  let validAudioAction = audioAction === TrackActionKind.COPY;
  if (strategy === PlaybackStrategy.TRANSCODE_AUDIO) {
    validAudioAction = audioAction === TrackActionKind.TRANSCODE;
  } else if (strategy === PlaybackStrategy.TRANSCODE_VIDEO) {
    validAudioAction ||= audioAction === TrackActionKind.TRANSCODE;
  }
  return { expectedVideoAction, validAudioAction };
};

const SUBTITLE_ACTION_MODES: Readonly<Partial<Record<TrackActionKind, SubtitleDeliveryMode>>> = {
  [TrackActionKind.BURN]: SubtitleDeliveryMode.BURNED_IN,
  [TrackActionKind.COPY]: SubtitleDeliveryMode.EMBEDDED,
  [TrackActionKind.EXTERNAL]: SubtitleDeliveryMode.EXTERNAL,
};

const subtitleActionsMatchCapabilities = ({
  actionByTrackId,
  input,
  strategy,
  tracks,
}: SubtitleActionValidation) =>
  tracks.every((track) => {
    if (track.type !== PlaybackTrackType.SUBTITLE) {
      return true;
    }
    const action = actionByTrackId.get(String(track.index));
    if (action === TrackActionKind.OMIT) {
      return true;
    }
    if (action === undefined) {
      return false;
    }
    const deliveryMode = SUBTITLE_ACTION_MODES[action];
    return (
      deliveryMode !== undefined &&
      (action !== TrackActionKind.BURN || strategy === PlaybackStrategy.TRANSCODE_VIDEO) &&
      input.capabilities?.subtitleCapabilities.some(
        (capability) =>
          capability.format.toLowerCase() === track.codec.toLowerCase() &&
          capability.deliveryModes.includes(deliveryMode),
      ) === true
    );
  });

const actionsMatchPlan = ({
  actions,
  defaultAudioIndex,
  defaultSubtitleIndex,
  input,
  strategy,
  tracks,
}: PlanOutputValidation) => {
  const { actionByTrackId, audioAction, subtitleAction, videoActions } = selectedActions({
    actions,
    defaultAudioIndex,
    defaultSubtitleIndex,
    tracks,
  });
  const { expectedVideoAction, validAudioAction } = expectedActions(strategy, audioAction);
  const videoAction = videoActions[FIRST_ACTION_INDEX]?.action;
  return (
    (actions.length === tracks.length || actions.length === tracks.length + SINGLE_ACTION) &&
    videoActions.length <= SINGLE_ACTION &&
    (videoAction === undefined || videoAction === expectedVideoAction) &&
    validAudioAction &&
    (subtitleAction === undefined || subtitleAction !== TrackActionKind.OMIT) &&
    subtitleActionsMatchCapabilities({ actionByTrackId, input, strategy, tracks }) &&
    tracks.every(({ index }) => actionByTrackId.has(String(index)))
  );
};

const validatePlanOutput = (validation: PlanOutputValidation): void => {
  if (!outputMatchesRequest(validation) || !actionsMatchPlan(validation)) {
    return invalidExtensionResponse();
  }
};

export { validatePlanOutput };
