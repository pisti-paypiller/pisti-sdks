export interface ManagementClientOptions {
    /** Defaults to `PISTI_SECRET_KEY`. Needed only for the management API. Never expose it in browser code. */
    secretKey?: string | undefined;
    /** Defaults to `PISTI_PUBLISHABLE_KEY`; it tells the client where Pisti is. */
    publishableKey?: string | undefined;
    /** Origins allowed to have requested session tokens. Defaults to `PISTI_AUTHORIZED_PARTIES`. */
    authorizedParties?: string[] | undefined;
    timeoutMs?: number | undefined;
}

export interface ManagedInstance {
    id: string;
    name: string;
    environment: "development" | "staging" | "production";
    audience: string;
    publishableKey: string;
    /** This environment's token issuer: discovery and JWKS live under it. */
    issuerUrl: string;
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
    claims: Record<string, unknown> | null;
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

export interface ApiKeyListOptions extends ManagementRequestOptions {
    userId?: string;
    includeRevoked?: boolean;
    limit?: number;
    cursor?: string;
}

export interface ManagementRequestOptions {
    signal?: AbortSignal;
}

export interface ManagementListOptions extends ManagementRequestOptions {
    limit?: number;
    cursor?: string;
    search?: string;
}

export interface ManagementPage<T> {
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
    imageUrl: string | null;
    hasImage: boolean;
    primaryEmailAddressId: string | null;
    emailAddresses: EmailAddress[];
    status: UserStatus;
    banned: boolean;
    locked: boolean;
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
    verificationReason?: string;
    firstName?: string;
    lastName?: string;
    password?: string;
    imageUrl?: string | null;
    publicMetadata?: Metadata;
    privateMetadata?: Metadata;
    unsafeMetadata?: Metadata;
}

export interface UpdateUserInput {
    expectedUpdatedAt: string;
    firstName: string;
    lastName: string;
    imageUrl?: string | null;
    publicMetadata: Metadata;
    privateMetadata: Metadata;
    unsafeMetadata: Metadata;
}

export interface DirectoryExternalAccount {
    id: string;
    provider: string;
    providerAccountId: string;
    email: string | null;
    createdAt: string;
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

export interface SessionListOptions extends ManagementRequestOptions {
    userId?: string;
    status?: SessionStatus;
    limit?: number;
    cursor?: string;
}

export interface ManagedOrganization {
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

export interface CreateOrganizationInput {
    name: string;
    slug: string;
    imageUrl?: string | null;
    maxMemberships?: number | null;
    publicMetadata?: Metadata;
    privateMetadata?: Metadata;
}

export interface UpdateOrganizationInput extends CreateOrganizationInput {
    expectedUpdatedAt: string;
}

export interface ManagedOrganizationMember {
    id: string;
    userId: string;
    email: string;
    roleId: string;
    roleKey: string;
    createdAt: string;
}

export interface ManagedInvitation {
    id: string;
    email: string;
    roleId: string;
    status: "pending" | "accepted" | "expired" | "revoked";
    expiresAt: string;
    createdAt: string;
    acceptedAt: string | null;
}

export interface InvitationResult {
    id: string;
    token: string;
    expiresAt: string;
    deliveryStatus: "queued";
    queuedAt: string;
}

export interface ManagedRole {
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

export interface ManagedPermission {
    id: string;
    key: string;
    name: string;
    description: string | null;
    isSystem: boolean;
}

export interface DeletionBlocker {
    resource: string;
    count: number;
    resolution: string;
}

export interface ManagedExternalProvider {
    id: string;
    name: string;
    displayName: string;
    issuerUrl: string;
    clientId: string;
    secretConfigured: boolean;
    enabled: boolean;
    allowSignup: boolean;
    connectedAccounts: number;
    callbackUrl: string;
    updatedAt: string;
}

export interface ExternalProviderInput {
    name: string;
    displayName: string;
    issuerUrl: string;
    clientId: string;
    enabled: boolean;
    allowSignup: boolean;
    clientSecret?: string;
}

export interface CreateExternalProviderInput extends ExternalProviderInput {
    clientSecret: string;
}

export interface UpdateExternalProviderInput extends ExternalProviderInput {
    expectedUpdatedAt: string;
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
    eventTypes: WebhookEventType[];
    enabled: boolean;
}
export interface UpdateWebhookEndpointInput extends WebhookEndpointInput {
    expectedUpdatedAt: string;
}
export interface ManagedWebhookEndpoint extends WebhookEndpointInput {
    id: string;
    createdAt: string;
    updatedAt: string;
}
export interface WebhookSecretResult {
    endpoint: ManagedWebhookEndpoint;
    signingSecret: string;
}
export type WebhookDeliveryStatus =
    "pending" | "sending" | "retrying" | "delivered" | "failed" | "cancelled";
export interface WebhookDeliveryListOptions extends ManagementRequestOptions {
    limit?: number;
    cursor?: string;
    endpointId?: string;
    status?: WebhookDeliveryStatus;
}
export interface ManagedWebhookDelivery {
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
