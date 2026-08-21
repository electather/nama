import { Code, ConnectError } from "@connectrpc/connect";
import { ErrorInfoSchema, RetryInfoSchema } from "@nama/api/google/rpc/error_details_pb.js";
import type { ErrorInfo, RetryInfo } from "@nama/api/google/rpc/error_details_pb.js";

import { jellyfinFailureCategory } from "./request-failure.ts";
import type { JellyfinJsonResponse } from "./request-types.ts";

const PLUGIN_ERROR_DOMAIN = "nama.plugin.v1";
const PROVIDER_RETRY_DELAY_SECONDS = 5n;

type JellyfinScanErrorReason = "INTERNAL" | "PERMISSION_DENIED" | "PROVIDER_UNAVAILABLE";
interface JellyfinScanResponseMessages {
  readonly forbidden: string;
  readonly invalid: string;
  readonly unavailable: string;
}

const jellyfinScanError = (
  message: string,
  code: Code,
  reason: JellyfinScanErrorReason,
): ConnectError => {
  const errorInfo: ErrorInfo = {
    $typeName: "google.rpc.ErrorInfo",
    domain: PLUGIN_ERROR_DOMAIN,
    metadata: {},
    reason,
  };
  const errorInfoDetail = { desc: ErrorInfoSchema, value: errorInfo };
  if (reason !== "PROVIDER_UNAVAILABLE") {
    return new ConnectError(message, code, undefined, [errorInfoDetail]);
  }
  const retryInfo: RetryInfo = {
    $typeName: "google.rpc.RetryInfo",
    retryDelay: {
      $typeName: "google.protobuf.Duration",
      nanos: 0,
      seconds: PROVIDER_RETRY_DELAY_SECONDS,
    },
  };
  return new ConnectError(message, code, undefined, [
    errorInfoDetail,
    { desc: RetryInfoSchema, value: retryInfo },
  ]);
};

const jellyfinScanBodyFromResponse = (
  response: JellyfinJsonResponse,
  messages: JellyfinScanResponseMessages,
): Readonly<Record<string, unknown>> => {
  if (response.kind === "success") {
    return response.body;
  }
  const category = jellyfinFailureCategory(response.kind);
  if (category === "forbidden") {
    throw jellyfinScanError(messages.forbidden, Code.PermissionDenied, "PERMISSION_DENIED");
  }
  if (category === "missing" || category === "retryable") {
    throw jellyfinScanError(messages.unavailable, Code.Unavailable, "PROVIDER_UNAVAILABLE");
  }
  throw jellyfinScanError(messages.invalid, Code.Internal, "INTERNAL");
};

export { jellyfinScanBodyFromResponse, jellyfinScanError };
