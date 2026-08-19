// oxlint-disable eslint/max-lines-per-function -- This end-to-end Connect route test keeps authentication, Struct decoding, handler mapping, and safe response projection in one flow.
import { createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { expect, it } from "@effect/vitest";
import { ProviderInstanceStatus, ProviderService } from "@nama/api/nama/api/v1/provider_pb.js";
import { Effect } from "effect";

import type { AuthenticationService } from "../../authentication/authentication-service.ts";
import type {
  CreateProviderInstanceInput,
  ProviderManagementService,
} from "../../provider/provider-management.ts";
import { makeDatabase, startServer } from "./http-server.test-support.ts";

const ADMINISTRATOR = Object.freeze({
  displayName: "Nama Administrator",
  email: "administrator@example.test",
  id: "administrator-1",
});
const CREATED_AT = new Date("2026-08-19T12:00:00.000Z");

it.effect("maps provider create configuration and returns only safe instance fields", () =>
  Effect.scoped(
    Effect.gen(function* providerCreateHandlerTest() {
      const received = {
        configuration: undefined as Readonly<Record<string, unknown>> | undefined,
      };
      const providerManagement: ProviderManagementService = Object.freeze({
        createProviderInstance: (input: CreateProviderInstanceInput) => {
          received.configuration = input.configuration;
          return Effect.succeed({
            configuration: {
              base_url: "http://127.0.0.1:8096",
              user_id: "provider-user",
            },
            configuredSecretKeys: ["api_key"],
            createdAt: CREATED_AT,
            credentialsAvailable: true,
            displayName: input.displayName,
            enabled: input.enabled,
            id: "provider-instance-1",
            observation: { status: "healthy" as const, summary: "Connected" },
            providerTypeId: input.providerTypeId,
            revision: "revision-1",
            syncPriority: 1,
            updatedAt: CREATED_AT,
          });
        },
        getProviderInstance: () => Effect.die("unexpected provider get"),
        listProviderInstances: () => Effect.die("unexpected provider list"),
        listProviderTypes: () => Effect.die("unexpected provider type list"),
      });
      const authentication: AuthenticationService = Object.freeze({
        consumeGlobalSignInBudget: Effect.die("unexpected sign-in limit"),
        consumeIdentitySignInBudget: () => Effect.die("unexpected sign-in limit"),
        resolveAdministrator: () => Effect.succeed(ADMINISTRATOR),
        signIn: () => Effect.die("unexpected sign-in"),
        signOut: () => Effect.die("unexpected sign-out"),
      });
      const server = yield* startServer(makeDatabase(Effect.succeed(true), "configured"), {
        authentication,
        providerManagement,
      });
      const client = createClient(
        ProviderService,
        createConnectTransport({ baseUrl: server.origin, httpVersion: "1.1" }),
      );
      const response = yield* Effect.promise(() =>
        client.createProviderInstance(
          {
            configuration: {
              api_key: "credential-sentinel",
              base_url: "http://127.0.0.1:8096",
              user_id: "provider-user",
            },
            displayName: "Home",
            enabled: true,
            operationId: "operation-1",
            providerTypeId: "jellyfin",
          },
          { headers: { authorization: "Bearer administrator-bearer" } },
        ),
      );
      expect(received.configuration).toEqual({
        api_key: "credential-sentinel",
        base_url: "http://127.0.0.1:8096",
        user_id: "provider-user",
      });
      expect(response.providerInstance).toMatchObject({
        configuration: {
          base_url: "http://127.0.0.1:8096",
          user_id: "provider-user",
        },
        configuredSecrets: [{ configured: true, key: "api_key" }],
        id: "provider-instance-1",
        status: ProviderInstanceStatus.HEALTHY,
      });
      expect(response.providerInstance?.configuration).not.toHaveProperty("api_key");
    }),
  ),
);
