import { expect, it } from "vitest";

import { isValidOperationId, normalizeDisplayName } from "../pairing-values-private.ts";

const MAXIMUM_CODE_POINTS = 256;
const SUPPLEMENTARY_CODE_POINT = "😀";

it("counts Pairing boundary lengths in Unicode code points", () => {
  const maximumValue = SUPPLEMENTARY_CODE_POINT.repeat(MAXIMUM_CODE_POINTS);
  const oversizedValue = `${maximumValue}${SUPPLEMENTARY_CODE_POINT}`;

  expect(normalizeDisplayName(` ${maximumValue} `)).toBe(maximumValue);
  expect(() => normalizeDisplayName(` ${oversizedValue} `)).toThrow();
  expect(isValidOperationId(maximumValue)).toBe(true);
  expect(isValidOperationId(oversizedValue)).toBe(false);
});
