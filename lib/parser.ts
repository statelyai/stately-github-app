import { resolve } from "node:path";
import { Worker } from "node:worker_threads";
import { diagramsSchema, type Diagram } from "./diagrams.js";

export const MAX_SOURCE_BYTES = 100 * 1024;
export function extractDiagrams(
  source: string,
  signal?: AbortSignal,
): Promise<Diagram[]> {
  if (signal?.aborted || Buffer.byteLength(source) > MAX_SOURCE_BYTES)
    return Promise.resolve([]);
  return new Promise((resolveResult) => {
    const worker = new Worker(resolve("dist/parser-worker.cjs"), {
      workerData: source,
      env: {},
      execArgv: [],
      resourceLimits: {
        maxOldGenerationSizeMb: 128,
        maxYoungGenerationSizeMb: 16,
        stackSizeMb: 2,
      },
    });
    let settled = false;
    const finish = (result: Diagram[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      void worker.terminate();
      resolveResult(result);
    };
    const timer = setTimeout(() => finish([]), 3000);
    const abort = () => finish([]);
    signal?.addEventListener("abort", abort, { once: true });
    worker.once("message", (message: unknown) => {
      const parsed = diagramsSchema.safeParse(message);
      finish(parsed.success ? parsed.data : []);
    });
    worker.once("error", () => finish([]));
    worker.once("exit", () => finish([]));
  });
}
