// oxlint-disable eslint/max-lines-per-function -- This end-to-end Connect route test keeps authentication, Struct decoding, handler mapping, and safe response projection in one flow.
import { createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { expect, it } from "@effect/vitest";
import {
  ProviderCapability,
  ProviderConnectionStatus,
  ProviderInstanceStatus,
  ProviderService,
} from "@nama/api/nama/api/v1/provider_pb.js";
import { Effect } from "effect";

import type { AuthenticationService } from "../../authentication/authentication-service.ts";
import type {
  CreateProviderInstanceInput,
  DeleteProviderInstanceInput,
  ProviderManagementService,
  TestProviderConfigurationInput,
  TestProviderInstanceInput,
  UpdateProviderInstanceInput,
} from "../../provider/provider-management.ts";
import { makeDatabase, startServer } from "./http-server.test-support.ts";

const ADMINISTRATOR = Object.freeze({
  displayName: "Nama Administrator",
  email: "administrator@example.test",
  id: "administrator-1",
});
const CREATED_AT = new Date("2026-08-19T12:00:00.000Z");
const DEFAULT_SYNC_PRIORITY = 1;
const LIBRARY_READ_CAPABILITY = ProviderCapability.LIBRARY_READ;
const authentication: AuthenticationService = Object.freeze({
  consumeGlobalSignInBudget: Effect.die("unexpected sign-in limit"),
  consumeIdentitySignInBudget: () => Effect.die("unexpected sign-in limit"),
  resolveAdministrator: () => Effect.succeed(ADMINISTRATOR),
  signIn: () => Effect.die("unexpected sign-in"),
  signOut: () => Effect.die("unexpected sign-out"),
});

const unusedProviderManagement: ProviderManagementService = Object.freeze({
  createProviderInstance: () => Effect.die("unexpected provider creation"),
  deleteProviderInstance: () => Effect.die("unexpected provider deletion"),
  getProviderInstance: () => Effect.die("unexpected provider get"),
  listProviderInstances: () => Effect.die("unexpected provider list"),
  listProviderTypes: () => Effect.die("unexpected provider type list"),
  runProviderActivity: <Success, Failure, Requirements>(
    _providerInstanceId: string,
    activity: Effect.Effect<Success, Failure, Requirements>,
  ) => activity,
  testProviderConfiguration: () => Effect.die("unexpected provider configuration test"),
  testProviderInstance: () => Effect.die("unexpected provider instance test"),
  updateProviderInstance: () => Effect.die("unexpected provider update"),
});

it.effect("maps provider mutation requests to safe responses", () =>
  Effect.scoped(
    Effect.gen(function* providerCreateHandlerTest() {
      const received = {
        configuration: undefined as Readonly<Record<string, unknown>> | undefined,
        deletion: undefined as DeleteProviderInstanceInput | undefined,
        update: undefined as UpdateProviderInstanceInput | undefined,
      };
      const providerManagement: ProviderManagementService = Object.freeze({
        ...unusedProviderManagement,
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
            syncPriority: DEFAULT_SYNC_PRIORITY,
            updatedAt: CREATED_AT,
          });
        },
        deleteProviderInstance: (input: DeleteProviderInstanceInput) => {
          received.deletion = input;
          return Effect.void;
        },
        updateProviderInstance: (input: UpdateProviderInstanceInput) => {
          received.update = input;
          return Effect.succeed({
            configuration: {
              base_url: "http://127.0.0.1:9096",
              user_id: "provider-user",
            },
            configuredSecretKeys: ["api_key"],
            createdAt: CREATED_AT,
            credentialsAvailable: true,
            displayName: input.displayName ?? "Home",
            enabled: input.enabled ?? true,
            id: input.providerInstanceId,
            observation: { status: "healthy" as const, summary: "Connected" },
            providerTypeId: "jellyfin",
            revision: "revision-2",
            syncPriority: input.syncPriority ?? DEFAULT_SYNC_PRIORITY,
            updatedAt: new Date("2026-08-19T12:01:00.000Z"),
          });
        },
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
      expect({
        configuration: received.configuration,
        providerInstance: response.providerInstance,
        secretExposed: Object.hasOwn(response.providerInstance?.configuration ?? {}, "api_key"),
      }).toMatchObject({
        configuration: {
          api_key: "credential-sentinel",
          base_url: "http://127.0.0.1:8096",
          user_id: "provider-user",
        },
        providerInstance: {
          configuration: {
            base_url: "http://127.0.0.1:8096",
            user_id: "provider-user",
          },
          configuredSecrets: [{ configured: true, key: "api_key" }],
          id: "provider-instance-1",
          status: ProviderInstanceStatus.HEALTHY,
        },
        secretExposed: false,
      });
      const updated = yield* Effect.promise(() =>
        client.updateProviderInstance(
          {
            clearConfigurationFields: ["optional_note"],
            configurationPatch: { base_url: "http://127.0.0.1:9096" },
            displayName: "Family Room",
            enabled: false,
            expectedRevision: "revision-1",
            operationId: "operation-2",
            providerInstanceId: "provider-instance-1",
            syncPriority: 2,
          },
          { headers: { authorization: "Bearer administrator-bearer" } },
        ),
      );
      expect({
        input: received.update,
        providerInstance: updated.providerInstance,
        secretExposed: Object.hasOwn(updated.providerInstance?.configuration ?? {}, "api_key"),
      }).toMatchObject({
        input: {
          administratorId: ADMINISTRATOR.id,
          clearConfigurationFields: ["optional_note"],
          configurationPatch: { base_url: "http://127.0.0.1:9096" },
          displayName: "Family Room",
          enabled: false,
          expectedRevision: "revision-1",
          operationId: "operation-2",
          providerInstanceId: "provider-instance-1",
          syncPriority: 2,
        },
        providerInstance: {
          configuration: {
            base_url: "http://127.0.0.1:9096",
            user_id: "provider-user",
          },
          configuredSecrets: [{ configured: true, key: "api_key" }],
          displayName: "Family Room",
          enabled: false,
          id: "provider-instance-1",
          revision: "revision-2",
          status: ProviderInstanceStatus.DISABLED,
          syncPriority: 2,
        },
        secretExposed: false,
      });
      yield* Effect.promise(() =>
        client.deleteProviderInstance(
          {
            expectedRevision: "revision-2",
            operationId: "operation-3",
            providerInstanceId: "provider-instance-1",
          },
          { headers: { authorization: "Bearer administrator-bearer" } },
        ),
      );
      expect(received.deletion).toEqual({
        administratorId: ADMINISTRATOR.id,
        expectedRevision: "revision-2",
        operationId: "operation-3",
        providerInstanceId: "provider-instance-1",
      });
    }),
  ),
);

it.effect("maps provider connection tests to credential-free results", () =>
  Effect.scoped(
    Effect.gen(function* providerConnectionHandlerTest() {
      const received = {
        configuration: undefined as TestProviderConfigurationInput | undefined,
        instance: undefined as TestProviderInstanceInput | undefined,
      };
      const providerManagement: ProviderManagementService = Object.freeze({
        ...unusedProviderManagement,
        testProviderConfiguration: (input: TestProviderConfigurationInput) => {
          received.configuration = input;
          return Effect.succeed({
            capabilities: [LIBRARY_READ_CAPABILITY],
            remoteName: "Jellyfin Home",
            remoteVersion: "10.11.0",
            status: "authentication_failed" as const,
            summary: "Authentication failed",
          });
        },
        testProviderInstance: (input: TestProviderInstanceInput) => {
          received.instance = input;
          return Effect.succeed({
            capabilities: [LIBRARY_READ_CAPABILITY],
            remoteName: "Jellyfin Home",
            remoteVersion: "10.11.0",
            status: "connected" as const,
            summary: "Connected",
          });
        },
      });
      const server = yield* startServer(makeDatabase(Effect.succeed(true), "configured"), {
        authentication,
        providerManagement,
      });
      const client = createClient(
        ProviderService,
        createConnectTransport({ baseUrl: server.origin, httpVersion: "1.1" }),
      );
      const configurationTest = yield* Effect.promise(() =>
        client.testProviderConfiguration(
          {
            configuration: {
              api_key: "credential-sentinel",
              base_url: "http://127.0.0.1:8096",
              user_id: "provider-user",
            },
            providerTypeId: "jellyfin",
          },
          { headers: { authorization: "Bearer administrator-bearer" } },
        ),
      );
      expect({
        received: received.configuration,
        result: configurationTest.result,
      }).toEqual({
        received: {
          configuration: {
            api_key: "credential-sentinel",
            base_url: "http://127.0.0.1:8096",
            user_id: "provider-user",
          },
          providerTypeId: "jellyfin",
        },
        result: {
          $typeName: "nama.api.v1.ProviderConnectionTest",
          capabilities: [ProviderCapability.LIBRARY_READ],
          remoteName: "Jellyfin Home",
          remoteVersion: "10.11.0",
          status: ProviderConnectionStatus.AUTHENTICATION_FAILED,
          summary: "Authentication failed",
        },
      });
      const instanceTest = yield* Effect.promise(() =>
        client.testProviderInstance(
          { providerInstanceId: "provider-instance-1" },
          { headers: { authorization: "Bearer administrator-bearer" } },
        ),
      );
      expect({
        received: received.instance,
        result: instanceTest.result,
      }).toEqual({
        received: { providerInstanceId: "provider-instance-1" },
        result: {
          $typeName: "nama.api.v1.ProviderConnectionTest",
          capabilities: [ProviderCapability.LIBRARY_READ],
          remoteName: "Jellyfin Home",
          remoteVersion: "10.11.0",
          status: ProviderConnectionStatus.CONNECTED,
          summary: "Connected",
        },
      });
    }),
  ),
);
