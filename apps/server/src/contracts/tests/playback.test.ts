import { create } from "@bufbuild/protobuf";
import { createValidator } from "@bufbuild/protovalidate";
import {
  PlaybackPreferencesSchema as PublicPlaybackPreferencesSchema,
  PlaybackQuality as PublicPlaybackQuality,
  SubtitlePreference as PublicSubtitlePreference,
} from "@nama/api/nama/api/v1/playback_pb.js";
import {
  PlaybackPreferencesSchema as PluginPlaybackPreferencesSchema,
  PlaybackQuality as PluginPlaybackQuality,
  SubtitlePreference as PluginSubtitlePreference,
} from "@nama/api/nama/plugin/v1/playback_pb.js";
import { expect, test } from "vitest";

const POSITIVE_BIT_RATE = 1n;
const ZERO_BIT_RATE = 0n;

const playbackContracts = [
  {
    automatic: PublicPlaybackQuality.AUTO,
    capped: PublicPlaybackQuality.CAPPED,
    original: PublicPlaybackQuality.ORIGINAL,
    schema: PublicPlaybackPreferencesSchema,
    subtitleAuto: PublicSubtitlePreference.AUTO,
    title: "public",
  },
  {
    automatic: PluginPlaybackQuality.AUTO,
    capped: PluginPlaybackQuality.CAPPED,
    original: PluginPlaybackQuality.ORIGINAL,
    schema: PluginPlaybackPreferencesSchema,
    subtitleAuto: PluginSubtitlePreference.AUTO,
    title: "plugin",
  },
] as const;

test.each(playbackContracts)(
  "$title playback preferences require a positive bit rate when CAPPED",
  ({ capped, schema, subtitleAuto }) => {
    const validator = createValidator();
    expect(
      validator.validate(
        schema,
        create(schema, {
          maxBitRateBps: POSITIVE_BIT_RATE,
          quality: capped,
          subtitlePreference: subtitleAuto,
        }),
      ).kind,
    ).toBe("valid");
    expect(
      validator.validate(
        schema,
        create(schema, { quality: capped, subtitlePreference: subtitleAuto }),
      ).kind,
    ).toBe("invalid");
    expect(
      validator.validate(
        schema,
        create(schema, {
          maxBitRateBps: ZERO_BIT_RATE,
          quality: capped,
          subtitlePreference: subtitleAuto,
        }),
      ).kind,
    ).toBe("invalid");
  },
);

test.each(playbackContracts)(
  "$title playback preferences reject a bit rate unless CAPPED",
  ({ automatic, original, schema, subtitleAuto }) => {
    const validator = createValidator();
    expect(
      validator.validate(
        schema,
        create(schema, {
          maxBitRateBps: POSITIVE_BIT_RATE,
          quality: automatic,
          subtitlePreference: subtitleAuto,
        }),
      ).kind,
    ).toBe("invalid");
    expect(
      validator.validate(
        schema,
        create(schema, {
          maxBitRateBps: POSITIVE_BIT_RATE,
          quality: original,
          subtitlePreference: subtitleAuto,
        }),
      ).kind,
    ).toBe("invalid");
    expect(
      validator.validate(
        schema,
        create(schema, { quality: automatic, subtitlePreference: subtitleAuto }),
      ).kind,
    ).toBe("valid");
    expect(
      validator.validate(
        schema,
        create(schema, { quality: original, subtitlePreference: subtitleAuto }),
      ).kind,
    ).toBe("valid");
  },
);
