import { eq, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import {
  APPLE_AUTHORIZATION_SCOPES,
  APPLE_PUBLIC_CLIENT_ID,
  CONSUMER_SCOPES,
} from "../config/oauth.ts";
import { oauthClient, oauthClientResource, oauthResource } from "./auth-schema.ts";
import type { databaseSchema } from "./schema.ts";

const APPLE_CLIENT_RESOURCE_LINK_ID = "nama-apple-resource";
const NAMA_API_RESOURCE_ID = "nama-api-resource";
const DEVICE_CODE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const EXPECTED_CLIENT_COUNT = 1;
type OAuthConfigurationWriter = Pick<
  NodePgDatabase<typeof databaseSchema>,
  "delete" | "insert" | "update"
>;

const reconcileAppleClient = async (database: OAuthConfigurationWriter): Promise<void> => {
  const updatedClients = await database
    .update(oauthClient)
    .set({
      applicationType: "native",
      // oxlint-disable-next-line unicorn/no-null -- The fixed public client must have no stored secret.
      clientSecret: null,
      disabled: false,
      grantTypes: [DEVICE_CODE_GRANT, "refresh_token"],
      name: "Nama for Apple Platforms",
      redirectUris: [],
      requirePKCE: false,
      responseTypes: [],
      scopes: [...APPLE_AUTHORIZATION_SCOPES],
      skipConsent: true,
      tokenEndpointAuthMethod: "none",
      updatedAt: sql`transaction_timestamp()`,
      // oxlint-disable-next-line unicorn/no-null -- The code-owned first-party client is not user-owned.
      userId: null,
    })
    .where(eq(oauthClient.clientId, APPLE_PUBLIC_CLIENT_ID))
    .returning({ id: oauthClient.id });
  if (updatedClients.length !== EXPECTED_CLIENT_COUNT) {
    throw new Error("fixed Apple OAuth client is missing");
  }
};

const reconcileResource = async (
  database: OAuthConfigurationWriter,
  resource: string,
): Promise<void> => {
  await database
    .delete(oauthClientResource)
    .where(eq(oauthClientResource.clientId, APPLE_PUBLIC_CLIENT_ID));
  await database
    .insert(oauthResource)
    .values({
      allowedScopes: [...CONSUMER_SCOPES],
      createdAt: sql`transaction_timestamp()`,
      disabled: false,
      id: NAMA_API_RESOURCE_ID,
      identifier: resource,
      name: "Nama API",
      updatedAt: sql`transaction_timestamp()`,
    })
    .onConflictDoUpdate({
      set: {
        allowedScopes: [...CONSUMER_SCOPES],
        disabled: false,
        identifier: resource,
        name: "Nama API",
        updatedAt: sql`transaction_timestamp()`,
      },
      target: oauthResource.id,
    });
  await database.insert(oauthClientResource).values({
    clientId: APPLE_PUBLIC_CLIENT_ID,
    createdAt: sql`transaction_timestamp()`,
    id: APPLE_CLIENT_RESOURCE_LINK_ID,
    resourceId: resource,
  });
};

const reconcileOAuthConfiguration = async (
  database: NodePgDatabase<typeof databaseSchema>,
  resource: string,
): Promise<void> => {
  await database.transaction(async (transaction) => {
    await reconcileAppleClient(transaction);
    await reconcileResource(transaction, resource);
  });
};

export { reconcileOAuthConfiguration };
