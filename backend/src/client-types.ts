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

/** What redeeming a handshake nonce returns. */
export interface HandshakeRedemption {
    /** The browser's fresh session token, or null when it is signed out. */
    sessionToken: string | null;
    /** The last sign-in time, in seconds since the epoch. */
    clientUat: number | string;
}

export interface Instance {
    id: string;
    name: string;
    environment: "development" | "production";
    audience: string;
    publishableKey: string | null;
    /** This environment's token issuer: discovery and JWKS live under it. */
    issuerUrl: string | null;
    /** PEM public key of the current signing key, for networkless session token verification (`jwtKey`).
     * It changes when the environment's signing keys rotate. */
    jwtKey: string;
    /** PEM public key of the next signing key while a rotation is under way, otherwise null. Add it to `jwtKey`
     * (both PEM blocks in one value) so networkless verification keeps working when it starts signing. */
    nextJwtKey: string | null;
    signupEnabled: boolean;
}

/** An end user's API key. Users create their own with `<APIKeys />`; your backend lists them, grants scopes and
 * claims, revokes and verifies them. A key created before its owner's last credential change reads as revoked. */
export interface ApiKey {
    id: string;
    object: "api_key";
    type: "api_key";
    name: string;
    description: string | null;
    /** The user who owns the key. */
    subject: string;
    userId: string;
    /** The first characters of the secret, to help users recognise a key. */
    keyPrefix: string;
    scopes: string[];
    claims: Record<string, unknown>;
    revoked: boolean;
    revocationReason: string | null;
    expired: boolean;
    expiresAt: string | null;
    lastUsedAt: string | null;
    createdAt: string;
}

/** Replaces a key's scopes and claims. */
export interface UpdateApiKeyInput {
    scopes: string[];
    /** A JSON object of at most 4096 bytes. */
    claims?: Record<string, unknown> | null;
}

export interface ApiKeyListOptions extends RequestOptions {
    userId?: string;
    includeRevoked?: boolean;
    limit?: number;
    cursor?: string;
}

export interface RequestOptions {
    signal?: AbortSignal;
}

export interface ListOptions extends RequestOptions {
    limit?: number;
    cursor?: string;
    search?: string;
}

export interface Page<T> {
    items: T[];
    nextCursor: string | null;
    hasMore: boolean;
}

export type UserStatus = "active" | "disabled" | "locked";
export type Metadata = Record<string, unknown>;

export interface EmailAddress {
    id: string;
    object: "email_address";
    emailAddress: string;
    verification: { status: "verified" | "unverified"; verifiedAt: string | null };
}

/** The same shape from getUser(), getUserList() and createUser(), like Clerk's User. */
export interface User {
    id: string;
    object: "user";
    instanceId: string;
    firstName: string;
    lastName: string;
    fullName: string | null;
    /** The user's username, where the environment uses them. */
    username: string | null;
    imageUrl: string | null;
    hasImage: boolean;
    primaryEmailAddressId: string | null;
    emailAddresses: EmailAddress[];
    status: UserStatus;
    banned: boolean;
    locked: boolean;
    /** When the user deactivated their account, or null. */
    deactivatedAt: string | null;
    /** When a deactivated account is deleted, or null. */
    deletesAt: string | null;
    publicMetadata: Metadata;
    privateMetadata: Metadata;
    unsafeMetadata: Metadata;
    lastSignInAt: string | null;
    tokensValidAfter: string;
    createdAt: string;
    updatedAt: string;
}

export interface CreateUserInput {
    email: string;
    /** Set true only when your trusted source has already verified ownership. Defaults to false. */
    emailVerified?: boolean;
    /** Required for verified creation. Describe the trusted verification source (10–500 characters). */
    verificationReason?: string | null;
    firstName?: string;
    lastName?: string;
    /** A username, where the environment uses them: 3–64 letters, digits, dots, hyphens and underscores. */
    username?: string | null;
    /** 15–128 characters. */
    password?: string | null;
    imageUrl?: string | null;
    publicMetadata?: Metadata | null;
    privateMetadata?: Metadata | null;
    unsafeMetadata?: Metadata | null;
}

export interface UpdateUserInput {
    /** The `updatedAt` you read; the update fails if the user changed since. */
    expectedUpdatedAt?: string | null;
    firstName: string;
    lastName: string;
    imageUrl?: string | null;
    publicMetadata: Metadata;
    privateMetadata: Metadata;
    unsafeMetadata: Metadata;
}

export interface AddEmailAddressInput {
    email: string;
    status: "verified" | "unverified";
    isPrimary?: boolean;
    /** Required to add a verified address (up to 500 characters). */
    verificationReason?: string | null;
}

export interface ExternalAccount {
    id: string;
    provider: string;
    providerAccountId: string;
    email: string | null;
    createdAt: string;
}

export interface CreateExternalAccountInput {
    /** The provider's name: letters, digits, hyphens and underscores. */
    provider: string;
    providerAccountId: string;
    email?: string | null;
}

/** An organization the user belongs to. */
export interface UserOrganization {
    id: string;
    name: string;
    slug: string;
}

export interface DeletionBlocker {
    resource: string;
    count: number;
    resolution: string;
    /** Where in the console the blocker can be resolved, if anywhere. */
    destination?: { area: string; resourceId?: string | null; tab?: string | null } | null;
}

/** What deleting a user or organization would need first. */
export interface DeletionPlan {
    blockers: DeletionBlocker[];
    canDelete?: boolean;
}

export type SessionStatus = "active" | "expired" | "signed_out" | "revoked";

export interface Session {
    id: string;
    object: "session";
    userId: string;
    status: SessionStatus;
    lastActiveAt: string;
    /** When the session ends if it stays idle. */
    expireAt: string;
    /** When the session ends regardless of activity. */
    abandonAt: string;
    authenticatedAt: string;
    mfaAuthenticatedAt: string | null;
    endedAt: string | null;
    createdAt: string;
}

export interface SessionListOptions extends RequestOptions {
    userId?: string;
    status?: SessionStatus;
    limit?: number;
    cursor?: string;
}

export interface Organization {
    id: string;
    instanceId: string;
    name: string;
    slug: string;
    imageUrl: string | null;
    maxMemberships: number | null;
    publicMetadata: Metadata;
    createdAt: string;
    updatedAt: string;
}

export interface OrganizationDetails {
    organization: Organization;
    privateMetadata: Metadata;
}

export interface CreateOrganizationInput {
    name: string;
    slug: string;
    imageUrl?: string | null;
    maxMemberships?: number | null;
    publicMetadata?: Metadata | null;
    privateMetadata?: Metadata | null;
}

export interface UpdateOrganizationInput extends CreateOrganizationInput {
    /** The `updatedAt` you read; the update fails if the organization changed since. */
    expectedUpdatedAt?: string | null;
}

export interface OrganizationMembership {
    id: string;
    userId: string;
    email: string | null;
    roleId: string;
    roleKey: string;
    createdAt: string;
}

export interface OrganizationInvitation {
    id: string;
    email: string;
    roleId: string | null;
    status: "pending" | "accepted" | "expired" | "revoked";
    expiresAt: string;
    createdAt: string;
}

export interface CreateOrganizationInvitationInput {
    email: string;
    roleId: string;
    /** 1–30 days. */
    lifetimeDays?: number;
}

export interface ResendOrganizationInvitationInput {
    /** The invitation's `expiresAt`; the resend fails if it changed since. */
    expectedExpiresAt: string;
    /** 1–30 days. */
    lifetimeDays?: number;
}

export interface InvitationResult {
    id: string;
    token: string;
    expiresAt: string;
    deliveryStatus: "queued";
    queuedAt: string;
}

export interface Role {
    id: string;
    key: string;
    name: string;
    description: string | null;
    isSystem: boolean;
    permissions: string[];
}

export interface RoleInput {
    key: string;
    name: string;
    description?: string | null;
    permissionIds: string[];
}

export interface Permission {
    id: string;
    key: string;
    name: string;
    description: string | null;
    isSystem: boolean;
}

export interface ExternalProvider {
    id: string;
    name: string;
    displayName: string;
    issuerUrl: string;
    clientId: string;
    secretConfigured: boolean;
    enabled: boolean;
    allowSignup: boolean;
    connectedAccounts: number;
    callbackUrl: string | null;
    updatedAt: string;
}

export interface ExternalProviderInput {
    name: string;
    displayName: string;
    issuerUrl: string;
    clientId: string;
    enabled: boolean;
    allowSignup: boolean;
    clientSecret?: string | null;
}

export interface CreateExternalProviderInput extends ExternalProviderInput {
    clientSecret: string;
}

export interface UpdateExternalProviderInput extends ExternalProviderInput {
    /** The `updatedAt` you read; the update fails if the provider changed since. */
    expectedUpdatedAt?: string | null;
}

export type WebhookEventType =
    | "user.created"
    | "user.updated"
    | "user.deleted"
    | "session.created"
    | "session.ended"
    | "organization.created"
    | "organization.updated"
    | "organization.deleted"
    | "organizationMembership.created"
    | "organizationMembership.updated"
    | "organizationMembership.deleted"
    | "organizationInvitation.created"
    | "organizationInvitation.updated"
    | "organizationInvitation.accepted"
    | "organizationInvitation.revoked"
    | "organizationInvitation.expired";

export interface WebhookEndpointInput {
    name: string;
    url: string;
    /** 1–16 event types. */
    eventTypes: WebhookEventType[];
    enabled: boolean;
}
export interface UpdateWebhookEndpointInput extends WebhookEndpointInput {
    /** The `updatedAt` you read; the update fails if the endpoint changed since. */
    expectedUpdatedAt?: string | null;
}
export interface WebhookEndpoint extends WebhookEndpointInput {
    id: string;
    /** When the endpoint's current run of failed deliveries began, or null while it is healthy. */
    failingSince: string | null;
    /** When Pisti paused the endpoint after failing for the pause period (72 hours). Enabling it again resumes delivery. */
    pausedAt: string | null;
    createdAt: string;
    updatedAt: string;
}
/** An event the environment produced, as delivered to webhook endpoints. */
export interface WebhookEventSummary {
    id: string;
    type: WebhookEventType;
    createdAt: string;
    data: unknown;
}
export interface WebhookEventListOptions extends RequestOptions {
    limit?: number;
    cursor?: string;
    /** Only events of this type. */
    type?: WebhookEventType;
}
export type WebhookDeliveryStatus =
    "pending" | "sending" | "retrying" | "delivered" | "failed" | "cancelled";
export interface WebhookDeliveryListOptions extends RequestOptions {
    limit?: number;
    cursor?: string;
    endpointId?: string;
    status?: WebhookDeliveryStatus;
}
export interface WebhookDelivery {
    id: string;
    eventId: string;
    eventType: string;
    endpointId: string;
    endpointName: string;
    status: WebhookDeliveryStatus;
    attempts: number;
    replayCount: number;
    createdAt: string;
    lastAttemptAt: string | null;
    nextAttemptAt: string;
    deadlineAt: string;
    lastStatusCode: number | null;
    lastErrorCode: string | null;
    deliveredAt: string | null;
}
export interface WebhookDeliveryDetails {
    payload: import("./webhooks.js").PistiWebhookEvent;
    status: WebhookDeliveryStatus;
    attemptCount: number;
    /** The most recent 100 attempts, including interrupted attempts without a result. */
    attempts: WebhookDeliveryAttempt[];
}
export interface WebhookDeliveryAttempt {
    number: number;
    startedAt: string;
    completedAt: string | null;
    statusCode: number | null;
    errorCode: string | null;
    durationMilliseconds: number | null;
}
