import assert from "node:assert/strict";
import { it } from "node:test";

import { SourceAvailability } from "@nama/api/nama/plugin/v1/media_pb.js";

import { normalizeJellyfinMovie } from "../movie.ts";

const ITEM_ID = "offline-movie";
const SOURCE_ID = "offline-source";
const EXPECTED_SOURCE_COUNT = 1;
const EXPECTED_PART_COUNT = 1;

void it("preserves unavailable sources without video tracks", () => {
  const item = normalizeJellyfinMovie(
    {
      Id: ITEM_ID,
      LocationType: "Offline",
      MediaSources: [
        {
          Container: "mkv",
          Id: SOURCE_ID,
          MediaStreams: [],
          Type: "Default",
        },
      ],
      Name: "Offline movie",
      PlayAccess: "Full",
      Type: "Movie",
    },
    ITEM_ID,
  );

  assert.equal(item.sources.length, EXPECTED_SOURCE_COUNT);
  const [source] = item.sources;
  assert.ok(source);
  assert.equal(source.availability, SourceAvailability.PROVIDER_UNAVAILABLE);
  assert.deepEqual(source.sourceReference, {
    itemReference: { itemId: ITEM_ID },
    sourceId: SOURCE_ID,
  });
  assert.equal(source.parts.length, EXPECTED_PART_COUNT);
  const [part] = source.parts;
  assert.ok(part);
  assert.deepEqual(part.tracks, []);
});
