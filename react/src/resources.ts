export interface CursorPage<T> {
    items: T[];
    nextCursor: string | null;
    hasMore: boolean;
}
export interface DirectoryQuery {
    limit?: number;
    cursor?: string;
    search?: string;
}
function directoryQuery(query: DirectoryQuery = {}): string {
    const parameters = new URLSearchParams({
        paged: "true",
        limit: String(query.limit ?? 50),
    });
    if (query.cursor) parameters.set("cursor", query.cursor);
    if (query.search) parameters.set("search", query.search);
    return parameters.toString();
}
async function readDirectory<T>(
    load: (query: DirectoryQuery) => Promise<CursorPage<T>>,
    checkIdentity: () => void,
): Promise<T[]> {
    const items: T[] = [];
    let cursor: string | undefined;
    const seen = new Set<string>();
    do {
        checkIdentity();
        const page = await load({ limit: 100, ...(cursor ? { cursor } : {}) });
        checkIdentity();
        items.push(...page.items);
        if (!page.hasMore) return items;
        if (!page.nextCursor || seen.has(page.nextCursor))
            throw new Error("The directory returned an invalid continuation.");
        cursor = page.nextCursor;
        seen.add(cursor);
    } while (cursor);
    return items;
}
export interface Page<T> {
    items: T[];
    page: number;
    pageSize: number;
    totalCount: number;
}
export interface Profile {
    id: string;
    firstName: string;
    lastName: string;
    imageUrl: string | null;
    updatedAt: string;
    publicMetadata: Record<string, unknown>;
    unsafeMetadata: Record<string, unknown>;
}
export interface AccountSession {
    id: string;
    createdAt: string;
    lastSeenAt: string;
    expiresAt: string;
    revokedAt: string | null;
    current: boolean;
    device: string;
    ipAddress: string | null;
    status: "active" | "expired" | "revoked";
    idleExpiresAt: string;
}
export interface UserApiKey {
    id: string;
    name: string;
    description: string | null;
    keyPrefix: string;
    scopes: string[];
    expired: boolean;
    expiresAt: string | null;
    lastUsedAt: string | null;
    createdAt: string;
}
export interface SecurityState {
    hasPassword: boolean;
    passwordEnabled: boolean;
    authenticatorEnabled: boolean;
    authenticatorRequired: boolean;
    recoveryCodesRemaining: number;
    recentAuthenticationExpiresAt: string;
}
export interface Passkey {
    id: string;
    name: string;
    rpId: string;
    createdAt: string;
    lastUsedAt: string | null;
}
export interface ConnectedAccount {
    id: string;
    providerId: string;
    provider: string;
    displayName: string;
    email: string | null;
    createdAt: string;
}
export interface SecurityProof {
    password?: string;
    code?: string;
    requestId?: string;
    emailCode?: string;
}
export interface VerificationRequest {
    requestId: string;
    message: string;
}
export interface AuthenticatorEnrollment {
    enrollmentId: string;
    setupKey: string;
    authenticatorUri: string;
    expiresAt: string;
}
export interface Organization {
    id: string;
    instanceId: string;
    name: string;
    slug: string;
    imageUrl: string | null;
    maxMemberships: number | null;
    publicMetadata: Record<string, unknown>;
    createdAt: string;
    updatedAt: string;
}
/** Public metadata is read-only here: only your backend sets it, because your app may trust it. */
export interface OrganizationInput {
    name: string;
    slug: string;
    imageUrl?: string | null;
    expectedUpdatedAt?: string;
}
export interface OrganizationMember {
    userId: string;
    email: string;
    roleId: string;
    roleKey: string;
    createdAt: string;
}
export interface OrganizationInvitation {
    id: string;
    email: string;
    roleId: string;
    status: string;
    expiresAt: string;
    createdAt: string;
}
export interface OrganizationRole {
    id: string;
    key: string;
    name: string;
    permissions: string[];
}

export type ResourceRequest = <T>(
    method: string,
    path: string,
    body?: unknown,
) => Promise<T>;
const integerId = (value: string): string => {
    if (!/^[1-9]\d{0,9}$/.test(value) || Number(value) > 2_147_483_647)
        throw new Error("Provide a valid resource ID.");
    return value;
};
const publicId = (value: string): string => {
    if (
        !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
            value,
        )
    )
        throw new Error("Provide a valid user ID.");
    return value;
};

export class AccountResource {
    constructor(private readonly request: ResourceRequest) {}
    get = (): Promise<Profile> => this.request("GET", "/v1/account/profile");
    update = (
        input: Pick<Profile, "firstName" | "lastName"> & {
            imageUrl?: string | null;
            unsafeMetadata: Record<string, unknown>;
            expectedUpdatedAt: string;
        },
    ): Promise<void> => this.request("PUT", "/v1/account/profile", input);
    security = (): Promise<SecurityState> =>
        this.request("GET", "/v1/account/security");
    passkeys = (): Promise<Passkey[]> =>
        this.request("GET", "/v1/account/security/passkeys");
    connections = (): Promise<ConnectedAccount[]> =>
        this.request("GET", "/v1/account/security/connections");
    disconnect = (id: string): Promise<void> =>
        this.request(
            "DELETE",
            `/v1/account/security/connections/${integerId(id)}`,
        );
    removePasskey = (id: string): Promise<void> =>
        this.request(
            "DELETE",
            `/v1/account/security/passkeys/${integerId(id)}`,
        );
    requestReauthentication = (): Promise<VerificationRequest> =>
        this.request("POST", "/v1/account/security/reauthenticate/request");
    reauthenticate = (proof: SecurityProof): Promise<void> =>
        this.request("POST", "/v1/account/security/reauthenticate", proof);
    sessions = (page = 1, pageSize = 25): Promise<Page<AccountSession>> =>
        this.request(
            "GET",
            `/v1/account/sessions?page=${page}&pageSize=${pageSize}`,
        );
    revokeSession = (id: string): Promise<void> => {
        if (!/^[1-9]\d{0,18}$/.test(id))
            throw new Error("Provide a valid session ID.");
        return this.request("POST", `/v1/account/sessions/${id}/revoke`);
    };
    revokeAllSessions = (): Promise<void> =>
        this.request("POST", "/v1/account/sessions/revoke-all");
    changePassword = (
        currentPassword: string,
        password: string,
        code?: string,
    ): Promise<void> =>
        this.request("POST", "/v1/account/password", {
            currentPassword,
            password,
            ...(code ? { code } : {}),
        });
    setPassword = (
        password: string,
        proof: SecurityProof = {},
    ): Promise<void> =>
        this.request("POST", "/v1/account/password", {
            password,
            ...(proof.password ? { currentPassword: proof.password } : {}),
            ...(proof.code ? { code: proof.code } : {}),
            ...(proof.requestId ? { requestId: proof.requestId } : {}),
            ...(proof.emailCode ? { emailCode: proof.emailCode } : {}),
        });
    requestEmailChange = (identifier: string): Promise<VerificationRequest> =>
        this.request("POST", "/v1/account/email/request", { identifier });
    completeEmailChange = (requestId: string, code: string): Promise<void> =>
        this.request("POST", "/v1/account/email/complete", { requestId, code });
    requestDeactivation = (): Promise<VerificationRequest> =>
        this.request("POST", "/v1/account/deletion/request");
    deactivate = (requestId: string, code: string): Promise<void> =>
        this.request("POST", "/v1/account/deletion/complete", {
            requestId,
            code,
        });
    enrollAuthenticator = (
        proof: SecurityProof,
    ): Promise<AuthenticatorEnrollment> =>
        this.request(
            "POST",
            "/v1/account/security/authenticator/enroll",
            proof,
        );
    confirmAuthenticator = (
        enrollmentId: string,
        code: string,
    ): Promise<{ recoveryCodes: string[] }> =>
        this.request("POST", "/v1/account/security/authenticator/confirm", {
            enrollmentId,
            code,
        });
    removeAuthenticator = (proof: SecurityProof): Promise<void> =>
        this.request(
            "POST",
            "/v1/account/security/authenticator/remove",
            proof,
        );
    regenerateRecoveryCodes = (
        proof: SecurityProof,
    ): Promise<{ recoveryCodes: string[] }> =>
        this.request("POST", "/v1/account/security/recovery-codes", proof);
    apiKeys = (): Promise<UserApiKey[]> =>
        this.request("GET", "/v1/account/api-keys");
    /** Creates an API key. It needs a recent sign-in, starts with no scopes or claims (your backend grants those) and
     * stops working when the user's credentials change. The secret is returned only once. */
    createApiKey = (input: {
        name: string;
        description?: string;
        secondsUntilExpiration?: number;
    }): Promise<{ apiKey: UserApiKey; secret: string }> =>
        this.request("POST", "/v1/account/api-keys", input);
    revokeApiKey = (id: string, revocationReason?: string): Promise<void> => {
        if (!/^[1-9]\d{0,18}$/.test(id))
            throw new Error("Provide a valid API key ID.");
        return this.request("POST", `/v1/account/api-keys/${id}/revoke`, {
            revocationReason: revocationReason ?? null,
        });
    };
}

export class OrganizationResource {
    constructor(
        private readonly request: ResourceRequest,
        private readonly beginOperation: () => () => void = () => () => {},
    ) {}
    listPage = (
        query: DirectoryQuery = {},
    ): Promise<CursorPage<Organization>> =>
        this.request(
            "GET",
            "/v1/account/organizations?" + directoryQuery(query),
        );
    list = (): Promise<Organization[]> =>
        readDirectory((query) => this.listPage(query), this.beginOperation());
    create = (input: OrganizationInput): Promise<{ id: string }> =>
        this.request("POST", "/v1/account/organizations", input);
    setActive = (id: string | null): Promise<void> =>
        this.request("PUT", "/v1/account/organizations/active", {
            organizationId: id === null ? null : Number(integerId(id)),
        });
    update = (
        id: string,
        input: OrganizationInput & { expectedUpdatedAt: string },
    ): Promise<void> =>
        this.request(
            "PUT",
            `/v1/account/organizations/${integerId(id)}`,
            input,
        );
    membersPage = (
        id: string,
        query: DirectoryQuery = {},
    ): Promise<CursorPage<OrganizationMember>> =>
        this.request(
            "GET",
            `/v1/account/organizations/${integerId(id)}/memberships?${directoryQuery(query)}`,
        );
    members = (id: string): Promise<OrganizationMember[]> =>
        readDirectory(
            (query) => this.membersPage(id, query),
            this.beginOperation(),
        );
    invitationsPage = (
        id: string,
        query: DirectoryQuery = {},
    ): Promise<CursorPage<OrganizationInvitation>> =>
        this.request(
            "GET",
            `/v1/account/organizations/${integerId(id)}/invitations?${directoryQuery(query)}`,
        );
    invitations = (id: string): Promise<OrganizationInvitation[]> =>
        readDirectory(
            (query) => this.invitationsPage(id, query),
            this.beginOperation(),
        );
    roles = (id: string): Promise<OrganizationRole[]> =>
        this.request("GET", `/v1/account/organizations/${integerId(id)}/roles`);
    invite = (
        id: string,
        email: string,
        roleId: string,
    ): Promise<{ id: string; expiresAt: string }> =>
        this.request(
            "POST",
            `/v1/account/organizations/${integerId(id)}/invitations`,
            { email, roleId: Number(integerId(roleId)) },
        );
    acceptInvitation = (token: string): Promise<void> =>
        this.request("POST", "/v1/account/organizations/accept-invitation", {
            token,
        });
    revokeInvitation = (id: string, invitationId: string): Promise<void> =>
        this.request(
            "DELETE",
            `/v1/account/organizations/${integerId(id)}/invitations/${integerId(invitationId)}`,
        );
    setMemberRole = (
        id: string,
        userId: string,
        roleId: string,
    ): Promise<void> =>
        this.request(
            "PUT",
            `/v1/account/organizations/${integerId(id)}/memberships/${publicId(userId)}`,
            { roleId: Number(integerId(roleId)) },
        );
    removeMember = (id: string, userId: string): Promise<void> =>
        this.request(
            "DELETE",
            `/v1/account/organizations/${integerId(id)}/memberships/${publicId(userId)}`,
        );
    leave = (id: string): Promise<void> =>
        this.request(
            "POST",
            `/v1/account/organizations/${integerId(id)}/leave`,
        );
    /** Deletes the organization. Only an owner can; every membership and pending invitation ends with it. */
    delete = (id: string): Promise<void> =>
        this.request("DELETE", `/v1/account/organizations/${integerId(id)}`);
}
