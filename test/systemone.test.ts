import test from "node:test";
import assert from "node:assert/strict";
import { parseConfig } from "../src/config.js";
import { buildSystemOneRequest } from "../src/systemone.js";

const config = parseConfig({
  backend: "laya",
  layaUrl: "http://127.0.0.1:8765",
  profiles: { fast: { description: "Small edits", model: "gpt-6-luna", effort: "low" } }
});

test("Laya uses the coding-task checkpoint", () => {
  const request = buildSystemOneRequest(config, "Rename the README heading only.");
  assert.equal(request.model, "typed-decisions");
});

test("Jev uses its hosted alias", () => {
  const request = buildSystemOneRequest({ ...config, backend: "jev" }, "Classify this task.");
  assert.equal(request.model, "jev-latest");
});
