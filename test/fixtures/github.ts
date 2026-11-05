import assert from "node:assert/strict";
import { z } from "zod";
import { headSha, repo } from "../helpers.js";

const source = `import {createMachine} from 'xstate';
const machine = createMachine({context:{secret:'do-not-copy'},initial:'idle',states:{idle:{on:{GO:'active'}},active:{type:'final'}}});`;
const file = {
  filename: "machine.ts",
  status: "modified",
  patch:
    '@@ -1,2 +1,2 @@\n import {createMachine} from "xstate";\n+const machine = createMachine({});',
};
export const payload = {
  action: "synchronize",
  number: 1,
  repository: repo,
  installation: { id: 7 },
  pull_request: { head: { sha: headSha } },
};
const reviewSchema = z.object({
  commit_id: z.literal(headSha),
  event: z.literal("COMMENT"),
  comments: z.array(
    z.object({
      path: z.string(),
      line: z.number(),
      side: z.literal("RIGHT"),
      body: z.string(),
    }),
  ),
});
type Review = z.infer<typeof reviewSchema>;

export function github(
  options: {
    source?: string;
    stale?: boolean;
    moved?: boolean;
    outsideDiff?: boolean;
    large?: boolean;
    human?: boolean;
  } = {},
) {
  const writes: Review[] = [];
  const requests: string[] = [];
  let reads = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    assert.equal(url.origin, "https://api.github.com");
    requests.push(`${request.method} ${url.pathname}${url.search}`);
    const reply = (data: unknown, headers = {}) =>
      new Response(JSON.stringify(data), {
        headers: { "content-type": "application/json", ...headers },
      });
    if (url.pathname === "/app/installations/7/access_tokens") {
      const body: unknown = await request.json();
      assert.deepEqual(body, {
        repository_ids: [22],
        permissions: { contents: "read", pull_requests: "write" },
      });
      return reply({
        token: "ghs_synthetic_test_token",
        expires_at: new Date(Date.now() + 3600_000).toISOString(),
        permissions: { contents: "read", pull_requests: "write" },
      });
    }
    if (url.pathname === "/app")
      return reply({ id: 123, slug: "stately-github" });
    if (url.pathname === "/repos/owner/repo/pulls/1") {
      reads++;
      return reply({
        state: "open",
        head: {
          sha:
            options.stale || (options.moved && reads > 1)
              ? "b".repeat(40)
              : headSha,
        },
        base: { repo: { id: 22 } },
      });
    }
    if (url.pathname.endsWith("/comments")) {
      if (!url.searchParams.has("page")) {
        return reply(
          [
            {
              body: "A human discussion",
              user: { login: "davidkpiano", type: "User" },
              commit_id: headSha,
            },
          ],
          {
            link: '<https://api.github.com/repos/owner/repo/pulls/1/comments?per_page=100&page=2>; rel="next"',
          },
        );
      }
      return reply(
        writes.flatMap((review) =>
          review.comments.map((comment) => ({
            ...comment,
            commit_id: headSha,
            user: options.human
              ? { login: "davidkpiano", type: "User" }
              : { login: "stately-github[bot]", type: "Bot" },
          })),
        ),
      );
    }
    if (url.pathname.endsWith("/files")) {
      if (!url.searchParams.has("page"))
        return reply([{ filename: "README.md", status: "modified" }], {
          link: '<https://api.github.com/repos/owner/repo/pulls/1/files?per_page=100&page=2>; rel="next"',
        });
      return reply([
        {
          ...file,
          ...(options.outsideDiff
            ? { patch: "@@ -99,1 +99,1 @@\n+unrelated" }
            : {}),
        },
        { filename: "removed.ts", status: "removed", patch: file.patch },
      ]);
    }
    if (url.pathname.endsWith("/contents/machine.ts")) {
      assert.equal(url.searchParams.get("ref"), headSha);
      const bytes = Buffer.from(options.source ?? source);
      return reply({
        type: "file",
        encoding: "base64",
        size: options.large ? 200_000 : bytes.length,
        content: bytes.toString("base64"),
      });
    }
    if (url.pathname.endsWith("/reviews") && request.method === "POST") {
      const body: unknown = await request.json();
      writes.push(reviewSchema.parse(body));
      return reply({ id: 1 });
    }
    throw new Error(
      `Unexpected GitHub API method/path: ${request.method} ${url.pathname}`,
    );
  };
  return { fetchImpl, writes, requests };
}
