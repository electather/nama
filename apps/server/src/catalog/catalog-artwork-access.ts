import { createHmac, hkdf, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import type { ArtworkLocator } from "@nama/api/nama/api/v1/media_pb.js";
import { Context, Data, Effect, Layer, Redacted } from "effect";

import { Config } from "../config/config.ts";
import type {
  CatalogArtworkTarget,
  CatalogQueryStorage,
} from "../database/catalog-query-storage.ts";
import { Database } from "../database/database.ts";

const ZERO = 0;
const UUID_FIRST_GROUP_END = 8;
const UUID_SECOND_GROUP_END = 12;
const UUID_THIRD_GROUP_END = 16;
const UUID_FOURTH_GROUP_END = 20;

const ACCESS_TOKEN_VERSION = 1;
const ACCESS_TOKEN_KEY_BYTES = 32;
const ACCESS_TOKEN_PAYLOAD_BYTES = 25;
const ACCESS_TOKEN_SIGNATURE_BYTES = 32;
const ACCESS_TOKEN_BYTES = ACCESS_TOKEN_PAYLOAD_BYTES + ACCESS_TOKEN_SIGNATURE_BYTES;
const ACCESS_TOKEN_LIFETIME_MILLISECONDS = 600_000;
const ACCESS_TOKEN_REFRESH_MILLISECONDS = 300_000;
const ACCESS_TOKEN_VERSION_OFFSET = 0;
const ARTWORK_ID_OFFSET = 1;
const ACCESS_EXPIRES_AT_OFFSET = 17;
const SIGNATURE_OFFSET = ACCESS_TOKEN_PAYLOAD_BYTES;
const MASTER_KEY_PREFIX = "base64:";
const HKDF_HASH = "sha256";
const ARTWORK_ACCESS_KEY_INFO = Buffer.from("nama/artwork-access/v1", "utf8");
const EMPTY_HKDF_SALT = Buffer.alloc(ZERO);
const BASE64URL_TOKEN = /^[A-Za-z0-9_-]+$/u;
const UUID = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/u;
const MAXIMUM_SAFE_INTEGER = BigInt(Number.MAX_SAFE_INTEGER);
const deriveHkdfOutput = promisify(hkdf);

interface ArtworkLocatorInput {
  readonly artworkId: string;
  readonly height?: number | undefined;
  readonly now: number;
  readonly width?: number | undefined;
}

interface StoredArtworkAsset {
  readonly bytes: Buffer;
  readonly mimeType: string;
}

interface ArtworkAccessService {
  readonly locator: (input: ArtworkLocatorInput) => ArtworkLocator;
  readonly read: (
    token: string,
    now: number,
  ) => Effect.Effect<StoredArtworkAsset, ArtworkAccessNotFoundFailure>;
}

interface ArtworkAccessDependencies {
  readonly catalog: CatalogQueryStorage;
  readonly masterKey: string;
  readonly publicUrl: string;
}

const taggedError = Data.TaggedError;
const ArtworkAccessNotFound = taggedError("ArtworkAccessNotFound")<Record<string, never>>;
type ArtworkAccessNotFoundFailure = InstanceType<typeof ArtworkAccessNotFound>;
const notFound = (): ArtworkAccessNotFoundFailure => new ArtworkAccessNotFound({});

const uuidBytes = (uuid: string): Buffer => {
  if (!UUID.test(uuid)) {
    throw notFound();
  }
  return Buffer.from(uuid.replaceAll("-", ""), "hex");
};

const uuidFromBytes = (bytes: Buffer): string => {
  const hex = bytes.toString("hex");
  return `${hex.slice(ZERO, UUID_FIRST_GROUP_END)}-${hex.slice(UUID_FIRST_GROUP_END, UUID_SECOND_GROUP_END)}-${hex.slice(UUID_SECOND_GROUP_END, UUID_THIRD_GROUP_END)}-${hex.slice(UUID_THIRD_GROUP_END, UUID_FOURTH_GROUP_END)}-${hex.slice(UUID_FOURTH_GROUP_END)}`;
};

const sign = (key: Buffer, payload: Buffer): Buffer =>
  createHmac(HKDF_HASH, key).update(payload).digest();

const decodeTokenBytes = (token: string): Buffer => {
  if (!BASE64URL_TOKEN.test(token)) {
    throw notFound();
  }
  const bytes = Buffer.from(token, "base64url");
  if (bytes.byteLength !== ACCESS_TOKEN_BYTES || bytes.toString("base64url") !== token) {
    bytes.fill(ZERO);
    throw notFound();
  }
  return bytes;
};

const verifyTokenSignature = (key: Buffer, bytes: Buffer): void => {
  const payload = bytes.subarray(ZERO, SIGNATURE_OFFSET);
  const suppliedSignature = bytes.subarray(SIGNATURE_OFFSET);
  const expectedSignature = sign(key, payload);
  try {
    if (!timingSafeEqual(expectedSignature, suppliedSignature)) {
      throw notFound();
    }
  } finally {
    expectedSignature.fill(ZERO);
  }
};

const artworkIdFromToken = (bytes: Buffer, now: number): string => {
  if (bytes.readUInt8(ACCESS_TOKEN_VERSION_OFFSET) !== ACCESS_TOKEN_VERSION) {
    throw notFound();
  }
  const expiresAt = bytes.readBigUInt64BE(ACCESS_EXPIRES_AT_OFFSET);
  if (expiresAt > MAXIMUM_SAFE_INTEGER || Number(expiresAt) <= now) {
    throw notFound();
  }
  return uuidFromBytes(bytes.subarray(ARTWORK_ID_OFFSET, ACCESS_EXPIRES_AT_OFFSET));
};

const encodeToken = (key: Buffer, artworkId: string, expiresAt: number): string => {
  const payload = Buffer.alloc(ACCESS_TOKEN_PAYLOAD_BYTES);
  payload.writeUInt8(ACCESS_TOKEN_VERSION, ACCESS_TOKEN_VERSION_OFFSET);
  uuidBytes(artworkId).copy(payload, ARTWORK_ID_OFFSET);
  payload.writeBigUInt64BE(BigInt(expiresAt), ACCESS_EXPIRES_AT_OFFSET);
  const signature = sign(key, payload);
  try {
    return Buffer.concat([payload, signature], ACCESS_TOKEN_BYTES).toString("base64url");
  } finally {
    payload.fill(ZERO);
    signature.fill(ZERO);
  }
};

const decodeToken = (key: Buffer, token: string, now: number): string => {
  const bytes = decodeTokenBytes(token);
  try {
    verifyTokenSignature(key, bytes);
    return artworkIdFromToken(bytes, now);
  } finally {
    bytes.fill(ZERO);
  }
};

const deriveArtworkAccessKey = async (encodedMasterKey: string): Promise<Buffer> => {
  if (!encodedMasterKey.startsWith(MASTER_KEY_PREFIX)) {
    throw notFound();
  }
  const masterKey = Buffer.from(encodedMasterKey.slice(MASTER_KEY_PREFIX.length), "base64");
  if (masterKey.byteLength !== ACCESS_TOKEN_KEY_BYTES) {
    masterKey.fill(ZERO);
    throw notFound();
  }
  try {
    return Buffer.from(
      await deriveHkdfOutput(
        HKDF_HASH,
        masterKey,
        EMPTY_HKDF_SALT,
        ARTWORK_ACCESS_KEY_INFO,
        ACCESS_TOKEN_KEY_BYTES,
      ),
    );
  } finally {
    masterKey.fill(ZERO);
  }
};

const assetFromTarget = (target: CatalogArtworkTarget | undefined): StoredArtworkAsset => {
  if (target === undefined || target.assetBytes === null || target.assetMimeType === null) {
    throw notFound();
  }
  return { bytes: target.assetBytes, mimeType: target.assetMimeType };
};

const requireArtworkAccessOpen = (closed: boolean): void => {
  if (closed) {
    throw notFound();
  }
};

const makeArtworkAccess = async ({
  catalog,
  masterKey,
  publicUrl,
}: ArtworkAccessDependencies): Promise<ArtworkAccessService & { readonly close: () => void }> => {
  const key = await deriveArtworkAccessKey(masterKey);
  const publicOrigin = new URL(publicUrl).origin;
  let closed = false;
  const encode = (artworkId: string, expiresAt: number): string => {
    requireArtworkAccessOpen(closed);
    return encodeToken(key, artworkId, expiresAt);
  };
  const decode = (token: string, now: number): string => {
    requireArtworkAccessOpen(closed);
    return decodeToken(key, token, now);
  };
  return Object.freeze({
    close: () => {
      if (!closed) {
        closed = true;
        key.fill(ZERO);
      }
    },
    locator: (input: ArtworkLocatorInput): ArtworkLocator => {
      const { artworkId, height, now, width } = input;
      const accessExpiresAt = now + ACCESS_TOKEN_LIFETIME_MILLISECONDS;
      const refreshAt = now + ACCESS_TOKEN_REFRESH_MILLISECONDS;
      const token = encode(artworkId, accessExpiresAt);
      return {
        $typeName: "nama.api.v1.ArtworkLocator",
        accessExpiresAt: timestampFromDate(new Date(accessExpiresAt)),
        allowedRedirectOrigins: [publicOrigin],
        headers: [],
        height,
        refreshAt: timestampFromDate(new Date(refreshAt)),
        url: new URL(`artwork/${token}`, publicUrl).toString(),
        width,
      };
    },
    read: (token: string, now: number) =>
      Effect.tryPromise({
        catch: () => notFound(),
        try: () => catalog.getArtworkTarget(decode(token, now)),
      }).pipe(Effect.map(assetFromTarget)),
  });
};

const contextService = Context.Service;
class ArtworkAccess extends contextService<ArtworkAccess, ArtworkAccessService>()(
  "@nama/server/ArtworkAccess",
) {
  static readonly layer = Layer.effect(
    ArtworkAccess,
    Effect.gen(function* makeArtworkAccessService() {
      const config = yield* Config;
      const database = yield* Database;
      return yield* Effect.acquireRelease(
        Effect.promise(() =>
          makeArtworkAccess({
            catalog: database.catalogQueries,
            masterKey: Redacted.value(config.security.masterKey),
            publicUrl: config.server.publicUrl,
          }),
        ),
        (service) => Effect.sync(service.close),
      );
    }),
  );
}

export { ArtworkAccess, makeArtworkAccess };
export type {
  ArtworkAccessDependencies,
  ArtworkAccessNotFoundFailure,
  ArtworkAccessService,
  ArtworkLocatorInput,
  StoredArtworkAsset,
};
