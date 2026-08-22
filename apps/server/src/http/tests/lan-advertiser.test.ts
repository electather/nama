import type { AddressInfo } from "node:net";
import type { NetworkInterfaceInfo, NetworkInterfaceInfoIPv6 } from "node:os";

import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Logger } from "effect";
import { beforeEach, vi } from "vitest";

import type { Config } from "../../config/config.ts";
import { runLanAdvertisement } from "../lan-advertiser.ts";
import { makeDatabase, startServer } from "./http-server.test-support.ts";

const dependency = vi.hoisted(() => ({
  getResponder: vi.fn(),
  networkInterfaces: vi.fn(),
}));

vi.mock("@homebridge/ciao", () => ({ getResponder: dependency.getResponder }));
vi.mock("node:os", () => ({
  networkInterfaces: dependency.networkInterfaces,
}));

const IPV4_ADDRESS = "192.0.2.10";
const HTTP_PORT = 80;
const HTTPS_PORT = 443;
const HTTP_OK = 200;
const ALTERNATE_HTTPS_PORT = 8443;
const FIRST_MESSAGE_INDEX = 0;
const LISTENER_PORT = 8080;
const SINGLE_MESSAGE_COUNT = 1;
const IPV6_ADDRESS = "2001:db8::10";
const RAW_FAILURE = "socket failed on en0 for 192.0.2.10 at https://nama.example/";
const IPV4_LISTENER = {
  address: "0.0.0.0",
  family: "IPv4",
  port: LISTENER_PORT,
} satisfies AddressInfo;
const IPV6_LISTENER = {
  address: "::1",
  family: "IPv6",
  port: LISTENER_PORT,
} satisfies AddressInfo;
const DUAL_STACK_LISTENER = {
  address: "::",
  family: "IPv6",
  port: LISTENER_PORT,
} satisfies AddressInfo;

const ipv4Interface: NetworkInterfaceInfo = {
  address: IPV4_ADDRESS,
  cidr: `${IPV4_ADDRESS}/24`,
  family: "IPv4",
  internal: false,
  mac: "00:00:5e:00:53:01",
  netmask: "255.255.255.0",
};
const ipv6Interface: NetworkInterfaceInfoIPv6 = {
  address: IPV6_ADDRESS,
  cidr: `${IPV6_ADDRESS}/64`,
  family: "IPv6",
  internal: false,
  mac: "00:00:5e:00:53:01",
  netmask: "ffff:ffff:ffff:ffff::",
  scopeid: 0,
};
const loopbackInterface: NetworkInterfaceInfo = {
  address: "127.0.0.1",
  cidr: "127.0.0.1/8",
  family: "IPv4",
  internal: true,
  mac: "00:00:00:00:00:00",
  netmask: "255.0.0.0",
};
const interfaces = {
  en0: [ipv4Interface, ipv6Interface],
  lo0: [loopbackInterface],
};

const enabledServer = Object.freeze({
  bind: "0.0.0.0:8080",
  lanDiscovery: true,
  publicUrl: "https://nama.example/",
}) satisfies Config["Service"]["server"];
const disabledServer = Object.freeze({ ...enabledServer, lanDiscovery: false });

interface FakeService {
  readonly advertise: () => Promise<void>;
  readonly on: (event: string, listener: (name: string) => void) => FakeService;
}

interface FakeResponder {
  readonly createService: (options: unknown) => FakeService;
  readonly shutdown: () => Promise<void>;
}

interface FakeResponderOptions {
  readonly advertise: () => Promise<void>;
  readonly createFailure?: Error;
  readonly nameChange?: string;
  readonly onCreate?: (options: unknown) => void;
  readonly onNameChange?: (name: string) => void;
  readonly onShutdown?: () => void;
}

const makeFakeResponder = ({
  advertise,
  createFailure,
  nameChange,
  onCreate = () => {},
  onNameChange = () => {},
  onShutdown = () => {},
}: FakeResponderOptions): FakeResponder => {
  let nameChangeListener: ((name: string) => void) | undefined = undefined;
  const service: FakeService = {
    advertise: () => {
      if (nameChange !== undefined) {
        nameChangeListener?.(nameChange);
      }
      return advertise();
    },
    on: (event, listener) => {
      if (event === "name-change") {
        nameChangeListener = (name) => {
          onNameChange(name);
          listener(name);
        };
      }
      return service;
    },
  };
  return {
    createService: (options) => {
      onCreate(options);
      if (createFailure !== undefined) {
        throw createFailure;
      }
      return service;
    },
    shutdown: () => {
      onShutdown();
      return Promise.resolve();
    },
  };
};

const capturedLogger = (messages: unknown[]) =>
  Logger.layer([
    Logger.make<unknown, void>(({ message }) => {
      if (Array.isArray(message) && message.length === SINGLE_MESSAGE_COUNT) {
        messages.push(message[FIRST_MESSAGE_INDEX]);
        return;
      }
      messages.push(message);
    }),
  ]);

interface CapturedPublication {
  responderOptions: unknown;
  serviceOptions: unknown;
}

const requestHttpTraffic = (origin: string) =>
  Effect.all([
    Effect.promise(() => fetch(`${origin}/health/live`)),
    Effect.promise(() =>
      fetch(`${origin}/nama.api.v1.SetupService/GetStatus`, {
        body: "{}",
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    ),
  ] as const);

const expectNonfatalTraffic = (
  responses: readonly [Response, Response],
  records: readonly unknown[],
): void => {
  expect(responses.map(({ status }) => status)).toEqual([HTTP_OK, HTTP_OK]);
  expect(records).toContainEqual({ event: "lan.advertisement_failed" });
  expect(JSON.stringify(records)).not.toContain(RAW_FAILURE);
};

const expectIpv6Publication = (health: Response, publication: CapturedPublication): void => {
  expect(health.status).toBe(HTTP_OK);
  expect(publication.responderOptions).toEqual({
    advertiseIpv4: false,
    advertiseIpv6: true,
    interface: ["en0"],
  });
  expect(publication.serviceOptions).toMatchObject({ restrictedAddresses: [IPV6_ADDRESS] });
};

const captureAdvertisement = (
  server: Readonly<Config["Service"]["server"]>,
  listenerAddress: AddressInfo,
) =>
  Effect.scoped(
    Effect.gen(function* captureAdvertisementOptions() {
      const advertised = yield* Deferred.make<void>();
      const publication: CapturedPublication = {
        responderOptions: undefined,
        serviceOptions: undefined,
      };
      const responder = makeFakeResponder({
        advertise: () => {
          Deferred.doneUnsafe(advertised, Effect.void);
          return Promise.resolve();
        },
        onCreate: (options) => {
          publication.serviceOptions = options;
        },
      });
      dependency.getResponder.mockImplementation((options) => {
        publication.responderOptions = options;
        return responder;
      });
      const fiber = yield* Effect.forkChild(runLanAdvertisement(server, listenerAddress));
      yield* Deferred.await(advertised);
      yield* Fiber.interrupt(fiber);
      return publication;
    }),
  );

beforeEach(() => {
  dependency.getResponder.mockReset();
  dependency.networkInterfaces.mockReset();
  dependency.networkInterfaces.mockReturnValue(interfaces);
});

it.effect("maps an IPv4 listener to a canonical _nama._tcp publication", () =>
  Effect.gen(function* ipv4PublicationTest() {
    const publication = yield* captureAdvertisement(enabledServer, IPV4_LISTENER);

    expect(publication).toEqual({
      responderOptions: {
        advertiseIpv4: true,
        advertiseIpv6: false,
        disableIpv6: true,
        interface: ["en0"],
      },
      serviceOptions: {
        disabledIpv6: true,
        name: "Nama",
        port: HTTPS_PORT,
        restrictedAddresses: [IPV4_ADDRESS],
        txt: { url: "https://nama.example/" },
        type: "nama",
      },
    });
  }),
);

it.effect("publishes only IPv6 records for an exercised IPv6 listener", () =>
  Effect.gen(function* ipv6PublicationTest() {
    const publication = yield* captureAdvertisement(
      { ...enabledServer, publicUrl: "http://nama.local:8080/" },
      IPV6_LISTENER,
    );

    expect(publication).toEqual({
      responderOptions: {
        advertiseIpv4: false,
        advertiseIpv6: true,
        interface: ["en0"],
      },
      serviceOptions: {
        name: "Nama",
        port: LISTENER_PORT,
        restrictedAddresses: [IPV6_ADDRESS],
        txt: { url: "http://nama.local:8080/" },
        type: "nama",
      },
    });
  }),
);

it.effect("publishes both accepted families only for a dual-stack wildcard listener", () =>
  Effect.gen(function* dualStackPublicationTest() {
    const publication = yield* captureAdvertisement(enabledServer, DUAL_STACK_LISTENER);

    expect(publication.responderOptions).toEqual({
      advertiseIpv4: true,
      advertiseIpv6: true,
      interface: ["en0"],
    });
    expect(publication.serviceOptions).toMatchObject({
      restrictedAddresses: [IPV4_ADDRESS, IPV6_ADDRESS],
    });
  }),
);

it.effect("uses the effective public URL port", () =>
  Effect.gen(function* effectivePortTest() {
    const cases = [
      ["http://nama.example/", HTTP_PORT],
      ["https://nama.example/", HTTPS_PORT],
      ["https://nama.example:8443/", ALTERNATE_HTTPS_PORT],
    ] as const;
    for (const [publicUrl, expectedPort] of cases) {
      const publication = yield* captureAdvertisement(
        { ...enabledServer, publicUrl },
        IPV4_LISTENER,
      );
      expect(publication.serviceOptions).toMatchObject({ port: expectedPort });
    }
  }),
);

it.effect("does not create a publisher when LAN discovery is disabled", () =>
  Effect.gen(function* disabledAdvertisementTest() {
    yield* runLanAdvertisement(disabledServer, IPV4_LISTENER);

    expect(dependency.getResponder).not.toHaveBeenCalled();
  }),
);

it.effect("contains network-interface enumeration failures", () => {
  const messages: unknown[] = [];
  dependency.networkInterfaces.mockImplementation(() => {
    throw new Error(RAW_FAILURE);
  });

  return runLanAdvertisement(enabledServer, IPV4_LISTENER).pipe(
    Effect.provide(capturedLogger(messages)),
    Effect.andThen(
      Effect.sync(() => {
        expect(messages).toEqual([{ event: "lan.advertisement_failed" }]);
        expect(JSON.stringify(messages)).not.toContain(RAW_FAILURE);
      }),
    ),
  );
});

it.effect("keeps an enabled advertisement alive and sends goodbye on cancellation", () =>
  Effect.scoped(
    Effect.gen(function* enabledAdvertisementTest() {
      const advertised = yield* Deferred.make<void>();
      const stopped = yield* Deferred.make<void>();
      let serviceOptions: unknown = {};
      const responder = makeFakeResponder({
        advertise: () => {
          Deferred.doneUnsafe(advertised, Effect.void);
          return Promise.resolve();
        },
        onCreate: (options) => {
          serviceOptions = options;
        },
        onShutdown: () => {
          Deferred.doneUnsafe(stopped, Effect.void);
        },
      });
      dependency.getResponder.mockReturnValue(responder);
      const fiber = yield* Effect.forkChild(runLanAdvertisement(enabledServer, IPV4_LISTENER));
      yield* Deferred.await(advertised);

      expect(serviceOptions).toMatchObject({ name: "Nama", txt: { url: enabledServer.publicUrl } });
      yield* Fiber.interrupt(fiber);
      yield* Deferred.await(stopped);
    }),
  ),
);

it.effect("accepts ciao collision renaming without logging the resulting name", () => {
  const messages: unknown[] = [];
  let changedName = "";
  const responder = makeFakeResponder({
    advertise: () => Promise.resolve(),
    nameChange: "Nama (2)",
    onNameChange: (name) => {
      changedName = name;
    },
  });
  dependency.getResponder.mockReturnValue(responder);

  return Effect.scoped(
    Effect.gen(function* collisionRenameTest() {
      const fiber = yield* Effect.forkChild(runLanAdvertisement(enabledServer, IPV4_LISTENER));
      yield* Effect.yieldNow;
      expect(changedName).toBe("Nama (2)");
      expect(JSON.stringify(messages)).not.toContain("Nama (2)");
      yield* Fiber.interrupt(fiber);
    }),
  ).pipe(Effect.provide(capturedLogger(messages)));
});

it.effect("cleans a responder after partial publisher startup", () => {
  const messages: unknown[] = [];
  let stopped = false;
  dependency.getResponder.mockReturnValue(
    makeFakeResponder({
      advertise: () => Promise.resolve(),
      createFailure: new Error(RAW_FAILURE),
      onShutdown: () => {
        stopped = true;
      },
    }),
  );

  return runLanAdvertisement(enabledServer, IPV4_LISTENER).pipe(
    Effect.provide(capturedLogger(messages)),
    Effect.andThen(
      Effect.sync(() => {
        expect(stopped).toBe(true);
        expect(messages).toEqual([{ event: "lan.advertisement_failed" }]);
        expect(JSON.stringify(messages)).not.toContain(RAW_FAILURE);
      }),
    ),
    Effect.scoped,
  );
});

it.effect("contains publisher socket failures without exposing their details", () => {
  const messages: unknown[] = [];
  let stopped = false;
  dependency.getResponder.mockReturnValue(
    makeFakeResponder({
      advertise: () => Promise.reject(new Error(RAW_FAILURE)),
      onShutdown: () => {
        stopped = true;
      },
    }),
  );

  return runLanAdvertisement(enabledServer, IPV4_LISTENER).pipe(
    Effect.provide(capturedLogger(messages)),
    Effect.andThen(
      Effect.sync(() => {
        expect(stopped).toBe(true);
        expect(messages).toEqual([{ event: "lan.advertisement_failed" }]);
        expect(JSON.stringify(messages)).not.toContain(RAW_FAILURE);
      }),
    ),
    Effect.scoped,
  );
});

it.effect("withdraws the advertisement before listener shutdown", () =>
  Effect.gen(function* advertisementShutdownOrderTest() {
    const advertised = yield* Deferred.make<void>();
    const events: string[] = [];
    dependency.getResponder.mockReturnValue(
      makeFakeResponder({
        advertise: () => {
          Deferred.doneUnsafe(advertised, Effect.void);
          return Promise.resolve();
        },
        onShutdown: () => {
          events.push("lan.withdrawn");
        },
      }),
    );
    const server = yield* startServer(makeDatabase(Effect.succeed(true)), {
      emitStopping: () =>
        Effect.sync(() => {
          events.push("listener.stopping");
        }),
      lanDiscovery: true,
    });

    yield* server.advertiseLan;
    yield* Deferred.await(advertised);
    yield* server.close;

    expect(events).toEqual(["lan.withdrawn", "listener.stopping"]);
  }),
);

it.effect("keeps health and Connect traffic available after publisher failure", () =>
  Effect.gen(function* nonfatalPublisherFailureTest() {
    const [attempted, stopped] = yield* Effect.all([
      Deferred.make<void>(),
      Deferred.make<void>(),
    ] as const);
    const records: unknown[] = [];
    dependency.getResponder.mockReturnValue(
      makeFakeResponder({
        advertise: () => {
          Deferred.doneUnsafe(attempted, Effect.void);
          return Promise.reject(new Error(RAW_FAILURE));
        },
        onShutdown: () => {
          Deferred.doneUnsafe(stopped, Effect.void);
        },
      }),
    );
    const server = yield* startServer(makeDatabase(Effect.succeed(true)), {
      lanDiscovery: true,
      records,
    });

    yield* server.advertiseLan.pipe(Effect.provide(capturedLogger(records)));
    yield* Effect.all([Deferred.await(attempted), Deferred.await(stopped)] as const);
    yield* Effect.yieldNow;
    const responses = yield* requestHttpTraffic(server.origin);

    expectNonfatalTraffic(responses, records);
    yield* server.close;
  }),
);

it.effect("advertises IPv6 only after an IPv6 listener accepts traffic", () =>
  Effect.gen(function* ipv6ListenerAdvertisementTest() {
    const advertised = yield* Deferred.make<void>();
    const publication: CapturedPublication = {
      responderOptions: undefined,
      serviceOptions: undefined,
    };
    const responder = makeFakeResponder({
      advertise: () => {
        Deferred.doneUnsafe(advertised, Effect.void);
        return Promise.resolve();
      },
      onCreate: (options) => {
        publication.serviceOptions = options;
      },
    });
    dependency.getResponder.mockImplementation((options) => {
      publication.responderOptions = options;
      return responder;
    });
    const server = yield* startServer(makeDatabase(Effect.succeed(true)), {
      host: "::1",
      lanDiscovery: true,
    });
    const health = yield* Effect.promise(() => fetch(`${server.origin}/health/live`));
    yield* server.advertiseLan;
    yield* Deferred.await(advertised);

    expectIpv6Publication(health, publication);
    yield* server.close;
  }),
);
