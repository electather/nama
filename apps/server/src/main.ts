import { NodeRuntime } from "@effect/platform-node";
import { Cause, Exit, Runtime } from "effect";

import { app } from "./app.ts";

const SUCCESS_EXIT_CODE = 0;

const teardown = <Error, Value>(
  exit: Readonly<Exit.Exit<Error, Value>>,
  onExit: (code: number) => void,
): void => {
  if (Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)) {
    onExit(SUCCESS_EXIT_CODE);
    return;
  }
  Runtime.defaultTeardown(exit, onExit);
};

NodeRuntime.runMain(app, {
  disableErrorReporting: true,
  teardown,
});
