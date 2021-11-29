import { NextApiHandler } from "next";
import { createNodeMiddleware, createProbot } from "probot";

import { probotApp } from "../../lib/app";

const probot = createProbot();

const handler: NextApiHandler = (req, res) => {
  console.log(req.url);
  return createNodeMiddleware(probotApp, {
    probot,
    // Force it to prevent a 404
    webhooksPath: new URL(req.url).pathname,
  })(req, res);
};

export default handler;
