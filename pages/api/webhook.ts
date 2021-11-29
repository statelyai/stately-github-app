import { NextApiHandler } from "next";
import { createNodeMiddleware, createProbot } from "probot";

import { probotApp } from "../../lib/app";

const probot = createProbot();

const handler: NextApiHandler = (req, res) => {
  return createNodeMiddleware(probotApp, {
    probot,
    webhooksPath: "/api/webhook",
  })(req, res);
};

export default handler;
