import type { Octokit } from "@octokit/rest";
import { z } from "zod";
import { analyzeBehavior, contextSchema, verifiedEntries } from "./behavior-review-model.js";
import type { ReviewEntry, ReviewFile, ReviewRule } from "./behavior-review-model.js";

export const VIZ_REVIEW_LABEL = "stately:behavior-review";
export const VIZ_REPOSITORY = "statelyai/viz";
const MARKER = "<!-- stately-behavior-review:v1:";
const CONTEXT_PATH = ".github/stately-behavior-review.json";
const MAX_PATCH_BYTES = 36_000;
const MAX_CONTEXT_BYTES = 12_000;
const MAX_FILES = 12;

const configFileSchema = z.object({
  type: z.literal("file"),
  encoding: z.literal("base64"),
  size: z.number().max(MAX_CONTEXT_BYTES),
  content: z.string().max(Math.ceil(MAX_CONTEXT_BYTES / 3) * 4 + 1500),
});

type ReviewRequest = {
  octokit: Octokit;
  repositoryId: number;
  pullNumber: number;
  headSha: string;
  botLogin: string;
  username: string;
  signal: AbortSignal;
  analyze: typeof analyzeBehavior;
  model: string;
  getModelKey: () => string | Promise<string>;
};

const markupEscapes: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  "@": "&#64;",
  ":": "&#58;",
};

function markdown(value: string) {
  return value.replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/[&<>@:]/g, (character) => markupEscapes[character] ?? "")
    .replace(/[\\`*_[\]()#!~]/g, "\\$&");
}

function renderFlow(steps: string[]) {
  const nodes = steps.map((step, index) => {
    const label = [...step].map((character) =>
      /[a-zA-Z0-9 _.-]/.test(character) ? character : "#" + character.codePointAt(0) + ";",
    ).join("");
    return "  n" + index + '["' + label + '"]';
  });
  const edges = steps.slice(1).map((_, index) => "  n" + index + " --> n" + (index + 1));
  return ["```mermaid", "flowchart TD", ...nodes, ...edges, "```"].join("\n");
}

export function renderBehaviorComment(
  pullNumber: number,
  base: string,
  head: string,
  entries: ReviewEntry[],
) {
  const anchor = (index: number) =>
    "stately-viz-" + pullNumber + "-" + base.slice(0, 8) + "-" + head.slice(0, 12) + "-flow-" + (index + 1);
  const current = head.slice(0, 8);
  const summary = entries.map((entry, index) =>
    "- [" + markdown(entry.summary) + "](#user-content-" + anchor(index) + ")",
  );
  const details = entries.map((entry, index) => {
    const source = "https://github.com/" + VIZ_REPOSITORY + "/blob/" + head + "/" +
      entry.evidence.path.split("/").map((segment) =>
        encodeURIComponent(segment).replace(/[()]/g, (character) => character === "(" ? "%28" : "%29"),
      ).join("/") + "#L" + entry.evidence.line;
    return [
      "<details>",
      "<summary>Flow " + (index + 1) + "</summary>",
      "",
      '<a name="' + anchor(index) + '"></a>',
      "",
      ...(entry.before.length ? ["**Before**", "", renderFlow(entry.before), ""] : []),
      "**After**",
      "",
      renderFlow(entry.after),
      "",
      "[View source](" + source + ")",
      "",
      "</details>",
    ].join("\n");
  });
  return [
    MARKER + base + ":" + head + " -->",
    "### What changed for users",
    ...(summary.length ? summary : ["No supported user-visible change found at `" + current + "`."]),
    ...details,
  ].join("\n\n");
}

function isMissing(error: unknown) {
  return typeof error === "object" && error !== null && "status" in error && error.status === 404;
}

export async function reviewVizPullRequest(request: ReviewRequest) {
  const { octokit, pullNumber, headSha, repositoryId, botLogin, signal } = request;
  const repo = { owner: "statelyai", repo: "viz" };
  const pull = { ...repo, pull_number: pullNumber };
  const issue = { ...repo, issue_number: pullNumber };
  const permission = await octokit.rest.repos.getCollaboratorPermissionLevel({
    ...repo, username: request.username,
  }).then(({ data }) => data.permission, (error: unknown) => {
    if (isMissing(error)) return "none";
    throw error;
  });
  if (!["write", "maintain", "admin"].includes(permission)) return;

  const { data: current } = await octokit.rest.pulls.get(pull);
  if (current.state !== "open" || current.base.repo.id !== repositoryId ||
      current.head.sha !== headSha || !current.labels.some(({ name }) => name === VIZ_REVIEW_LABEL))
    return;

  const baseSha = current.base.sha;
  const findComment = async () => {
    let pages = 0;
    for await (const page of octokit.paginate.iterator(octokit.rest.issues.listComments, {
      ...issue, per_page: 100,
    })) {
      const existing = page.data.find((comment) =>
        comment.user?.type === "Bot" && comment.user.login === botLogin &&
        comment.body?.startsWith(MARKER),
      );
      if (existing) return existing;
      if (++pages >= 10 && page.data.length === 100)
        throw new Error("Could not check existing behavior review comments");
    }
    return undefined;
  };

  const existing = await findComment();
  if (existing?.body?.startsWith(MARKER + baseSha + ":" + headSha + " -->")) return;

  const { data: comparison } = await octokit.rest.repos.compareCommitsWithBasehead({
    ...repo, basehead: baseSha + "..." + headSha, per_page: 1,
  });
  if (!comparison.files) throw new Error("GitHub comparison did not include files");

  let remaining = MAX_PATCH_BYTES;
  const files: ReviewFile[] = [];
  for (const file of comparison.files) {
    if (!/^packages\/editor\/src\/.*\.[cm]?[jt]sx?$/.test(file.filename) || !file.patch)
      continue;
    const size = Buffer.byteLength(file.patch);
    if (size > remaining) continue;
    files.push({ path: file.filename, patch: file.patch });
    remaining -= size;
    if (files.length === MAX_FILES) break;
  }

  const rules = await readRules(octokit, repo, baseSha, files);
  const entries = files.length ? verifiedEntries(
    (await request.analyze({ files, rules }, {
      model: request.model, apiKey: await request.getModelKey(), signal,
    })).filter(({ kind }) => kind === "change"),
    files,
  ) : [];

  if (!entries.length && !existing) return;
  const latest = await octokit.rest.pulls.get(pull);
  if (latest.data.state !== "open" || latest.data.head.sha !== headSha ||
      latest.data.base.sha !== baseSha || !latest.data.labels.some(({ name }) => name === VIZ_REVIEW_LABEL))
    return;

  const comment = await findComment();
  if (comment?.body?.startsWith(MARKER + baseSha + ":" + headSha + " -->")) return;
  const body = renderBehaviorComment(pullNumber, baseSha, headSha, entries);
  if (comment) {
    await octokit.rest.issues.updateComment({ ...repo, comment_id: comment.id, body });
  } else if (entries.length) {
    await octokit.rest.issues.createComment({ ...issue, body });
  }
}

async function readRules(
  octokit: Octokit,
  repo: { owner: string; repo: string },
  base: string,
  files: ReviewFile[],
): Promise<ReviewRule[]> {
  if (!files.length) return [];
  try {
    const result = await octokit.rest.repos.getContent({ ...repo, ref: base, path: CONTEXT_PATH });
    const file = configFileSchema.parse(result.data);
    const bytes = Buffer.from(file.content, "base64");
    if (bytes.length > MAX_CONTEXT_BYTES) throw new Error("Behavior context exceeds its byte limit");
    const document = contextSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
    const touched = new Set(files.map(({ path }) => path));
    return document.rules.filter((rule) => rule.paths.some((path) => touched.has(path)));
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
}
