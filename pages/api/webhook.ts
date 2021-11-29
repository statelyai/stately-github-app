import { createNodeMiddleware, createProbot } from "probot";

import { probotApp } from "../../lib/app";

const probot = createProbot();

export default (req, res) => {
  return createNodeMiddleware(probotApp, {
    probot,
    webhooksPath: "https://stately-github-app.vercel.app/api/webhook",
  })(req, res);
};
