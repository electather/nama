import { create } from "@bufbuild/protobuf";
import { parsePath } from "@bufbuild/protobuf/reflect";
import type { Validator } from "@bufbuild/protovalidate";
import {
  CompilationError,
  RuntimeError,
  ValidationError,
  Violation,
} from "@bufbuild/protovalidate";
import { SignInRequestSchema } from "@nama/api/nama/api/v1/auth_pb.js";
import { CreateAdministratorRequestSchema } from "@nama/api/nama/api/v1/setup_pb.js";
import { expect, test } from "vitest";

import { createRequestValidator } from "../request-validation.ts";

const FIELD_ERROR_LIMIT = 50;
const INVALID_FORMAT_DESCRIPTION = "has an invalid format";
const OUT_OF_RANGE_DESCRIPTION = "is outside the permitted range";
const REQUIRED_DESCRIPTION = "is required";
const VALID_EMAIL = "administrator@example.com";
const VALID_PASSWORD = "password";

const createAdministratorRequest = (password: string) =>
  create(CreateAdministratorRequestSchema, {
    bootstrapToken: "bootstrap-token",
    displayName: "Administrator",
    email: VALID_EMAIL,
    password,
  });

const signInRequest = (password: string) =>
  create(SignInRequestSchema, { email: VALID_EMAIL, password });

const passwordRequests = [
  {
    request: createAdministratorRequest,
    schema: CreateAdministratorRequestSchema,
    title: "CreateAdministratorRequest",
  },
  {
    request: signInRequest,
    schema: SignInRequestSchema,
    title: "SignInRequest",
  },
] as const;

const PASSWORD_LENGTH_BELOW_MINIMUM = 7;
const PASSWORD_MINIMUM_LENGTH = 8;
const PASSWORD_MAXIMUM_LENGTH = 128;
const PASSWORD_LENGTH_ABOVE_MAXIMUM = 129;
const invalidPasswordLengths = [
  PASSWORD_LENGTH_BELOW_MINIMUM,
  PASSWORD_LENGTH_ABOVE_MAXIMUM,
] as const;
const validPasswordLengths = [PASSWORD_MINIMUM_LENGTH, PASSWORD_MAXIMUM_LENGTH] as const;

test.each(passwordRequests)(
  "$title maps passwords outside the 8-128 character range to a safe OUT_OF_RANGE error",
  ({ request, schema }) => {
    const requestValidator = createRequestValidator();

    for (const length of invalidPasswordLengths) {
      const decodedRequest = request("a".repeat(length));

      expect(requestValidator.validate(schema, decodedRequest)).toEqual({
        fieldErrors: [
          {
            description: OUT_OF_RANGE_DESCRIPTION,
            field: "password",
            reason: "OUT_OF_RANGE",
          },
        ],
        kind: "invalid",
      });
    }
  },
);

test.each(passwordRequests)(
  "$title accepts passwords at the 8 and 128 character boundaries",
  ({ request, schema }) => {
    const requestValidator = createRequestValidator();

    for (const length of validPasswordLengths) {
      const decodedRequest = request("a".repeat(length));

      expect(requestValidator.validate(schema, decodedRequest)).toEqual({
        kind: "valid",
      });
    }
  },
);

test("SignInRequest maps an invalid email to a fixed safe field error", () => {
  const requestValidator = createRequestValidator();
  const decodedRequest = create(SignInRequestSchema, {
    email: "not-an-email",
    password: VALID_PASSWORD,
  });

  expect(requestValidator.validate(SignInRequestSchema, decodedRequest)).toEqual({
    fieldErrors: [
      {
        description: INVALID_FORMAT_DESCRIPTION,
        field: "email",
        reason: "INVALID_FORMAT",
      },
    ],
    kind: "invalid",
  });
});

test("CreateAdministratorRequest maps absent required text fields to fixed safe errors", () => {
  const requestValidator = createRequestValidator();
  const decodedRequest = create(CreateAdministratorRequestSchema, {
    bootstrapToken: "",
    displayName: "",
    email: VALID_EMAIL,
    password: VALID_PASSWORD,
  });

  expect(requestValidator.validate(CreateAdministratorRequestSchema, decodedRequest)).toEqual({
    fieldErrors: [
      {
        description: REQUIRED_DESCRIPTION,
        field: "bootstrap_token",
        reason: "REQUIRED",
      },
      {
        description: REQUIRED_DESCRIPTION,
        field: "display_name",
        reason: "REQUIRED",
      },
    ],
    kind: "invalid",
  });
});

test("request validation sorts Protobuf field paths and caps public errors at 50", () => {
  const violationPaths = [
    ...Array.from({ length: 13 }, () => "password"),
    ...Array.from({ length: 13 }, () => "email"),
    ...Array.from({ length: 13 }, () => "display_name"),
    ...Array.from({ length: 12 }, () => "bootstrap_token"),
  ];
  const violations = violationPaths.map(
    (path, index) =>
      new Violation(
        `private validator message ${index}`,
        "string.email",
        parsePath(CreateAdministratorRequestSchema, path),
        [],
        false,
      ),
  );
  const decodedRequest = createAdministratorRequest(VALID_PASSWORD);
  const injectedValidator = {
    validate: (_schema, message) => ({
      error: new ValidationError(violations),
      kind: "invalid" as const,
      message,
      violations,
    }),
  } satisfies Validator;
  const requestValidator = createRequestValidator(injectedValidator);
  const expectedFields = [
    ...Array.from({ length: 12 }, () => "bootstrap_token"),
    ...Array.from({ length: 13 }, () => "display_name"),
    ...Array.from({ length: 13 }, () => "email"),
    ...Array.from({ length: 12 }, () => "password"),
  ];

  const result = requestValidator.validate(CreateAdministratorRequestSchema, decodedRequest);

  expect(result).toEqual({
    fieldErrors: expectedFields.map((field) => ({
      description: INVALID_FORMAT_DESCRIPTION,
      field,
      reason: "INVALID_FORMAT",
    })),
    kind: "invalid",
  });
  if (result.kind === "invalid") {
    expect(result.fieldErrors).toHaveLength(FIELD_ERROR_LIMIT);
  }
});

test.each([
  { error: new CompilationError("private compilation failure"), title: "compilation" },
  { error: new RuntimeError("private runtime failure"), title: "runtime" },
])("validator $title failures normalize to a safe internal validation defect", ({ error }) => {
  const decodedRequest = signInRequest(VALID_PASSWORD);
  const injectedValidator = {
    validate: (_schema, message) => ({
      error,
      kind: "error" as const,
      message,
      violations: undefined,
    }),
  } satisfies Validator;
  const requestValidator = createRequestValidator(injectedValidator);

  expect(requestValidator.validate(SignInRequestSchema, decodedRequest)).toEqual({
    kind: "defect",
  });
});
