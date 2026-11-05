import { createHmac } from "node:crypto";
import { request } from "node:https";

/** Input is projected from an authenticated delivery; no installation credentials. */
export async function forwardDocumentationEvent(
  event: string,
  deliveryId: string,
  payload: unknown,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (!env.STATELY_DOCUMENTATION_WEBHOOK_URL) return;
  const target = new URL(env.STATELY_DOCUMENTATION_WEBHOOK_URL);
  if (
    target.protocol !== "https:" ||
    target.username ||
    target.password ||
    target.search ||
    target.hash
  )
    throw new Error("Invalid documentation webhook URL");
  if (!env.WEBHOOK_SECRET) throw new Error("WEBHOOK_SECRET is required");
  const body = JSON.stringify(payload);
  if (Buffer.byteLength(body) > 1_000_000)
    throw new Error("Documentation event too large");
  const signature = `sha256=${createHmac("sha256", env.WEBHOOK_SECRET).update(body).digest("hex")}`;
  await new Promise<void>((resolve, reject) => {
    // Absolute deadline includes DNS, connection establishment and a trickling response.
    const req = request(
      target,
      {
        method: "POST",
        signal: AbortSignal.timeout(10_000),
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          "x-github-event": event,
          "x-github-delivery": deliveryId,
          "x-hub-signature-256": signature,
        },
      },
      (res) => {
        res.resume();
        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300)
            resolve();
          else reject(new Error("Documentation webhook delivery failed"));
        });
        res.on("error", () =>
          reject(new Error("Documentation webhook delivery failed")),
        );
      },
    );
    req.on("error", () =>
      reject(new Error("Documentation webhook delivery failed")),
    );
    req.end(body);
  });
}
