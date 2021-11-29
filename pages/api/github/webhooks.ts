import { createNodeMiddleware, createProbot } from "probot";

import { probotApp } from "../../../lib/app";

const probot = createProbot();

export default createNodeMiddleware(probotApp, {
  probot,
  webhooksPath: "/api/github/webhooks",
});
