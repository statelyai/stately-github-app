import { createNodeMiddleware, createProbot } from "probot";

import { probotApp } from "../../lib/app";

const probot = createProbot();

export default (req, res) => {
  throw new Error("SOMETHING IS HAPPENING");

  return createNodeMiddleware(probotApp, {
    probot,
    webhooksPath: "/api/webhook",
  })(req, res);
};
