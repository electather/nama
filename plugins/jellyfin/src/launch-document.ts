const LAUNCH_DOCUMENT_VERSION = 2;

interface DiscoveryLaunchDocument {
  readonly bearer: string;
  readonly kind: "discovery";
  readonly socket_path: string;
  readonly version: typeof LAUNCH_DOCUMENT_VERSION;
}

interface ProviderLaunchDocument {
  readonly bearer: string;
  readonly configuration: Readonly<{
    readonly base_url: string;
    readonly user_id: string;
  }>;
  readonly credentials: Readonly<{ readonly api_key: string }>;
  readonly kind: "candidate" | "instance";
  readonly provider_instance_id?: string;
  readonly provider_type: "jellyfin";
  readonly revision?: string;
  readonly socket_path: string;
  readonly version: typeof LAUNCH_DOCUMENT_VERSION;
}

type LaunchDocument = DiscoveryLaunchDocument | ProviderLaunchDocument;

export { LAUNCH_DOCUMENT_VERSION };

export type { DiscoveryLaunchDocument, LaunchDocument, ProviderLaunchDocument };
