import type { AddressInfo } from "node:net";
import { networkInterfaces } from "node:os";
import type { NetworkInterfaceInfo } from "node:os";

import { getResponder } from "@homebridge/ciao";
import type { Responder, ResponderOptions, ServiceOptions } from "@homebridge/ciao";
import { Cause, Effect } from "effect";

import type { Config } from "../config/config.ts";
import type { EventMessage } from "../logging/record.ts";

const LAN_ADVERTISEMENT_FAILED = "lan.advertisement_failed";
const HTTP_PORT = 80;
const HTTPS_PORT = 443;
const NO_ADDRESSES = 0;

interface AdvertisementOptions {
  readonly responder: ResponderOptions;
  readonly service: ServiceOptions;
}

interface AcceptedFamilies {
  readonly ipv4: boolean;
  readonly ipv6: boolean;
}

interface EligibleInterfaces {
  readonly addresses: string[];
  readonly names: string[];
}

const acceptedFamilies = (listenerAddress: AddressInfo | string | null): AcceptedFamilies => {
  if (listenerAddress === null || typeof listenerAddress === "string") {
    return { ipv4: false, ipv6: false };
  }
  if (listenerAddress.family === "IPv4") {
    return { ipv4: true, ipv6: false };
  }
  if (listenerAddress.address === "::") {
    return { ipv4: true, ipv6: true };
  }
  return { ipv4: false, ipv6: true };
};

const familyIsAccepted = (
  family: NetworkInterfaceInfo["family"],
  accepted: AcceptedFamilies,
): boolean => {
  if (family === "IPv4") {
    return accepted.ipv4;
  }
  return accepted.ipv6;
};

const eligibleInterfaces = (
  families: AcceptedFamilies,
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>,
): EligibleInterfaces => {
  const addresses = new Set<string>();
  const names = new Set<string>();
  for (const [name, entries] of Object.entries(interfaces)) {
    for (const entry of entries ?? []) {
      const familyAccepted = familyIsAccepted(entry.family, families);
      if (!entry.internal && familyAccepted) {
        addresses.add(entry.address);
        names.add(name);
      }
    }
  }
  return {
    addresses: [...addresses].toSorted(),
    names: [...names].toSorted(),
  };
};

const effectivePort = (publicUrl: string): number => {
  const url = new URL(publicUrl);
  if (url.port !== "") {
    return Number(url.port);
  }
  if (url.protocol === "https:") {
    return HTTPS_PORT;
  }
  return HTTP_PORT;
};

const responderOptions = (
  families: AcceptedFamilies,
  eligible: EligibleInterfaces,
): ResponderOptions => {
  const options: ResponderOptions = {
    advertiseIpv4: families.ipv4,
    advertiseIpv6: families.ipv6,
    interface: eligible.names,
  };
  if (!families.ipv6) {
    options.disableIpv6 = true;
  }
  return options;
};

const serviceOptions = (
  server: Readonly<Config["Service"]["server"]>,
  families: AcceptedFamilies,
  eligible: EligibleInterfaces,
): ServiceOptions => {
  const options: ServiceOptions = {
    name: "Nama",
    port: effectivePort(server.publicUrl),
    restrictedAddresses: eligible.addresses,
    txt: { url: server.publicUrl },
    type: "nama",
  };
  if (!families.ipv6) {
    options.disabledIpv6 = true;
  }
  return options;
};

const makeAdvertisementOptions = (
  server: Readonly<Config["Service"]["server"]>,
  listenerAddress: AddressInfo | string | null,
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>,
): { readonly responder: ResponderOptions; readonly service: ServiceOptions } | undefined => {
  if (!server.lanDiscovery) {
    return undefined;
  }
  const families = acceptedFamilies(listenerAddress);
  const eligible = eligibleInterfaces(families, interfaces);
  if (eligible.addresses.length === NO_ADDRESSES) {
    return undefined;
  }
  return {
    responder: responderOptions(families, eligible),
    service: serviceOptions(server, families, eligible),
  };
};

const logAdvertisementFailure = Effect.logWarning({
  event: LAN_ADVERTISEMENT_FAILED,
} satisfies EventMessage);

const shutdownResponder = (responder: Responder) =>
  Effect.tryPromise({
    catch: (cause) => cause,
    try: () => responder.shutdown(),
  }).pipe(Effect.catchCause(() => logAdvertisementFailure));

const publish = (options: AdvertisementOptions) =>
  Effect.gen(function* publishLanAdvertisement() {
    const responder = yield* Effect.acquireRelease(
      Effect.try({
        catch: (cause) => cause,
        try: () => getResponder(options.responder),
      }),
      shutdownResponder,
    );
    const service = yield* Effect.try({
      catch: (cause) => cause,
      try: () => responder.createService(options.service),
    });
    service.on("name-change", (name) => {
      void name;
    });
    yield* Effect.tryPromise({
      catch: (cause) => cause,
      try: () => service.advertise(),
    });
    return yield* Effect.never;
  });

const runLanAdvertisement = (
  server: Readonly<Config["Service"]["server"]>,
  listenerAddress: AddressInfo | string | null,
) =>
  Effect.suspend(() => {
    if (!server.lanDiscovery) {
      return Effect.void;
    }
    const options = makeAdvertisementOptions(server, listenerAddress, networkInterfaces());
    if (options === undefined) {
      return logAdvertisementFailure;
    }
    return Effect.scoped(publish(options));
  }).pipe(
    Effect.catchCause((cause) => {
      if (Cause.hasInterruptsOnly(cause)) {
        return Effect.failCause(cause);
      }
      return logAdvertisementFailure;
    }),
  );

export { runLanAdvertisement };
