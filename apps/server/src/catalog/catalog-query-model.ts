import { Data } from "effect";
import type { Effect } from "effect";

import type {
  GetHomeRequest,
  GetHomeResponse,
  GetMediaRequest,
  GetMediaResponse,
  GetMediaSourceRequest,
  GetMediaSourceResponse,
  ListChildrenRequest,
  ListChildrenResponse,
  ListLibraryRequest,
  ListLibraryResponse,
  ResolveArtworkRequest,
  ResolveArtworkResponse,
  SearchRequest,
  SearchResponse,
} from "../../../../gen/ts/src/nama/api/v1/library_pb.js";
import type { CatalogQueryStorage } from "../database/catalog-query-storage.ts";
import type { PageTokenInvalidFailure } from "../provider/page-token.ts";
import type { ArtworkAccessService } from "./catalog-artwork-access.ts";

const taggedError = Data.TaggedError;
const CatalogQueryPersistenceError = taggedError("CatalogQueryPersistenceError")<
  Record<string, never>
>;
type CatalogQueryPersistenceFailure = InstanceType<typeof CatalogQueryPersistenceError>;
const CatalogNotReady = taggedError("CatalogNotReady")<{
  readonly retryDelayMilliseconds: number;
}>;
type CatalogNotReadyFailure = InstanceType<typeof CatalogNotReady>;
const MediaStateUnavailable = taggedError("MediaStateUnavailable")<Record<string, never>>;
type MediaStateUnavailableFailure = InstanceType<typeof MediaStateUnavailable>;
const ResourceNotFound = taggedError("ResourceNotFound")<Record<string, never>>;
type ResourceNotFoundFailure = InstanceType<typeof ResourceNotFound>;
const MediaHasNoChildren = taggedError("MediaHasNoChildren")<Record<string, never>>;
type MediaHasNoChildrenFailure = InstanceType<typeof MediaHasNoChildren>;
const SourceUnavailable = taggedError("SourceUnavailable")<{
  readonly retryDelayMilliseconds?: number;
}>;
type SourceUnavailableFailure = InstanceType<typeof SourceUnavailable>;
const SearchQueryInvalid = taggedError("SearchQueryInvalid")<Record<string, never>>;
type SearchQueryInvalidFailure = InstanceType<typeof SearchQueryInvalid>;
type CatalogReadFailure = CatalogNotReadyFailure | CatalogQueryPersistenceFailure;
type ListLibraryFailure =
  | CatalogNotReadyFailure
  | CatalogQueryPersistenceFailure
  | MediaStateUnavailableFailure
  | PageTokenInvalidFailure;
type SearchFailure =
  | CatalogNotReadyFailure
  | CatalogQueryPersistenceFailure
  | PageTokenInvalidFailure
  | SearchQueryInvalidFailure;
type GetMediaFailure = CatalogReadFailure | ResourceNotFoundFailure;
type GetMediaSourceFailure = GetMediaFailure | SourceUnavailableFailure;
type ListChildrenFailure =
  | CatalogNotReadyFailure
  | CatalogQueryPersistenceFailure
  | MediaHasNoChildrenFailure
  | PageTokenInvalidFailure
  | ResourceNotFoundFailure;
type ResolveArtworkFailure = CatalogReadFailure | ResourceNotFoundFailure;

interface CatalogQueryService {
  readonly getHome: (
    principalId: string,
    request: GetHomeRequest,
  ) => Effect.Effect<GetHomeResponse, CatalogReadFailure>;
  readonly getMedia: (
    principalId: string,
    request: GetMediaRequest,
  ) => Effect.Effect<GetMediaResponse, GetMediaFailure>;
  readonly getMediaSource: (
    principalId: string,
    request: GetMediaSourceRequest,
  ) => Effect.Effect<GetMediaSourceResponse, GetMediaSourceFailure>;
  readonly listLibrary: (
    principalId: string,
    request: ListLibraryRequest,
  ) => Effect.Effect<ListLibraryResponse, ListLibraryFailure>;
  readonly listChildren: (
    principalId: string,
    request: ListChildrenRequest,
  ) => Effect.Effect<ListChildrenResponse, ListChildrenFailure>;
  readonly resolveArtwork: (
    principalId: string,
    request: ResolveArtworkRequest,
  ) => Effect.Effect<ResolveArtworkResponse, ResolveArtworkFailure>;
  readonly search: (
    principalId: string,
    request: SearchRequest,
  ) => Effect.Effect<SearchResponse, SearchFailure>;
}

interface CatalogQueryDependencies {
  readonly artworkAccess: ArtworkAccessService;
  readonly catalog: CatalogQueryStorage;
  readonly masterKey: string;
  readonly now: () => number;
}

export {
  CatalogNotReady,
  CatalogQueryPersistenceError,
  MediaHasNoChildren,
  MediaStateUnavailable,
  ResourceNotFound,
  SearchQueryInvalid,
  SourceUnavailable,
};
export type {
  CatalogNotReadyFailure,
  CatalogQueryDependencies,
  CatalogQueryPersistenceFailure,
  CatalogQueryService,
  CatalogReadFailure,
  GetMediaFailure,
  GetMediaSourceFailure,
  ListChildrenFailure,
  ListLibraryFailure,
  MediaHasNoChildrenFailure,
  MediaStateUnavailableFailure,
  ResolveArtworkFailure,
  ResourceNotFoundFailure,
  SearchFailure,
  SearchQueryInvalidFailure,
  SourceUnavailableFailure,
};
