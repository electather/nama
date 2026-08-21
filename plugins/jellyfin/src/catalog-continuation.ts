import { decodeScanContinuation, encodeScanContinuation } from "./scan-continuation.ts";
import type {
  ScanContinuationDecodeInput,
  ScanContinuationEncodeInput,
  ScanContinuationPosition,
  ScanContinuationScope,
} from "./scan-continuation.ts";

const CATALOG_CONTINUATION_SCOPE: ScanContinuationScope = {
  invalidMessage: "catalog continuation is invalid",
  keyDomain: "nama/plugin/jellyfin/catalog-continuations/v1",
  operation: "nama.plugin.v1.LibraryService.ListItems",
  queryRevision: "jellyfin-supported-catalog/v1",
};

const encodeCatalogContinuation = (input: ScanContinuationEncodeInput): string =>
  encodeScanContinuation(CATALOG_CONTINUATION_SCOPE, input);
const decodeCatalogContinuation = (input: ScanContinuationDecodeInput): ScanContinuationPosition =>
  decodeScanContinuation(CATALOG_CONTINUATION_SCOPE, input);

export { decodeCatalogContinuation, encodeCatalogContinuation };
