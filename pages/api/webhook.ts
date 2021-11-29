import { NextApiHandler } from "next";
import { createNodeMiddleware, createProbot } from "probot";

import { probotApp } from "../../lib/app";

const probot = createProbot();

const handler: NextApiHandler = (req, res) => {
  req.url = "http://localhost:3000/api/webhook";
  return createNodeMiddleware(probotApp, {
    probot,
    // Force it to prevent a 404
    webhooksPath: "/api/webhook",
  })(req, res);
};

export default handler;
