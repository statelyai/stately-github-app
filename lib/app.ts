import { Probot } from "probot";
import lzString from "lz-string";
import { createMachine } from "xstate";
import { parseMachinesFromFile } from "xstate-parser-demo";

export const probotApp = (app: Probot) => {
  app.on("pull_request.synchronize", async (context) => {
    const headSha = context.payload.pull_request.head.sha;
    const baseSha = context.payload.pull_request.base.sha;

    // Delete all PR review comments made by this bot
    const allReviewComments = await context.octokit.pulls.listReviewComments(
      context.pullRequest(),
    );

    for (const comment of allReviewComments.data) {
      // TODO - improve
      if (
        // If the bot made this comment
        comment.user.login === "stately-github[bot]" &&
        // and no-one has replied to it
        !allReviewComments.data.some(
          (otherComment) => otherComment.in_reply_to_id === comment.id,
        )
      ) {
        await context.octokit.pulls.deleteReviewComment(
          context.pullRequest({
            comment_id: comment.id,
          }),
        );
      }
    }

    const comparison = await context.octokit.repos.compareCommits(
      context.repo({
        base: baseSha,
        head: headSha,
      }),
    );

    const changedFiles = comparison.data.files || [];

    for (const file of changedFiles) {
      try {
        const fileDetails = await context.octokit.repos.getContent(
          context.repo({
            path: file.filename,
            ref: headSha,
          }),
        );

        let fileContents = Buffer.from(
          (fileDetails.data as any).content,
          "base64",
        ).toString();

        const result = parseMachinesFromFile(fileContents);

        for (const machineResult of result.machines) {
          try {
            const config = machineResult.toConfig();

            const startLine =
              machineResult.ast.definition?.node.loc?.start.line;

            if (config && typeof startLine === "number") {
              // Tests that it's valid
              createMachine(config);

              const str = lzString.compressToEncodedURIComponent(
                JSON.stringify(config),
              );

              await context.octokit.pulls.createReviewComment(
                context.pullRequest({
                  body: [
                    `![Visualisation](https://registry-d7xoh47z1-statelyai.vercel.app/registry/machine-by-definition/${str}.png)`,
                    `[View on Stately Viz](https://xstate-viz-git-matt-added-an-embed-mode-which-b61eb7-statelyai.vercel.app/viz/view-only?machine=${str}&controls=1&pan=1&zoom=1)`,
                  ].join("\n\n"),
                  line: startLine,
                  path: file.filename,
                  commit_id: headSha,
                }),
              );
              console.log("CREATED COMMENT");
            }
          } catch (e) {
            throw e;
          }
        }
      } catch (e) {
        throw e;
      }
    }
  });
  // For more information on building apps:
  // https://probot.github.io/docs/

  // To get your app running against GitHub, see:
  // https://probot.github.io/docs/development/
};
