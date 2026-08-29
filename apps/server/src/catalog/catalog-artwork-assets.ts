import { Effect } from "effect";

import type {
  CatalogArtworkObservation,
  CatalogCreditObservation,
  CatalogItemObservation,
  CatalogProviderArtworkReference,
} from "../database/catalog-persistence-model-private.ts";
import type { LoadArtworkAsset } from "./catalog-artwork-asset-fetch.ts";
import type { CatalogPluginPage } from "./catalog-item-mapper.ts";

const ARTWORK_FETCH_CONCURRENCY = 4;
const SERIAL_CONCURRENCY = 1;
const MAXIMUM_ARTWORK_DIMENSION = 1920;

interface ArtworkHydrationContext {
  readonly loadArtworkAsset: LoadArtworkAsset;
  readonly now: number;
  readonly providerInstanceId: string;
  readonly revision: string;
}
interface CatalogArtworkHydrationInput {
  readonly loadArtworkAsset: LoadArtworkAsset;
  readonly now: number;
  readonly page: CatalogPluginPage;
  readonly revision: string;
}

const hydrateArtwork = (
  context: ArtworkHydrationContext,
  itemReference: string,
  artwork: CatalogArtworkObservation,
) =>
  context
    .loadArtworkAsset({
      artworkReference: artwork.artworkReference,
      itemReference,
      maxHeight: MAXIMUM_ARTWORK_DIMENSION,
      maxWidth: MAXIMUM_ARTWORK_DIMENSION,
      now: context.now,
      providerInstanceId: context.providerInstanceId,
      revision: context.revision,
    })
    .pipe(Effect.map((asset) => ({ ...artwork, asset })));

const hydratePortrait = (
  context: ArtworkHydrationContext,
  reference: CatalogProviderArtworkReference,
) =>
  context
    .loadArtworkAsset({
      artworkReference: reference.artworkReference,
      itemReference: reference.itemReference,
      maxHeight: MAXIMUM_ARTWORK_DIMENSION,
      maxWidth: MAXIMUM_ARTWORK_DIMENSION,
      now: context.now,
      providerInstanceId: context.providerInstanceId,
      revision: context.revision,
    })
    .pipe(Effect.map((asset) => ({ ...reference, asset })));

const hydrateCredit = (context: ArtworkHydrationContext, credit: CatalogCreditObservation) => {
  if (credit.portraitArtworkReference === undefined) {
    return Effect.succeed(credit);
  }
  return hydratePortrait(context, credit.portraitArtworkReference).pipe(
    Effect.map((portraitArtworkReference) => ({ ...credit, portraitArtworkReference })),
  );
};

const hydrateItemArtwork = (
  context: Omit<ArtworkHydrationContext, "providerInstanceId">,
  item: CatalogItemObservation,
): Effect.Effect<CatalogItemObservation> => {
  const itemContext = {
    ...context,
    providerInstanceId: item.providerInstanceId,
  };
  return Effect.gen(function* hydrateItemArtworkAssets() {
    const artwork = yield* Effect.forEach(
      item.artwork,
      (entry) => hydrateArtwork(itemContext, item.itemReference, entry),
      { concurrency: ARTWORK_FETCH_CONCURRENCY },
    );
    const credits = yield* Effect.forEach(
      item.credits,
      (credit) => hydrateCredit(itemContext, credit),
      { concurrency: ARTWORK_FETCH_CONCURRENCY },
    );
    return { ...item, artwork, credits };
  });
};

const hydrateCatalogArtwork = ({
  loadArtworkAsset,
  now,
  page,
  revision,
}: CatalogArtworkHydrationInput): Effect.Effect<CatalogPluginPage> => {
  const context = { loadArtworkAsset, now, revision };
  return Effect.forEach(page.items, (item) => hydrateItemArtwork(context, item), {
    concurrency: SERIAL_CONCURRENCY,
  }).pipe(Effect.flatMap((items) => Effect.succeed({ ...page, items })));
};

export type { CatalogArtworkHydrationInput };
export { hydrateCatalogArtwork };
