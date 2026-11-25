import { attestationJson, creationOptions, type PublicKeyCredentialCreationOptionsJSON } from "./client.js";import type { components } from "./generated/frontend.js";

type FrontendSchemas = components["schemas"];
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
    endedAt: string | null;
    current: boolean;
    device: string;
    ipAddress: string | null;
    status: "active" | "expired" | "signed_out" | "revoked";
    idleExpiresAt: string;
}
/** One of the signed-in user's API keys. */
export type UserApiKey = Pick<
    FrontendSchemas["ApiKeyResponse"],
    "id" | "name" | "description" | "keyPrefix" | "scopes" | "expired" | "expiresAt" | "lastUsedAt" | "createdAt"
>;
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
export interface AccountIdentifiers {
    emailAddresses: { id: string; emailAddress: string; primary: boolean; verified: boolean }[];
    username: string | null;
    usernameMode: "off" | "optional" | "required";
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
export type OrganizationInput = Pick<FrontendSchemas["OrganizationInput"], "name" | "slug" | "imageUrl" | "expectedUpdatedAt">;
/** A member and their role, by key (`org:admin`) and name. */
export interface OrganizationMember {
    id: string;
    userId: string;
    email: string | null;
    role: string;
    roleName: string;
    createdAt: string;
}
/** An invitation and the role it grants, by key and name. */
export interface OrganizationInvitation {
    id: string;
    email: string;
    role: string;
    roleName: string;
    status: string;
    expiresAt: string;
    createdAt: string;
}
/** One of the environment's organization roles, which every organization shares. */
export type OrganizationRole = FrontendSchemas["OrganizationRoleResponse"];

export type ResourceRequest = <T>(
    method: string,
    path: string,
    body?: unknown,
) => Promise<T>;
/** Checks the shape of a public ID (`org_…`, `passkey_…`); the API checks that its prefix fits. */
const publicId = (value: string): string => {
    if (!/^[a-z]+_[0-9A-Za-z]{11}$/.test(value))
        throw new Error("Provide a valid ID, such as org_0Hk3pQ9xZb2.");
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
            `/v1/account/security/connections/${publicId(id)}`,
        );
    identifiers = (): Promise<AccountIdentifiers> => this.request("GET", "/v1/account/identifiers");
    /** Sends a code to an address to add. Needs a recent sign-in. */
    addEmailAddress = (emailAddress: string): Promise<{ requestId: string; expiresAt: string }> =>
        this.request("POST", "/v1/account/identifiers/email", { emailAddress });
    verifyEmailAddress = (requestId: string, code: string): Promise<void> =>
        this.request("POST", "/v1/account/identifiers/email/verify", { requestId, code });
    makePrimaryEmailAddress = (id: string): Promise<void> =>
        this.request("POST", `/v1/account/identifiers/${publicId(id)}/primary`);
    removeEmailAddress = (id: string): Promise<void> =>
        this.request("DELETE", `/v1/account/identifiers/${publicId(id)}`);
    /** Sets, changes or (with null) removes the username. Needs a recent sign-in. */
    setUsername = (username: string | null): Promise<void> =>
        this.request("PUT", "/v1/account/identifiers/username", { username });
    /** Adds a passkey: the browser creates one for this account and Pisti registers it. Needs a recent sign-in. */
    addPasskey = async (name: string): Promise<void> => {
        const started = await this.request<{ requestId: string; options: PublicKeyCredentialCreationOptionsJSON }>(
            "POST", "/v1/account/security/passkeys/options", { name });
        const credential = await navigator.credentials.create({ publicKey: creationOptions(started.options) });
        if (!credential) throw new Error("No passkey was created.");
        await this.request("POST", "/v1/account/security/passkeys", {
            requestId: started.requestId,
            credential: attestationJson(credential as PublicKeyCredential),
        });
    };
    /** Connects a sign-in provider: the browser goes to it and returns to `redirectUrl` with `__pisti_connection`. */
    connect = async (providerId: string, redirectUrl: string = location.href): Promise<never> => {
        const started = await this.request<{ url: string }>("POST", "/v1/account/security/connections", { providerId, redirectUrl });
        location.assign(started.url);
        return new Promise<never>(() => {});
    };
    removePasskey = (id: string): Promise<void> =>
        this.request(
            "DELETE",
            `/v1/account/security/passkeys/${publicId(id)}`,
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
    /** Sets or changes the password. `proof` is the current password, or an email code from
     * `requestReauthentication()`, plus a second factor when an authenticator is enrolled. */
    setPassword = (password: string, proof: SecurityProof): Promise<void> =>
        this.request("POST", "/v1/account/password", {
            password,
            ...credentialProof(proof),
        });
    /** Sends a code to the new address. Needs the same proof as `setPassword`. */
    requestEmailChange = (
        identifier: string,
        proof: SecurityProof,
    ): Promise<VerificationRequest> =>
        this.request("POST", "/v1/account/email/request", {
            identifier,
            ...credentialProof(proof),
        });
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
            organizationId: id === null ? null : publicId(id),
        });
    update = (
        id: string,
        input: OrganizationInput & { expectedUpdatedAt: string },
    ): Promise<void> =>
        this.request(
            "PUT",
            `/v1/account/organizations/${publicId(id)}`,
            input,
        );
    membersPage = (
        id: string,
        query: DirectoryQuery = {},
    ): Promise<CursorPage<OrganizationMember>> =>
        this.request(
            "GET",
            `/v1/account/organizations/${publicId(id)}/memberships?${directoryQuery(query)}`,
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
            `/v1/account/organizations/${publicId(id)}/invitations?${directoryQuery(query)}`,
        );
    invitations = (id: string): Promise<OrganizationInvitation[]> =>
        readDirectory(
            (query) => this.invitationsPage(id, query),
            this.beginOperation(),
        );
    /** The roles the signed-in member may give others in the organization: none without
     * `org:sys_memberships:manage`, otherwise every role whose permissions they all hold. */
    assignableRoles = async (id: string): Promise<OrganizationRole[]> =>
        (
            await this.request<FrontendSchemas["ListPageOfOrganizationRoleResponse"]>(
                "GET",
                `/v1/account/organizations/${publicId(id)}/roles`,
            )
        ).items;
    /** Invites someone into a role, by key (`org:member`); without one, the environment's default role. */
    invite = (
        id: string,
        email: string,
        role?: string,
    ): Promise<{ id: string; expiresAt: string }> =>
        this.request(
            "POST",
            `/v1/account/organizations/${publicId(id)}/invitations`,
            role === undefined ? { email } : { email, role },
        );
    acceptInvitation = (token: string): Promise<void> =>
        this.request("POST", "/v1/account/organizations/accept-invitation", {
            token,
        });
    revokeInvitation = (id: string, invitationId: string): Promise<void> =>
        this.request(
            "DELETE",
            `/v1/account/organizations/${publicId(id)}/invitations/${publicId(invitationId)}`,
        );
    /** Changes a member's role, by key (`org:admin`). */
    setMemberRole = (
        id: string,
        userId: string,
        role: string,
    ): Promise<void> =>
        this.request(
            "PUT",
            `/v1/account/organizations/${publicId(id)}/memberships/${publicId(userId)}`,
            { role },
        );
    removeMember = (id: string, userId: string): Promise<void> =>
        this.request(
            "DELETE",
            `/v1/account/organizations/${publicId(id)}/memberships/${publicId(userId)}`,
        );
    leave = (id: string): Promise<void> =>
        this.request(
            "POST",
            `/v1/account/organizations/${publicId(id)}/leave`,
        );
    /** Deletes the organization, with `org:sys_profile:delete`; every membership and pending invitation ends with it. */
    delete = (id: string): Promise<void> =>
        this.request("DELETE", `/v1/account/organizations/${publicId(id)}`);
}

/** Credential-changing routes name the current password `currentPassword`. */
function credentialProof(proof: SecurityProof) {
    return {
        ...(proof.password ? { currentPassword: proof.password } : {}),
        ...(proof.code ? { code: proof.code } : {}),
        ...(proof.requestId ? { requestId: proof.requestId } : {}),
        ...(proof.emailCode ? { emailCode: proof.emailCode } : {}),
    };
}
