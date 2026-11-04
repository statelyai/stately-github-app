import nock from "nock";
import { createHmac } from "crypto";
import { forwardDocumentationEvent } from "../lib/documentation";

afterEach(() => { nock.cleanAll(); nock.enableNetConnect(); });
test("forwards authenticated event data without GitHub installation credentials", async () => {
  nock.disableNetConnect();
  const payload = { installation: { id: 123 }, repository: { id: 456 }, after: "abc" };
  const body = JSON.stringify(payload);
  const scope = nock("https://stately.test", { reqheaders: {
    "x-github-event": "push", "x-github-delivery": "delivery-1",
    "x-hub-signature-256": `sha256=${createHmac("sha256", "shared-secret").update(body).digest("hex")}`,
  } }).post("/documentation", payload).reply(202, { accepted: true });
  await forwardDocumentationEvent("push", "delivery-1", payload, { STATELY_DOCUMENTATION_WEBHOOK_URL: "https://stately.test/documentation", WEBHOOK_SECRET: "shared-secret" });
  expect(scope.isDone()).toBe(true);
});
test("rejects redirect responses, insecure targets and missing secrets", async () => {
  await expect(forwardDocumentationEvent("push", "id", {}, { STATELY_DOCUMENTATION_WEBHOOK_URL: "http://stately.test" })).rejects.toThrow();
  await expect(forwardDocumentationEvent("push", "id", {}, { STATELY_DOCUMENTATION_WEBHOOK_URL: "https://stately.test" })).rejects.toThrow();
  nock("https://stately.test").post("/").reply(302, "", { location: "https://other.test" });
  await expect(forwardDocumentationEvent("push", "id", {}, { STATELY_DOCUMENTATION_WEBHOOK_URL: "https://stately.test", WEBHOOK_SECRET: "secret" })).rejects.toThrow("delivery failed");
});
