import { NextApiHandler } from "next";
import { createNodeMiddleware, createProbot } from "probot";

import { probotApp } from "../../lib/app";

export const config = { api: { bodyParser: false } };

const probot = createProbot();

const middleware = createNodeMiddleware(probotApp, { probot, webhooksPath: "/api/webhook" });
const handler: NextApiHandler = (req, res) => middleware(req, res);

export default handler;
