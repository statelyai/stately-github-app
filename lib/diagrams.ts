import type {
  ExtractorMachineConfig,
  ExtractorStateNodeConfig,
  ExtractrorTransitionNodeConfig,
} from "@xstate/machine-extractor";
import { z } from "zod";

export const diagramsSchema = z
  .array(
    z.object({
      line: z.number().int().positive(),
      mermaid: z.string().max(24_000),
    }),
  )
  .max(10);
export type Diagram = z.infer<typeof diagramsSchema>[number];

// Only numeric entities and inert text enter Mermaid labels; IDs are generated.
function label(value: string) {
  return [...value.slice(0, 100)]
    .map((char) =>
      /[a-zA-Z0-9 _.-]/.test(char) ? char : `#${char.codePointAt(0)};`,
    )
    .join("");
}

/** A bounded topology preview, not an executable model or behavioral verification. */
export function toMermaid(config: ExtractorMachineConfig): string | undefined {
  const lines = ["stateDiagram-v2"];
  const nodes: {
    config: ExtractorStateNodeConfig;
    path: string[];
    id: string;
  }[] = [];
  const byPath = new Map<string, string>();
  const byId = new Map<string, string>();
  const key = (path: string[]) => JSON.stringify(path);
  if (config.id) byId.set(config.id, key([]));
  function visit(
    state: ExtractorStateNodeConfig,
    path: string[],
    depth: number,
  ) {
    if (depth > 8) throw new Error("Diagram depth limit");
    const children = Object.entries(state.states ?? {});
    for (const [name, child] of children) {
      if (nodes.length >= 80) throw new Error("Diagram node limit");
      const childPath = [...path, name];
      const id = `n${nodes.length}`;
      nodes.push({ config: child, path: childPath, id });
      byPath.set(key(childPath), id);
      if (child.id) byId.set(child.id, key(childPath));
      lines.push(`state "${label(name)}" as ${id}`);
      if (Object.keys(child.states ?? {}).length) {
        lines.push(`state ${id} {`);
        visit(child, childPath, depth + 1);
        lines.push("}");
      }
      if (child.type === "final") lines.push(`${id} --> [*]`);
    }
    const initial = state.initial && byPath.get(key([...path, state.initial]));
    if (initial) lines.push(`[*] --> ${initial}`);
  }
  visit(config, [], 0);
  if (!nodes.length) return;
  function targetId(path: string[], target: string) {
    if (target.startsWith("#")) {
      const [id, ...tail] = target.slice(1).split(".");
      const prefix = id && byId.get(id);
      if (!prefix) return;
      // Resolve explicit state IDs without parsing or interpolating untrusted Mermaid IDs.
      const node = nodes.find((candidate) => key(candidate.path) === prefix);
      const prefixPath = node?.path ?? [];
      return byPath.get(key([...prefixPath, ...tail]));
    }
    return byPath.get(
      key([
        ...(target.startsWith(".") ? path : path.slice(0, -1)),
        ...target.replace(/^\./, "").split("."),
      ]),
    );
  }
  let edges = 0;
  for (const node of nodes) {
    const transitions: [
      string,
      ExtractrorTransitionNodeConfig | ExtractrorTransitionNodeConfig[],
    ][] = [
      ...Object.entries(node.config.on ?? {}),
      ...Object.entries(node.config.after ?? {}).map(
        ([delay, value]): [string, typeof value] => [`after ${delay}`, value],
      ),
    ];
    if (node.config.always) transitions.push(["always", node.config.always]);
    if (node.config.onDone) transitions.push(["done", node.config.onDone]);
    for (const [event, values] of transitions) {
      for (const transition of Array.isArray(values) ? values : [values]) {
        const targets = Array.isArray(transition.target)
          ? transition.target
          : transition.target
            ? [transition.target]
            : [];
        for (const target of targets) {
          const id = targetId(node.path, target);
          if (!id) continue;
          if (++edges > 160) throw new Error("Diagram edge limit");
          lines.push(`${node.id} --> ${id}: ${label(event)}`);
        }
      }
    }
  }
  const mermaid = lines.join("\n");
  return mermaid.length <= 24_000 ? mermaid : undefined;
}
