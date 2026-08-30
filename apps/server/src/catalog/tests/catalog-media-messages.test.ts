import { expect, it } from "vitest";

import type { StoredCatalogItem } from "../../database/catalog-persistence-model-private.ts";
import { detailsMessage } from "../catalog-media-messages.ts";

const storedMovie = (): StoredCatalogItem => ({
  artwork: [],
  credits: [],
  genres: [],
  id: "movie",
  kind: "movie",
  parents: [],
  runtime: { nanoseconds: 0, seconds: 0n },
  sources: [],
  studios: [],
  title: "Movie",
});

it("maps media details without page-cursor metadata", () => {
  const details = detailsMessage(storedMovie());

  expect(details.summary).toMatchObject({ id: "movie", title: "Movie" });
});
