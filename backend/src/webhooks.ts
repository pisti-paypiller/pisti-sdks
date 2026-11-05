import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Event data. Pisti sends thin events: the changed resource's id and how to find it. Read the
 * current state with the backend API, for example `pistiClient.users.getUser(event.data.id)`.
 */
export interface UserEventData {
    object: "user";
    id: string;
    deleted: boolean;
}
export interface SessionEventData {
    object: "session";
    id: string;
    user_id: string;
}
export interface OrganizationEventData {
    object: "organization";
    id: string;
    deleted: boolean;
}
export interface OrganizationMembershipEventData {
    object: "organization_membership";
    id: string;
    organization_id: string;
    user_id: string;
}
export interface OrganizationInvitationEventData {
    object: "organization_invitation";
    id: string;
    organization_id: string;
    status: string;
}

interface WebhookEventDataMap {
    "user.created": UserEventData;
    "user.updated": UserEventData;
    "user.deleted": UserEventData;
    "session.created": SessionEventData;
    "session.ended": SessionEventData;
    "organization.created": OrganizationEventData;
    "organization.updated": OrganizationEventData;
    "organization.deleted": OrganizationEventData;
    "organizationMembership.created": OrganizationMembershipEventData;
    "organizationMembership.updated": OrganizationMembershipEventData;
    "organizationMembership.deleted": OrganizationMembershipEventData;
    "organizationInvitation.created": OrganizationInvitationEventData;
    "organizationInvitation.updated": OrganizationInvitationEventData;
    "organizationInvitation.accepted": OrganizationInvitationEventData;
    "organizationInvitation.revoked": OrganizationInvitationEventData;
    "organizationInvitation.expired": OrganizationInvitationEventData;
}

/**
 * A verified webhook event, like Clerk's `WebhookEvent`. Checking `event.type` narrows `event.data`:
 *
 * ```ts
 * if (event.type === "organizationMembership.created") console.log(event.data.organization_id);
 * ```
 */
export type PistiWebhookEvent = {
    [K in keyof WebhookEventDataMap]: {
        id: string;
        object: "event";
        type: K;
        timestamp: number;
        instance_id: string;
        data: WebhookEventDataMap[K];
    };
}[keyof WebhookEventDataMap];

export interface VerifyWebhookOptions {
    /** Defaults to the `PISTI_WEBHOOK_SIGNING_SECRET` environment variable. Pass several while rotating. */
    signingSecret?: string | readonly string[] | undefined;
    /** Optionally require events from this environment (see `client.getInstance()`). */
    expectedInstanceId?: string | undefined;
    /** Clock tolerance for the signed delivery timestamp. Defaults to five minutes. */
    toleranceSeconds?: number;
}

type WebhookHeaders =
    Headers | Readonly<Record<string, string | readonly string[] | undefined>>;

export class PistiWebhookError extends Error {
    constructor(
        readonly code:
            | "invalid_headers"
            | "invalid_timestamp"
            | "invalid_signature"
            | "invalid_payload",
    ) {
        super("The webhook could not be verified.");
        this.name = "PistiWebhookError";
    }
}

function header(
    headers: WebhookHeaders,
    name: string,
    multiple = false,
): string {
    const input =
        typeof (headers as Headers).get === "function"
            ? (headers as Headers).get(name)
            : Object.entries(headers).find(
                  ([key]) => key.toLowerCase() === name,
              )?.[1];
    if (typeof input === "string" && input.length <= 4096) return input;
    if (
        multiple &&
        Array.isArray(input) &&
        input.length <= 16 &&
        input.every((value) => typeof value === "string" && value.length <= 256)
    )
        return input.join(" ");
    throw new PistiWebhookError("invalid_headers");
}

/** Verify the exact raw body before parsing JSON. Store event IDs to prevent duplicate processing. */
interface NodeWebhookRequest {
    body: unknown;
    headers: WebhookHeaders;
}

/**
 * Verifies a webhook delivery and returns the event, like Clerk's `verifyWebhook`. Pass a Fetch API
 * `Request` (Next.js, Hono, Bun, Workers) or a Node request whose body is the raw bytes. The
 * signing secret defaults to `PISTI_WEBHOOK_SIGNING_SECRET`.
 */
export async function verifyWebhook(
    request: Request | NodeWebhookRequest,
    options: VerifyWebhookOptions = {},
): Promise<PistiWebhookEvent> {
    if (typeof Request !== "undefined" && request instanceof Request)
        return verifyWebhookPayload(new Uint8Array(await request.arrayBuffer()), request.headers, options);
    const { body, headers } = request as NodeWebhookRequest;
    if (typeof body !== "string" && !(body instanceof Uint8Array))
        throw new Error(
            "The webhook body was already parsed. Read the raw body on this route, for example express.raw({ type: \"application/json\" }) before express.json().",
        );
    return verifyWebhookPayload(body, headers, options);
}

/** Verifies a raw payload and its headers, for frameworks without a Fetch `Request`. */
export function verifyWebhookPayload(
    payload: string | Uint8Array,
    headers: WebhookHeaders,
    options: VerifyWebhookOptions = {},
): PistiWebhookEvent {
    return verifyPayload(payload, headers, options);
}

function verifyPayload(
    payload: string | Uint8Array,
    headers: WebhookHeaders,
    options: VerifyWebhookOptions,
): PistiWebhookEvent {
    const length =
        typeof payload === "string"
            ? Buffer.byteLength(payload, "utf8")
            : payload.byteLength;
    if (length === 0 || length > 262144)
        throw new PistiWebhookError("invalid_payload");
    const body =
        typeof payload === "string"
            ? Buffer.from(payload, "utf8")
            : Buffer.from(payload);
    if (options.expectedInstanceId !== undefined && !/^[1-9]\d{0,9}$/.test(options.expectedInstanceId))
        throw new Error("expectedInstanceId must be the environment's numeric ID.");
    const tolerance = options.toleranceSeconds ?? 300;
    if (!Number.isInteger(tolerance) || tolerance < 1 || tolerance > 600)
        throw new Error(
            "Use a webhook clock tolerance between 1 and 600 seconds.",
        );
    const configured = options.signingSecret ?? process.env.PISTI_WEBHOOK_SIGNING_SECRET;
    if (!configured)
        throw new Error(
            "Missing webhook signing secret. Copy it from the endpoint under Webhooks in the Pisti console into PISTI_WEBHOOK_SIGNING_SECRET.",
        );
    const secrets = typeof configured === "string" ? [configured] : configured;
    if (secrets.length === 0 || secrets.length > 5)
        throw new Error(
            "Provide between one and five webhook signing secrets.",
        );
    const keys = secrets.map((secret) => {
        if (!/^whsec_[A-Za-z0-9+/]{43}=$/.test(secret))
            throw new Error("Provide a Pisti webhook signing secret.");
        return Buffer.from(secret.slice(6), "base64");
    });
    const id = header(headers, "webhook-id"),
        timestamp = header(headers, "webhook-timestamp");
    if (!/^evt_[a-f0-9]{32}$/.test(id) || !/^\d{1,12}$/.test(timestamp))
        throw new PistiWebhookError("invalid_headers");
    const seconds = Number(timestamp);
    if (Math.abs(Math.floor(Date.now() / 1000) - seconds) > tolerance)
        throw new PistiWebhookError("invalid_timestamp");
    const supplied = header(headers, "webhook-signature", true)
        .split(/\s+/)
        .filter(Boolean);
    if (supplied.length === 0 || supplied.length > 16)
        throw new PistiWebhookError("invalid_signature");
    let verified = false;
    for (const key of keys) {
        const expected = createHmac("sha256", key)
            .update(id + "." + timestamp + ".")
            .update(body)
            .digest();
        for (const signature of supplied) {
            if (!/^v1,[A-Za-z0-9+/]{43}=$/.test(signature)) continue;
            const value = Buffer.from(signature.slice(3), "base64");
            if (
                value.length === expected.length &&
                timingSafeEqual(value, expected)
            )
                verified = true;
        }
    }
    if (!verified) throw new PistiWebhookError("invalid_signature");
    let data: unknown;
    try {
        data = JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(body),
        );
    } catch {
        throw new PistiWebhookError("invalid_payload");
    }
    if (!data || typeof data !== "object" || Array.isArray(data))
        throw new PistiWebhookError("invalid_payload");
    const event = data as PistiWebhookEvent;
    if (
        event.id !== id ||
        event.object !== "event" ||
        (options.expectedInstanceId !== undefined && event.instance_id !== options.expectedInstanceId) ||
        typeof event.type !== "string" ||
        event.type.length === 0 ||
        event.type.length > 100 ||
        !Number.isSafeInteger(event.timestamp) ||
        event.timestamp < 0 ||
        !event.data ||
        typeof event.data !== "object" ||
        Array.isArray(event.data)
    )
        throw new PistiWebhookError("invalid_payload");
    return event;
}
