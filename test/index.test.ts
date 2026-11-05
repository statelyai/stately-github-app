import assert from "node:assert/strict";
import { test } from "node:test";
import { readConfig } from "../lib/config.js";
import { config, privateKey, secret } from "./helpers.js";

test("requires valid RSA app credentials and a strong non-default secret without leaking inputs", () => {
  assert.equal(config().APP_ID, "123");
  assert.equal(
    readConfig({
      APP_ID: "123",
      PRIVATE_KEY: privateKey.replace(/\n/g, "\\n"),
      WEBHOOK_SECRET: secret,
    }).PRIVATE_KEY,
    privateKey,
  );
  assert.equal(
    readConfig({
      APP_ID: "123",
      PRIVATE_KEY: Buffer.from(privateKey).toString("base64"),
      WEBHOOK_SECRET: secret,
    }).PRIVATE_KEY,
    privateKey,
  );
  for (const env of [
    { APP_ID: "123", PRIVATE_KEY: privateKey, WEBHOOK_SECRET: "development" },
    { APP_ID: "bad", PRIVATE_KEY: privateKey, WEBHOOK_SECRET: secret },
    {
      APP_ID: "123",
      PRIVATE_KEY: `sensitive invalid private key ${secret}`,
      WEBHOOK_SECRET: secret,
    },
  ]) {
    assert.throws(
      () => readConfig(env),
      (error) =>
        error instanceof Error &&
        error.message === "Invalid GitHub App configuration",
    );
  }
});
