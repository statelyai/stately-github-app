import { parentPort, workerData } from "node:worker_threads";
import { extractMachinesFromFile } from "@xstate/machine-extractor";
import { toMermaid, type Diagram } from "./diagrams.js";

const source: unknown = workerData;
const diagrams: Diagram[] = [];
if (typeof source === "string" && Buffer.byteLength(source) <= 100 * 1024) {
  try {
    const result = extractMachinesFromFile(source);
    for (const machine of result?.machines.slice(0, 10) ?? []) {
      try {
        if (!machine) continue;
        const config = machine.toConfig();
        const line = machine.machineCallResult.definition?.node.loc?.start.line;
        if (!config || !line || machine.getIsIgnored()) continue;
        const mermaid = toMermaid(config);
        if (mermaid) diagrams.push({ line, mermaid });
      } catch {
        /* Unsupported or oversized machines do not block other previews. */
      }
    }
  } catch {
    /* Invalid source is an expected input, not a diagnostic containing private code. */
  }
}
parentPort?.postMessage(diagrams);
