import { createHmac, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { PistiWebhookError, verifyWebhookPayload } from "../src/webhooks.js";

const secretBytes = randomBytes(32);
const secret = `whsec_${secretBytes.toString("base64")}`;
const eventId = `evt_${"a".repeat(32)}`;

function delivery(overrides: { body?: object; timestamp?: number; key?: Buffer } = {}) {
    const timestamp = String(overrides.timestamp ?? Math.floor(Date.now() / 1000));
    const body = JSON.stringify(
        overrides.body ?? {
            id: eventId,
            object: "event",
            type: "user.created",
            timestamp: Date.now(),
            instance_id: "1",
            data: { object: "user", id: "user_1", deleted: false },
        },
    );
    const signature = createHmac("sha256", overrides.key ?? secretBytes).update(`${eventId}.${timestamp}.`).update(body).digest("base64");
    return {
        body,
        headers: { "webhook-id": eventId, "webhook-timestamp": timestamp, "webhook-signature": `v1,${signature}` },
    };
}

function failure(run: () => unknown): string {
    try {
        run();
    } catch (error) {
        expect(error).toBeInstanceOf(PistiWebhookError);
        return (error as PistiWebhookError).code;
    }
    throw new Error("Expected the webhook to be rejected.");
}

describe("verifyWebhookPayload", () => {
    it("returns the event of a correctly signed delivery", () => {
        const { body, headers } = delivery();
        const event = verifyWebhookPayload(body, headers, { signingSecret: secret });

        expect(event.type).toBe("user.created");
        expect(event.data.id).toBe("user_1");
    });

    it("accepts any of several secrets while one is rotated", () => {
        const { body, headers } = delivery();
        const previous = `whsec_${randomBytes(32).toString("base64")}`;

        expect(verifyWebhookPayload(body, headers, { signingSecret: [previous, secret] }).id).toBe(eventId);
    });

    it("rejects a delivery signed with another secret", () => {
        const { body, headers } = delivery({ key: randomBytes(32) });
        expect(failure(() => verifyWebhookPayload(body, headers, { signingSecret: secret }))).toBe("invalid_signature");
    });

    it("rejects a body changed after signing", () => {
        const { body, headers } = delivery();
        const tampered = body.replace("user_1", "user_2");
        expect(failure(() => verifyWebhookPayload(tampered, headers, { signingSecret: secret }))).toBe("invalid_signature");
    });

    it("rejects a replayed delivery outside the clock tolerance", () => {
        const { body, headers } = delivery({ timestamp: Math.floor(Date.now() / 1000) - 3600 });
        expect(failure(() => verifyWebhookPayload(body, headers, { signingSecret: secret }))).toBe("invalid_timestamp");
    });

    it("rejects a payload whose id differs from the signed header", () => {
        const { body, headers } = delivery({
            body: { id: `evt_${"b".repeat(32)}`, object: "event", type: "user.created", timestamp: 1, instance_id: "1", data: {} },
        });
        expect(failure(() => verifyWebhookPayload(body, headers, { signingSecret: secret }))).toBe("invalid_payload");
    });

    it("rejects events from another environment when one is expected", () => {
        const { body, headers } = delivery();
        expect(failure(() => verifyWebhookPayload(body, headers, { signingSecret: secret, expectedInstanceId: "2" }))).toBe(
            "invalid_payload",
        );
    });

    it("rejects missing headers", () => {
        const { body } = delivery();
        expect(failure(() => verifyWebhookPayload(body, {}, { signingSecret: secret }))).toBe("invalid_headers");
    });

    it("refuses a malformed signing secret as a configuration error", () => {
        const { body, headers } = delivery();
        expect(() => verifyWebhookPayload(body, headers, { signingSecret: "not-a-secret" })).toThrow(/signing secret/);
    });
});
