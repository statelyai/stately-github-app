// You can import your modules
// import index from '../src/index'

import nock from "nock";
// Requiring our app implementation
import { probotApp } from "../lib/app";
import { Probot, ProbotOctokit } from "probot";
// Requiring our fixtures


const fs = require("fs");
const path = require("path");

const privateKey = fs.readFileSync(
  path.join(__dirname, "fixtures/mock-cert.pem"),
  "utf-8"
);

describe("My Probot app", () => {
  let probot: any;

  beforeEach(() => {
    nock.disableNetConnect();
    probot = new Probot({
      appId: 123,
      privateKey,
      // disable request throttling and retries for testing
      Octokit: ProbotOctokit.defaults({
        retry: { enabled: false },
        throttle: { enabled: false },
      }),
    });
    // Load our app into probot
    probot.load(probotApp);
  });

  test("ignores documentation events while integration is disabled", async () => {
    await probot.receive({ id: "delivery", name: "push", payload: { ref: "refs/heads/main" } });
    expect(nock.pendingMocks()).toEqual([]);
  });

  afterEach(() => {
    nock.cleanAll();
    nock.enableNetConnect();
  });
});

// For more information about testing with Jest see:
// https://facebook.github.io/jest/

// For more information about using TypeScript in your tests, Jest recommends:
// https://github.com/kulshekhar/ts-jest

// For more information about testing with Nock see:
// https://github.com/nock/nock

test("Probot rejects tampered push deliveries before forwarding", async () => {
  const app = new Probot({ appId: 123, privateKey, secret: "signature-secret" });
  app.load(probotApp);
  await expect(app.webhooks.verifyAndReceive({ id: "delivery", name: "push", payload: "{}", signature: "sha256=" + "0".repeat(64) })).rejects.toThrow();
});
