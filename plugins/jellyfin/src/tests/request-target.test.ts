import { expect, it } from "vitest";

import { INVALID_REQUEST_TARGET, normalizedBaseUrl } from "../request-target.ts";

it("requires HTTPS only for public Jellyfin destinations", () => {
  for (const url of ["https://jellyfin.example.com", "https://203.0.113.10"]) {
    expect(normalizedBaseUrl(url)).not.toBe(INVALID_REQUEST_TARGET);
  }
  for (const url of ["http://jellyfin.example.com", "http://203.0.113.10"]) {
    expect(normalizedBaseUrl(url)).toBe(INVALID_REQUEST_TARGET);
  }
  expect(normalizedBaseUrl("http://192.168.1.10:8096")).not.toBe(INVALID_REQUEST_TARGET);
});
