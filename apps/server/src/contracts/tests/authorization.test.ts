import { expect, test } from "vitest";

import { contractAuthorityByMethod } from "../authorization.ts";
import { pluginServices } from "./plugin-services.test-support.ts";
import { publicServices } from "./public-services.test-support.ts";

interface ContractService {
  readonly methods: readonly { readonly name: string }[];
  readonly typeName: string;
}

const methodNames = (services: readonly ContractService[]): string[] =>
  services.flatMap((service) =>
    Object.values(service.methods).map((method) => `${service.typeName}.${method.name}`),
  );

test("every generated method has exactly one explicit authority", () => {
  const generatedMethods = methodNames([...publicServices, ...pluginServices]);
  const pluginMethods = methodNames(pluginServices);

  expect(Object.keys(contractAuthorityByMethod).toSorted()).toEqual(generatedMethods.toSorted());
  for (const method of pluginMethods) {
    expect(Reflect.get(contractAuthorityByMethod, method)).toBe("plugin-bearer");
  }
  expect(
    Reflect.get(contractAuthorityByMethod, "nama.api.v1.UnknownService.UnknownMethod"),
  ).toBeUndefined();
});
