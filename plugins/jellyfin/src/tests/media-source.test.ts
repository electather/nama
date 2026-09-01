import { expect, it } from "vitest";

import { normalizeJellyfinSources } from "../media-source.ts";

const FIRST_INDEX = 0;
const LAST_INDEX = -1;
const MAXIMUM_NORMALIZED_TRACKS = 100;
const OVERFLOWING_SUPPORTED_STREAMS = 101;
const RAW_UNSUPPORTED_STREAMS = 108;
const LAST_RETAINED_TRACK_ID = "99";

const sourceWithStreams = (mediaStreams: readonly Readonly<Record<string, unknown>>[]) => ({
  Container: "mkv",
  Id: "source-1",
  MediaStreams: mediaStreams,
  Type: "Default",
});
const sourceContext = {
  itemId: "item-1",
  itemRuntime: undefined,
  locationType: "FileSystem",
} as const;

it("caps normalized tracks after filtering unsupported Jellyfin streams", () => {
  const unsupportedStreams = Array.from({ length: RAW_UNSUPPORTED_STREAMS }, () => ({
    Type: "Data",
  }));
  const sources = normalizeJellyfinSources([sourceWithStreams(unsupportedStreams)], sourceContext);
  expect(sources[FIRST_INDEX]?.parts[FIRST_INDEX]?.tracks).toEqual([]);

  const supportedStreams = Array.from(
    { length: OVERFLOWING_SUPPORTED_STREAMS },
    (_unusedValue, index) => ({
      Codec: "h264",
      Index: index,
      Type: "Video",
    }),
  );
  const boundedSources = normalizeJellyfinSources(
    [sourceWithStreams(supportedStreams)],
    sourceContext,
  );
  const tracks = boundedSources[FIRST_INDEX]?.parts[FIRST_INDEX]?.tracks;
  expect(tracks).toHaveLength(MAXIMUM_NORMALIZED_TRACKS);
  expect(tracks?.at(LAST_INDEX)?.trackReference?.trackId).toBe(LAST_RETAINED_TRACK_ID);
});
