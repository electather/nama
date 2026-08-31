import { PlaybackStrategy, TrackActionKind } from "@nama/api/nama/plugin/v1/playback_pb.js";
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
  readonly index: number;
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

const actionsMatchPlan = ({
  actions,
  defaultAudioIndex,
  defaultSubtitleIndex,
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
    tracks.every(({ index }) => actionByTrackId.has(String(index)))
  );
};

const validatePlanOutput = (validation: PlanOutputValidation): void => {
  if (!outputMatchesRequest(validation) || !actionsMatchPlan(validation)) {
    return invalidExtensionResponse();
  }
};

export { validatePlanOutput };
