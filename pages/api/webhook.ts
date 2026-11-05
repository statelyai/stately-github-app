import { createProbot } from "probot";
import { createWebhookHandler, WEBHOOK_PATH } from "../../lib/webhook";

export const config = { api: { bodyParser: false } };
const probot = createProbot({ overrides: { webhookPath: WEBHOOK_PATH } });
export default createWebhookHandler(probot);
