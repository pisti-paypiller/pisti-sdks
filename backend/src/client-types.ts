// The Backend API's public types. Resource and input shapes are named aliases of the types
// generated from contract/backend.json (`npm run contract:pull`), so a contract change shows here in
// review. Only the SDK's own options and the error details the contract does not describe are written
// by hand.
import type { components, paths } from "./generated/backend.js";
import type { PistiWebhookEvent } from "./webhooks.js";

type Schemas = components["schemas"];
type Query<P extends keyof paths> = NonNullable<NonNullable<paths[P]["get"]>["parameters"]["query"]>;

export interface PistiClientOptions {
    /** Defaults to `PISTI_SECRET_KEY`. Needed only for the backend API. Never expose it in browser code. */
    secretKey?: string | undefined;
    /** Defaults to `PISTI_PUBLISHABLE_KEY`; it names the environment's host. */
    publishableKey?: string | undefined;
    /** The Pisti backend API. Defaults to `PISTI_API_URL`, else `https://pisti-api.paypiller.com`. */
    apiUrl?: string | undefined;
    /** Origins allowed to have requested session tokens. Defaults to `PISTI_AUTHORIZED_PARTIES`. */
    authorizedParties?: string[] | undefined;
    timeoutMs?: number | undefined;
}

/** What redeeming a handshake nonce returns: the browser's fresh session token (null when signed out)
 * and its last sign-in time in seconds since the epoch. */
export type HandshakeRedemption = Schemas["HandshakeRedemption"];

/** The environment the secret key belongs to. `jwtKey` is the PEM public key of the current signing key
 * for networkless verification; `nextJwtKey` is the next one while a rotation is under way. */
export type Instance = Schemas["InstanceResponse"];

/** An end user's API key. Users create their own with `<APIKeys />`; your backend lists them, grants scopes and
 * claims, revokes and verifies them. A key created before its owner's last credential change reads as revoked. */
export type ApiKey = Schemas["ApiKeyResponse"];

/** Replaces a key's scopes and claims (a JSON object of at most 4096 bytes). */
export type UpdateApiKeyInput = Schemas["UpdateUserApiKeyInput"];

export interface ApiKeyListOptions extends PageOptions {
    userId?: string;
    includeRevoked?: boolean;
}

export interface RequestOptions {
    signal?: AbortSignal;
}

/** One page of a list: `limit` (1–100, default 50) and the `nextCursor` of the page before. */
export interface PageOptions extends RequestOptions {
    limit?: number;
    /** The opaque `nextCursor` of the previous page. Use it only with the same filters and order. */
    cursor?: string;
}

/** A cursor page. Fixed lists (email addresses, permissions, …) come whole, with `hasMore` false. */
export interface Page<T> {
    items: T[];
    nextCursor: string | null;
    hasMore: boolean;
}

/** A list searchable by name or email (at most 200 characters). */
export interface SearchListOptions extends PageOptions {
    search?: string;
}

export type UserStatus = Schemas["UserResponse"]["status"];
/** Sort orders for users; a leading `-` sorts descending. Defaults to `-createdAt`. */
export type UserOrderBy = NonNullable<Query<"/v1/users">["orderBy"]>;
export interface UserListOptions extends SearchListOptions {
    status?: UserStatus;
    orderBy?: UserOrderBy;
}
export type UserCountOptions = Omit<UserListOptions, "limit" | "cursor" | "orderBy">;

/** Sort orders for organizations. Defaults to `-createdAt`. */
export type OrganizationOrderBy = NonNullable<Query<"/v1/organizations">["orderBy"]>;
export interface OrganizationListOptions extends SearchListOptions {
    orderBy?: OrganizationOrderBy;
}
export type OrganizationCountOptions = Omit<OrganizationListOptions, "limit" | "cursor" | "orderBy">;
export type Metadata = Schemas["JsonObject"];

export type EmailAddress = Schemas["EmailAddressResponse"];

/** The same shape from getUser(), getUserList() and createUser(), like Clerk's User. */
export type User = Schemas["UserResponse"];

/** Set `emailVerified` only when your trusted source has already verified ownership, with a
 * `verificationReason` (10–500 characters). Passwords are 15–128 characters. */
export type CreateUserInput = Schemas["CreateDirectoryUserInput"];

/** `expectedUpdatedAt` is the `updatedAt` you read; the update fails if the user changed since. */
export type UpdateUserInput = Schemas["UpdateDirectoryUserInput"];

/** `verificationReason` is required to add a verified address (up to 500 characters). */
export type AddEmailAddressInput = Schemas["AddDirectoryEmailInput"];

export type ExternalAccount = Schemas["ExternalAccountResponse"];

/** `provider` is the provider's name: letters, digits, hyphens and underscores. */
export type CreateExternalAccountInput = Schemas["AddExternalAccountInput"];

/** An organization the user belongs to. */
export type UserOrganization = Schemas["UserOrganizationResponse"];

/** Something that stops a user or organization from being deleted, from a 409 response. */
export type DeletionBlocker = Schemas["DeletionBlockedProblem"]["blockers"][number];

/** An RFC 9457 Problem Details error body, as `PistiAPIResponseError` reads it. */
export type ApiProblem = Schemas["ApiProblem"];

/** The 409 a delete returns while something stops it. */
export type DeletionBlockedProblem = Schemas["DeletionBlockedProblem"];

export type SessionStatus = Schemas["SessionResponse"]["status"];

export type Session = Schemas["SessionResponse"];

export interface SessionListOptions extends PageOptions {
    userId?: string;
    status?: SessionStatus;
}

export type Organization = Schemas["OrganizationResponse"];

export type OrganizationDetails = Schemas["OrganizationDetailsResponse"];

export type CreateOrganizationInput = Omit<Schemas["OrganizationInput"], "expectedUpdatedAt">;

/** `expectedUpdatedAt` is the `updatedAt` you read; the update fails if the organization changed since. */
export type UpdateOrganizationInput = Schemas["OrganizationInput"];

export type OrganizationMembership = Schemas["OrganizationMemberResponse"];

export type OrganizationInvitation = Schemas["OrganizationInvitationResponse"];

/** `lifetimeDays` is 1–30. */
export type CreateOrganizationInvitationInput = Schemas["OrganizationInvitationInput"];

/** `expectedExpiresAt` is the invitation's `expiresAt`; the resend fails if it changed since. */
export type ResendOrganizationInvitationInput = Schemas["ResendInvitationInput"];

export type InvitationResult = Schemas["SentInvitationResponse"];

export type Role = Schemas["RoleSummary"];

export type RoleInput = Schemas["OrganizationRoleInput"];

export type Permission = Schemas["PermissionResponse"];

export type ExternalProvider = Schemas["ExternalProviderSummary"];

export type ExternalProviderInput = Omit<Schemas["ExternalProviderInput"], "expectedUpdatedAt">;

export type CreateExternalProviderInput = Omit<ExternalProviderInput, "clientSecret"> & { clientSecret: string };

/** `expectedUpdatedAt` is the `updatedAt` you read; the update fails if the provider changed since. */
export type UpdateExternalProviderInput = Schemas["ExternalProviderInput"];

/** Every event type a webhook endpoint can subscribe to. */
export type WebhookEventType = Schemas["WebhookEventType"]["type"];
/** One entry of the webhook event catalog. */
export type WebhookCatalogEntry = Schemas["WebhookEventType"];

/** `eventTypes` holds 1–16 event types. */
export type WebhookEndpointInput = Omit<Schemas["WebhookEndpointInput"], "expectedUpdatedAt">;
/** `expectedUpdatedAt` is the `updatedAt` you read; the update fails if the endpoint changed since. */
export type UpdateWebhookEndpointInput = Schemas["WebhookEndpointInput"];
/** `failingSince` is when the current run of failed deliveries began; `pausedAt` is when Pisti paused the
 * endpoint after failing for the pause period (72 hours). Enabling it again resumes delivery. */
export type WebhookEndpoint = Schemas["WebhookEndpointSummary"];
/** An event the environment produced, as delivered to webhook endpoints. */
export type WebhookEventSummary = Schemas["WebhookEventSummary"];
export interface WebhookEventListOptions extends PageOptions {
    /** Only events of this type. */
    type?: WebhookEventType;
}
export type WebhookDeliveryStatus = Schemas["WebhookDeliverySummary"]["status"];
export interface WebhookDeliveryListOptions extends PageOptions {
    endpointId?: string;
    status?: WebhookDeliveryStatus;
}
export type WebhookDelivery = Schemas["WebhookDeliverySummary"];
/** A delivery with its payload and the most recent 100 attempts, including interrupted attempts without a result. */
export type WebhookDeliveryDetails = Omit<Schemas["WebhookDeliveryDetailsResponse"], "payload"> & {
    payload: PistiWebhookEvent;
};
export type WebhookDeliveryAttempt = Schemas["WebhookAttemptResponse"];
