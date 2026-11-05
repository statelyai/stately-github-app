import { createPrivateKey } from "node:crypto";
import { z } from "zod";

const httpsEndpoint = z.url().refine((value) => {
  const url = URL.parse(value);
  return (
    url !== null &&
    url.protocol === "https:" &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash
  );
});
const environment = z.object({
  APP_ID: z.string().regex(/^[1-9]\d{0,15}$/),
  PRIVATE_KEY: z.string().min(1).max(20_000),
  WEBHOOK_SECRET: z
    .string()
    .refine(
      (secret) =>
        Buffer.byteLength(secret) >= 32 && Buffer.byteLength(secret) <= 1024,
    ),
  STATELY_DOCUMENTATION_WEBHOOK_URL: z
    .union([httpsEndpoint, z.literal("")])
    .optional(),
});

export function readConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = environment.safeParse(env);
  // Never include validation inputs or private-key parser errors in diagnostics.
  if (!parsed.success) throw new Error("Invalid GitHub App configuration");
  const config = {
    ...parsed.data,
    PRIVATE_KEY: parsed.data.PRIVATE_KEY.trim().startsWith("-----BEGIN")
      ? parsed.data.PRIVATE_KEY.replace(/\\n/g, "\n")
      : Buffer.from(parsed.data.PRIVATE_KEY, "base64").toString("utf8"),
  };
  try {
    const key = createPrivateKey(config.PRIVATE_KEY);
    if (
      key.asymmetricKeyType !== "rsa" ||
      (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048
    )
      throw new Error("Invalid key");
  } catch {
    throw new Error("Invalid GitHub App configuration");
  }
  return config;
}
export type Config = ReturnType<typeof readConfig>;
