import { decodeScanContinuation, encodeScanContinuation } from "./scan-continuation.ts";
import type {
  ScanContinuationDecodeInput,
  ScanContinuationEncodeInput,
  ScanContinuationPosition,
  ScanContinuationScope,
} from "./scan-continuation.ts";

const WATCH_STATE_CONTINUATION_SCOPE: ScanContinuationScope = {
  invalidMessage: "watch-state continuation is invalid",
  keyDomain: "nama/plugin/jellyfin/watch-state-continuations/v1",
  operation: "nama.plugin.v1.WatchStateService.ListWatchStates",
  queryRevision: "jellyfin-supported-watch-state/v1",
};

const encodeWatchStateContinuation = (input: ScanContinuationEncodeInput): string =>
  encodeScanContinuation(WATCH_STATE_CONTINUATION_SCOPE, input);
const decodeWatchStateContinuation = (
  input: ScanContinuationDecodeInput,
): ScanContinuationPosition => decodeScanContinuation(WATCH_STATE_CONTINUATION_SCOPE, input);

export { decodeWatchStateContinuation, encodeWatchStateContinuation };
