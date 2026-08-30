// oxlint-disable eslint/no-magic-numbers -- Literal private-network ranges and address masks keep the request confinement policy auditable.
import { isIP } from "node:net";

const EMPTY_LENGTH = 0;
const BITS_PER_IPV4_OCTET = 8;
const IPV4_OCTET_MASK = 255;
const FAILURE_SENTINEL = Symbol("failure");
const NO_MAPPED_IPV4 = Symbol("no mapped IPv4 address");
const INVALID_REQUEST_TARGET = Symbol("invalid Jellyfin request target");

const isPrivateIpv4 = (hostname: string): boolean => {
  const octets = hostname.split(".").map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet))) {
    return false;
  }
  const [first = -1, second = -1] = octets;
  return (
    first === 10 ||
    first === 127 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
};

// oxlint-disable-next-line eslint/max-statements -- IPv4-mapped IPv6 decoding keeps validation and bit assembly in one auditable parser.
const mappedIpv4Address = (hostname: string) => {
  const prefix = "::ffff:";
  if (!hostname.startsWith(prefix)) {
    return NO_MAPPED_IPV4;
  }
  const suffix = hostname.slice(prefix.length);
  if (isIP(suffix) === 4) {
    return suffix;
  }
  const [highText, lowText, ...extra] = suffix.split(":");
  if (
    highText === undefined ||
    lowText === undefined ||
    extra.length > EMPTY_LENGTH ||
    !/^[\da-f]{1,4}$/u.test(highText) ||
    !/^[\da-f]{1,4}$/u.test(lowText)
  ) {
    return NO_MAPPED_IPV4;
  }
  const high = Number.parseInt(highText, 16);
  const low = Number.parseInt(lowText, 16);
  return `${high >>> BITS_PER_IPV4_OCTET}.${high & IPV4_OCTET_MASK}.${low >>> BITS_PER_IPV4_OCTET}.${low & IPV4_OCTET_MASK}`;
};

const isPrivateIpv6 = (hostname: string): boolean => {
  const normalized = hostname.toLowerCase();
  const mappedIpv4 = mappedIpv4Address(normalized);
  if (mappedIpv4 !== NO_MAPPED_IPV4) {
    return isPrivateIpv4(mappedIpv4);
  }
  return (
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe8") ||
    normalized.startsWith("fe9") ||
    normalized.startsWith("fea") ||
    normalized.startsWith("feb")
  );
};

const isPrivateHostname = (hostname: string): boolean => {
  const normalized = hostname.replaceAll(/^\[|\]$/gu, "").toLowerCase();
  const addressFamily = isIP(normalized);
  if (addressFamily === 4) {
    return isPrivateIpv4(normalized);
  }
  if (addressFamily === 6) {
    return isPrivateIpv6(normalized);
  }
  return (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local") ||
    !normalized.includes(".")
  );
};

const normalizedBaseUrl = (value: string) => {
  const parsed = (() => {
    try {
      return new URL(value);
    } catch {
      return FAILURE_SENTINEL;
    }
  })();
  if (parsed === FAILURE_SENTINEL) {
    return INVALID_REQUEST_TARGET;
  }
  const pathSegments = parsed.pathname
    .split("/")
    .filter((segment) => segment.length > EMPTY_LENGTH);
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username.length > EMPTY_LENGTH ||
    parsed.password.length > EMPTY_LENGTH ||
    parsed.search.length > EMPTY_LENGTH ||
    parsed.hash.length > EMPTY_LENGTH ||
    pathSegments.length > 1 ||
    !isPrivateHostname(parsed.hostname)
  ) {
    return INVALID_REQUEST_TARGET;
  }
  parsed.pathname = "/";
  if (pathSegments.length > EMPTY_LENGTH) {
    parsed.pathname = `/${pathSegments[0]}/`;
  }
  return parsed;
};

const applyConfinedQuery = (
  endpoint: URL,
  query: Readonly<Record<string, string>> | undefined,
): boolean => {
  for (const [name, value] of Object.entries(query ?? {})) {
    if (name.length === EMPTY_LENGTH || value.length === EMPTY_LENGTH) {
      return false;
    }
    endpoint.searchParams.set(name, value);
  }
  return true;
};

const confinedEndpoint = (
  baseUrl: URL,
  pathSegments: readonly string[],
  query?: Readonly<Record<string, string>>,
) => {
  if (
    pathSegments.length === EMPTY_LENGTH ||
    pathSegments.some((segment) => segment.length === EMPTY_LENGTH)
  ) {
    return INVALID_REQUEST_TARGET;
  }
  const encodedPath = pathSegments.map((segment) => encodeURIComponent(segment)).join("/");
  const expectedPathname = `${baseUrl.pathname}${encodedPath}`;
  const endpoint = new URL(encodedPath, baseUrl);
  if (
    endpoint.origin !== baseUrl.origin ||
    endpoint.pathname !== expectedPathname ||
    !endpoint.pathname.startsWith(baseUrl.pathname)
  ) {
    return INVALID_REQUEST_TARGET;
  }
  if (!applyConfinedQuery(endpoint, query)) {
    return INVALID_REQUEST_TARGET;
  }
  return endpoint;
};

export { confinedEndpoint, INVALID_REQUEST_TARGET, normalizedBaseUrl };
