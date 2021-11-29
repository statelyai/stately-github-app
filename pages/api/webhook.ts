import { createNodeMiddleware, createProbot } from "probot";

import { probotApp } from "../../lib/app";

const probot = createProbot();

export default (req, res) => {
  return createNodeMiddleware(probotApp, {
    probot,
    webhooksPath: "/api/webhook",
  })(req, res);
};
