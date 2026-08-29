import { sql } from "drizzle-orm";

import { canonicalArtwork } from "./catalog-artwork-schema.ts";
import { canonicalItem, libraryEntry } from "./catalog-item-schema.ts";
import { mediaPart, mediaSource } from "./catalog-source-schema.ts";
import type { StoredArtworkJson, StoredSourceJson } from "./catalog-summary-model-private.ts";
import { mediaTrack } from "./catalog-track-schema.ts";
import { providerInstance, providerInstanceObservation } from "./provider-schema.ts";

const artworkSelection = sql<readonly StoredArtworkJson[]>`
  coalesce((
    select jsonb_agg(
      jsonb_build_object(
        'height', stored_artwork.height,
        'id', stored_artwork.id,
        'locale', stored_artwork.locale,
        'role', stored_artwork.role,
        'textPresence', stored_artwork.text_presence,
        'width', stored_artwork.width
      )
      order by stored_artwork.display_order
    )
    from ${canonicalArtwork} as stored_artwork
    where stored_artwork.canonical_item_id = ${canonicalItem.id}
  ), '[]'::jsonb)
`.as("artwork");

const effectiveAvailability = sql`
  case
    when stored_source.availability = 'unsupported' then 'unsupported'
    when stored_source.availability = 'provider_unavailable' then 'provider_unavailable'
    when owning_provider.enabled
      and provider_observation.status = 'healthy'
      and provider_observation.instance_revision = owning_provider.revision
      then 'available'
    else 'provider_unavailable'
  end
`;

const sourcesSelection = sql<readonly StoredSourceJson[]>`
  coalesce((
    select jsonb_agg(
      jsonb_build_object(
        'audioQuality', (
          select jsonb_build_object(
            'channelCount', default_audio.channel_count,
            'codec', default_audio.codec,
            'spatialFormat', default_audio.spatial_format
          )
          from ${mediaPart} as audio_part
          inner join ${mediaTrack} as default_audio
            on default_audio.part_id = audio_part.id
          where audio_part.source_id = ranked_source.id
            and default_audio.type = 'audio'
          order by default_audio.is_default desc, audio_part.part_order, default_audio.track_order
          limit 1
        ),
        'availability', ranked_source.effective_availability,
        'container', (
          select stored_part.container
          from ${mediaPart} as stored_part
          where stored_part.source_id = ranked_source.id
          order by stored_part.part_order
          limit 1
        ),
        'id', ranked_source.id,
        'isDefault', ranked_source.default_rank = 1,
        'label', ranked_source.label,
        'videoQuality', (
          select jsonb_build_object(
            'codec', default_video.codec,
            'dynamicRange', default_video.dynamic_range,
            'height', default_video.height,
            'width', default_video.width
          )
          from ${mediaPart} as video_part
          inner join ${mediaTrack} as default_video
            on default_video.part_id = video_part.id
          where video_part.source_id = ranked_source.id
            and default_video.type = 'video'
          order by video_part.part_order, default_video.track_order
          limit 1
        )
      )
      order by ranked_source.provider_order, ranked_source.source_order, ranked_source.id
    )
    from (
      select
        stored_source.id,
        stored_source.label,
        owning_provider.sync_priority as provider_order,
        stored_source.source_order,
        ${effectiveAvailability} as effective_availability,
        row_number() over (
          order by
            case ${effectiveAvailability}
              when 'available' then 1
              when 'provider_unavailable' then 2
              else 3
            end,
            owning_provider.sync_priority,
            stored_source.source_order,
            stored_source.id
        ) as default_rank
      from ${mediaSource} as stored_source
      inner join ${providerInstance} as owning_provider
        on owning_provider.id = stored_source.provider_instance_id
      left join ${providerInstanceObservation} as provider_observation
        on provider_observation.provider_instance_id = owning_provider.id
      where stored_source.canonical_item_id = ${canonicalItem.id}
    ) as ranked_source
  ), '[]'::jsonb)
`.as("sources");

const summarySelection = {
  artwork: artworkSelection,
  contentRating: canonicalItem.contentRating,
  episodeNumber: canonicalItem.episodeNumber,
  genres: canonicalItem.genres,
  id: canonicalItem.id,
  kind: canonicalItem.kind,
  libraryCreatedAt: sql<string>`
    to_char(
      ${libraryEntry.createdAt} at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
    )
  `.as("library_created_at"),
  normalizedTitle: sql<string>`lower(${canonicalItem.title})`.as("normalized_title"),
  releaseDateSort: sql<
    string | null
  >`coalesce(${canonicalItem.releaseDate}, ${canonicalItem.firstReleaseDate})`.as(
    "release_date_sort",
  ),
  releaseYear: canonicalItem.releaseYear,
  runtimeNanoseconds: canonicalItem.runtimeNanoseconds,
  runtimeSeconds: canonicalItem.runtimeSeconds,
  seasonNumber: canonicalItem.seasonNumber,
  sources: sourcesSelection,
  title: canonicalItem.title,
};

export { summarySelection };
