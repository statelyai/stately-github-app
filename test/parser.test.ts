import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { extractDiagrams, MAX_SOURCE_BYTES } from "../lib/parser.js";

test("extracts static machine topology without context, actions or runtime execution", async () => {
  const sentinel = `/tmp/stately-never-execute-${randomUUID()}`;
  const source = `import {createMachine} from 'xstate';
    require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'executed');
    createMachine({context:{password:'super-secret-context'},initial:'idle',states:{idle:{on:{GO:'active'},entry:()=>{throw new Error('executed')}},active:{type:'final'}}});`;
  const diagrams = await extractDiagrams(source);
  assert.equal(diagrams.length, 1);
  assert.match(diagrams[0]?.mermaid ?? "", /n0 --> n1: GO/);
  assert.equal(
    JSON.stringify(diagrams).includes("super-secret-context"),
    false,
  );
  assert.equal(existsSync(sentinel), false);
});

test("quotes hostile labels as entities and cannot break a Markdown fence or Mermaid syntax", async () => {
  const hostile =
    "`".repeat(3) + '\n</script>"; click n0 "https://attacker.test"';
  const source = `createMachine({initial:${JSON.stringify(hostile)},states:{${JSON.stringify(hostile)}:{on:{${JSON.stringify(hostile)}:'safe'}},safe:{}}});`;
  const [diagram] = await extractDiagrams(source);
  assert.ok(diagram);
  assert.equal(diagram.mermaid.includes("```"), false);
  assert.equal(diagram.mermaid.includes("</script>"), false);
  assert.equal(diagram.mermaid.includes("https://"), false);
  assert.match(diagram.mermaid, /#96;/);
});

test("isolates malformed/deep source and refuses over-budget files", async () => {
  assert.deepEqual(await extractDiagrams("x".repeat(MAX_SOURCE_BYTES + 1)), []);
  assert.deepEqual(await extractDiagrams("createMachine("), []);
  assert.deepEqual(
    await extractDiagrams("(".repeat(15_000) + "x" + ")".repeat(15_000)),
    [],
  );
  assert.equal(
    (await extractDiagrams("createMachine({states:{ok:{}}})")).length,
    1,
  );
});

test("resolves nested, relative and explicit ID targets", async () => {
  const [diagram] = await extractDiagrams(
    `createMachine({id:'root',initial:'a',states:{a:{initial:'one',states:{one:{on:{NEXT:'two'}},two:{on:{OUT:'#done'}}}},done:{id:'done',type:'final'}}})`,
  );
  assert.ok(diagram);
  assert.match(diagram.mermaid, /n1 --> n2: NEXT/);
  assert.match(diagram.mermaid, /n2 --> n3: OUT/);
});

test("supports static setup.createMachine topology", async () => {
  const diagrams = await extractDiagrams(
    "import {setup} from 'xstate'; setup({}).createMachine({initial:'idle',states:{idle:{on:{GO:'done'}},done:{type:'final'}}});",
  );
  assert.equal(diagrams.length, 1);
  assert.match(diagrams[0]?.mermaid ?? "", /n0 --> n1: GO/);
});
