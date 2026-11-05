import { createHash } from "node:crypto";
import type { Octokit } from "@octokit/rest";
import { extractDiagrams, MAX_SOURCE_BYTES } from "./parser.js";

const MAX_FILES = 20;
const MAX_DIAGRAMS = 10;
const MARKER = "<!-- stately-machine:v1:";

function rightLines(patch: string) {
  const lines = new Set<number>();
  let line = 0;
  for (const text of patch.split("\n")) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (hunk?.[1]) line = Number(hunk[1]);
    else if (text.startsWith("+") || text.startsWith(" ")) lines.add(line++);
  }
  return lines;
}

type PullRequest = {
  octokit: Octokit;
  owner: string;
  repo: string;
  repositoryId: number;
  pullNumber: number;
  headSha: string;
  botLogin: string;
  signal: AbortSignal;
};

export async function updatePullRequestDiagrams({
  octokit,
  owner,
  repo,
  repositoryId,
  pullNumber,
  headSha,
  botLogin,
  signal,
}: PullRequest) {
  const params = { owner, repo, pull_number: pullNumber };
  const current = await octokit.rest.pulls.get(params);
  if (
    current.data.state !== "open" ||
    current.data.head.sha !== headSha ||
    current.data.base.repo.id !== repositoryId
  )
    return;

  const known = new Set<string>();
  let pages = 0;
  for await (const page of octokit.paginate.iterator(
    octokit.rest.pulls.listReviewComments,
    { ...params, per_page: 100 },
  )) {
    for (const comment of page.data) {
      if (
        comment.user?.login === botLogin &&
        comment.user.type === "Bot" &&
        comment.commit_id === headSha &&
        comment.body?.startsWith(MARKER)
      ) {
        const marker = /^<!-- stately-machine:v1:([a-f0-9]{24}) -->/.exec(
          comment.body,
        );
        if (marker?.[1]) known.add(marker[1]);
      }
    }
    // Do not create duplicates if the existing discussion exceeds our lookup budget.
    if (++pages >= 10 && page.data.length === 100) return;
  }
  const comments: {
    path: string;
    line: number;
    side: "RIGHT";
    body: string;
  }[] = [];
  let files = 0;
  let listed = 0;
  outer: for await (const page of octokit.paginate.iterator(
    octokit.rest.pulls.listFiles,
    { ...params, per_page: 100 },
  )) {
    for (const file of page.data) {
      if (++listed > 300) break outer;
      if (
        file.status === "removed" ||
        !/\.(?:[cm]?[jt]sx?)$/i.test(file.filename) ||
        !file.patch
      )
        continue;
      if (++files > MAX_FILES) break outer;
      const content = await octokit.rest.repos.getContent({
        owner,
        repo,
        path: file.filename,
        ref: headSha,
      });
      if (
        Array.isArray(content.data) ||
        content.data.type !== "file" ||
        !("content" in content.data) ||
        content.data.encoding !== "base64" ||
        content.data.size > MAX_SOURCE_BYTES ||
        content.data.content.length > Math.ceil(MAX_SOURCE_BYTES / 3) * 4 + 4096
      )
        continue;
      const bytes = Buffer.from(content.data.content, "base64");
      if (bytes.length > MAX_SOURCE_BYTES) continue;
      let source: string;
      try {
        source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        continue;
      }
      const lines = rightLines(file.patch);
      for (const diagram of await extractDiagrams(source, signal)) {
        if (!lines.has(diagram.line)) continue;
        const key = createHash("sha256")
          .update(`${file.filename}\0${diagram.line}`)
          .digest("hex")
          .slice(0, 24);
        const body = [
          `${MARKER}${key} -->`,
          "```mermaid",
          diagram.mermaid,
          "```",
          "Static XState topology preview of extracted states and state-level transitions. Root-level transitions, dynamic targets, guards, actions, services, history and parallel execution semantics are not modeled. Source code was not executed; no external image service received it.",
        ].join("\n");
        if (known.has(key)) continue;
        known.add(key);
        comments.push({
          path: file.filename,
          line: diagram.line,
          side: "RIGHT",
          body,
        });
        if (comments.length >= MAX_DIAGRAMS) break outer;
      }
    }
  }
  if (!comments.length) return;
  // Recheck after reads/parsing; stale deliveries must not publish on a newer head.
  const latest = await octokit.rest.pulls.get(params);
  if (latest.data.state !== "open" || latest.data.head.sha !== headSha) return;
  // One review for the batch. Never delete comments or rewrite a human discussion.
  await octokit.rest.pulls.createReview({
    ...params,
    commit_id: headSha,
    event: "COMMENT",
    comments,
  });
}
