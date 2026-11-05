import type { Request } from "express";
import { verifyWebhook as verify, type PistiWebhookEvent, type VerifyWebhookOptions } from "@pisti-paypiller/backend";

/**
 * Verifies a webhook delivery, like Clerk's `@clerk/express/webhooks`. Mount the route with
 * `express.raw({ type: "application/json" })` before `express.json()`. The signing secret
 * defaults to `PISTI_WEBHOOK_SIGNING_SECRET`.
 *
 * ```ts
 * app.post("/api/webhooks", express.raw({ type: "application/json" }), async (req, res) => {
 *   const event = await verifyWebhook(req);
 *   res.sendStatus(204);
 * });
 * ```
 */
export function verifyWebhook(
    req: Request,
    options?: VerifyWebhookOptions,
): Promise<PistiWebhookEvent> {
    return verify({ body: req.body, headers: req.headers }, options);
}

export type { PistiWebhookEvent, VerifyWebhookOptions } from "@pisti-paypiller/backend";
