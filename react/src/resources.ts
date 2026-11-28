import { attestationJson, creationOptions, passkeyCeremony, type PublicKeyCredentialCreationOptionsJSON } from "./client.js";
import type { components } from "./generated/frontend.js";

type FrontendSchemas = components["schemas"];

/** One page of a list, as the session API returns it. */
export interface CursorPage<T> {
    items: T[];
    nextCursor: string | null;
    hasMore: boolean;
}
export interface PageQuery {
    limit?: number;
    cursor?: string;
}
export interface DirectoryQuery extends PageQuery {
    search?: string;
}

/** The signed-in user, from `GET /v1/me`. */
export type Me = FrontendSchemas["MeResponse"];
/** What `PATCH /v1/me` changes; a left-out field keeps its value, `""` removes the image or the username. */
export type UpdateMeInput = {
    firstName?: string;
    lastName?: string;
    imageUrl?: string;
    unsafeMetadata?: Record<string, unknown>;
    username?: string;
    primaryEmailAddressId?: string;
    expectedUpdatedAt?: string;
};
export type UserEmailAddressData = FrontendSchemas["UserEmailAddressResponse"];
/** One of the user's email addresses, with Clerk's verification methods. */
export interface UserEmailAddress extends UserEmailAddressData {
    /** Sends a new code to the address. */
    prepareVerification(): Promise<UserEmailAddress>;
    /** Checks the code; the address is then verified and keeps its ID. */
    attemptVerification(input: { code: string }): Promise<UserEmailAddress>;
    destroy(): Promise<void>;
}
export type Passkey = FrontendSchemas["PasskeyResponse"];
/** An authenticator app being set up: add `secret` (or `uri`) to the app, then `verifyTOTP({ code })`. */
export type TOTP = FrontendSchemas["TotpResponse"];
export type BackupCodes = FrontendSchemas["BackupCodesResponse"];
export type ExternalAccount = FrontendSchemas["ConnectedIdentity"];
/** One of the user's sessions on any device, ended ones included; `current` marks this one. */
export type UserSession = FrontendSchemas["AccountSessionSummary"];
/** One of the signed-in user's API keys. */
export type UserApiKey = FrontendSchemas["ApiKeyResponse"];
export type CreatedApiKey = FrontendSchemas["CreatedApiKeyResponse"];
export type OrganizationMembership = FrontendSchemas["UserOrganizationMembershipResponse"];
export type UserOrganizationInvitation = FrontendSchemas["UserOrganizationInvitationResponse"];
export type Organization = FrontendSchemas["OrganizationResponse"];
/** Public metadata is read-only here: only your backend sets it, because your app may trust it. */
export type CreateOrganizationInput = { name: string; slug: string; imageUrl?: string };
export type UpdateOrganizationInput = { name?: string; slug?: string; imageUrl?: string; expectedUpdatedAt?: string };
/** A member and their role, by key (`org:admin`) and name. */
export type OrganizationMember = FrontendSchemas["OrganizationMemberResponse"];
/** An invitation and the role it grants, by key and name. */
export type OrganizationInvitation = FrontendSchemas["OrganizationInvitationResponse"];
export type SentInvitation = FrontendSchemas["SentInvitationResponse"];
/** One of the environment's organization roles, which every organization shares. */
export type OrganizationRole = FrontendSchemas["OrganizationRoleResponse"];
export type ClientState = FrontendSchemas["ClientState"];

/** Sends one session API request as the active session; the client adds the session, CSRF and reverification. */
export type SessionRequest = <T>(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    body?: unknown,
    /** `reload: false` skips re-reading the client after a change, for one whose response is the new client. */
    options?: { reload?: boolean },
) => Promise<T>;

/** Checks the shape of a public ID (`org_…`, `passkey_…`); the API checks that its prefix fits. */
const publicId = (value: string): string => {
    if (!/^[a-z]+_[0-9A-Za-z]{11}$/.test(value)) throw new Error("Provide a valid ID, such as org_0Hk3pQ9xZb2.");
    return encodeURIComponent(value);
};

function query(values: DirectoryQuery = {}): string {
    const parameters = new URLSearchParams();
    if (values.limit !== undefined) parameters.set("limit", String(values.limit));
    if (values.cursor) parameters.set("cursor", values.cursor);
    if (values.search) parameters.set("search", values.search);
    const text = parameters.toString();
    return text ? "?" + text : "";
}

/** Reads every page of a list. */
export async function readAll<T>(load: (query: PageQuery) => Promise<CursorPage<T>>): Promise<T[]> {
    const items: T[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    for (;;) {
        const page = await load({ limit: 100, ...(cursor ? { cursor } : {}) });
        items.push(...page.items);
        if (!page.hasMore) return items;
        if (!page.nextCursor || seen.has(page.nextCursor)) throw new Error("The list returned an invalid continuation.");
        cursor = page.nextCursor;
        seen.add(cursor);
    }
}

/**
 * The signed-in user's own resources (`/v1/me`), named like Clerk's `User`. Sensitive changes may first ask the user
 * to verify their identity again (see `useReverification`), then continue.
 */
export class MeResource {
    constructor(
        private readonly request: SessionRequest,
        /** Applies a browser client returned by a change that replaced the session (a new password). */
        private readonly applyClient: (state: ClientState) => Promise<void>,
    ) {}

    get = (): Promise<Me> => this.request("GET", "/v1/me");
    /** Updates the profile. Setting `username` or `primaryEmailAddressId` needs a recent first factor. */
    update = (input: UpdateMeInput): Promise<Me> => this.request("PATCH", "/v1/me", input);
    /** Deactivates the account: the user can reactivate it with an email code for 30 days. Needs both factors. */
    delete = (): Promise<void> => this.request("DELETE", "/v1/me");
    /** Sets or changes the password, ending every other session and API key. This browser stays signed in on a
     * new session. Needs both factors. */
    updatePassword = async (input: { newPassword: string }): Promise<void> => {
        // The response is the browser client with the replacement session: apply it as it is, without re-reading.
        await this.applyClient(await this.request<ClientState>("POST", "/v1/me/change_password", input, { reload: false }));
    };

    // Email addresses
    getEmailAddresses = async (): Promise<UserEmailAddress[]> =>
        (await this.request<CursorPage<UserEmailAddressData>>("GET", "/v1/me/email_addresses")).items.map(this.emailAddress);
    /** Adds an address and sends it a code; `attemptVerification` on the result finishes. Needs a recent first factor. */
    createEmailAddress = async (input: { emailAddress: string }): Promise<UserEmailAddress> =>
        this.emailAddress(await this.request<UserEmailAddressData>("POST", "/v1/me/email_addresses", input));

    // Passkeys
    getPasskeys = async (): Promise<Passkey[]> => (await this.request<CursorPage<Passkey>>("GET", "/v1/me/passkeys")).items;
    /** Creates a passkey: the browser makes one for this account and Pisti registers it. Needs both factors. */
    createPasskey = async (input: { name: string }): Promise<Passkey> => {
        const pending = await this.request<FrontendSchemas["PendingPasskeyResponse"]>("POST", "/v1/me/passkeys", input);
        const credential = await passkeyCeremony(() =>
            navigator.credentials.create({
                publicKey: creationOptions(pending.verification.options as unknown as PublicKeyCredentialCreationOptionsJSON),
            }),
        );
        return this.request("POST", `/v1/me/passkeys/${publicId(pending.id)}/attempt_verification`, {
            credential: attestationJson(credential as PublicKeyCredential),
        });
    };
    deletePasskey = (id: string): Promise<void> => this.request("DELETE", `/v1/me/passkeys/${publicId(id)}`);

    // Authenticator app and backup codes
    /** Starts setting up an authenticator app. Needs both factors. */
    createTOTP = (): Promise<TOTP> => this.request("POST", "/v1/me/totp");
    /** Confirms the authenticator with a code from it and returns the backup codes, shown once. Other sessions end. */
    verifyTOTP = (input: { code: string }): Promise<BackupCodes> => this.request("POST", "/v1/me/totp/attempt_verification", input);
    /** Removes the authenticator, ending every session. Needs both factors. */
    disableTOTP = (): Promise<void> => this.request("DELETE", "/v1/me/totp");
    /** Replaces the backup codes. Needs both factors. */
    createBackupCode = (): Promise<BackupCodes> => this.request("POST", "/v1/me/backup_codes");

    // Provider accounts
    getExternalAccounts = async (): Promise<ExternalAccount[]> =>
        (await this.request<CursorPage<ExternalAccount>>("GET", "/v1/me/external_accounts")).items;
    /** Starts connecting a provider (`oauth_{id}` from the environment). Send the browser to
     * `externalVerificationRedirectUrl`; it returns to `redirectUrl` with `__pisti_connection`. Needs a recent first factor. */
    createExternalAccount = (input: { strategy: string; redirectUrl: string }): Promise<FrontendSchemas["ExternalAccountConnectionResponse"]> =>
        this.request("POST", "/v1/me/external_accounts", input);
    /** Disconnects a provider, ending every session. Needs a recent first factor. */
    deleteExternalAccount = (id: string): Promise<void> => this.request("DELETE", `/v1/me/external_accounts/${publicId(id)}`);

    // Sessions
    /** Every device's sessions. Shows addresses and browsers, so it needs a first factor within 60 minutes. */
    getSessions = (page: PageQuery = {}): Promise<CursorPage<UserSession>> => this.request("GET", "/v1/me/sessions" + query(page));
    /** Ends one session. Needs both factors. */
    revokeSession = (id: string): Promise<void> => this.request("POST", `/v1/me/sessions/${publicId(id)}/revoke`);
    /** Ends every session, this one included. Needs both factors. */
    revokeAllSessions = (): Promise<void> => this.request("POST", "/v1/me/sessions/revoke_all");

    // API keys
    getApiKeys = async (): Promise<UserApiKey[]> => (await this.request<CursorPage<UserApiKey>>("GET", "/v1/me/api_keys")).items;
    /** Creates an API key. It starts with no scopes or claims (your backend grants those), stops working when the
     * user's credentials change, and its secret is returned only once. Needs both factors. */
    createApiKey = ({ secondsUntilExpiration, ...input }: { name: string; description?: string; secondsUntilExpiration?: number }): Promise<CreatedApiKey> =>
        // The contract carries 64-bit integers as decimal strings.
        this.request("POST", "/v1/me/api_keys", {
            ...input,
            ...(secondsUntilExpiration === undefined ? {} : { secondsUntilExpiration: String(secondsUntilExpiration) }),
        });
    revokeApiKey = (id: string, revocationReason?: string): Promise<void> =>
        this.request("POST", `/v1/me/api_keys/${publicId(id)}/revoke`, revocationReason ? { revocationReason } : {});

    // Organizations
    getOrganizationMemberships = (page: DirectoryQuery = {}): Promise<CursorPage<OrganizationMembership>> =>
        this.request("GET", "/v1/me/organization_memberships" + query(page));
    /** Leaves an organization. Its last admin must make someone else an admin first, unless they are its only member. */
    leaveOrganization = (organizationId: string): Promise<void> =>
        this.request("DELETE", `/v1/me/organization_memberships/${publicId(organizationId)}`);
    /** Pending invitations to the user's verified addresses. */
    getOrganizationInvitations = (page: PageQuery = {}): Promise<CursorPage<UserOrganizationInvitation>> =>
        this.request("GET", "/v1/me/organization_invitations" + query(page));
    /** Joins the organization; it becomes the session's active organization. */
    acceptOrganizationInvitation = (invitationId: string): Promise<void> =>
        this.request("POST", `/v1/me/organization_invitations/${publicId(invitationId)}/accept`);

    private readonly emailAddress = (data: UserEmailAddressData): UserEmailAddress => {
        const path = `/v1/me/email_addresses/${publicId(data.id)}`;
        return {
            ...data,
            prepareVerification: async () =>
                this.emailAddress(await this.request<UserEmailAddressData>("POST", path + "/prepare_verification", { strategy: "email_code" })),
            attemptVerification: async (input) =>
                this.emailAddress(await this.request<UserEmailAddressData>("POST", path + "/attempt_verification", input)),
            destroy: () => this.request("DELETE", path),
        };
    };
}

/** What members manage in their organizations (`/v1/organizations/{id}/…`), named like Clerk's `Organization`. An
 * organization the user is not a member of is `404`; an action their role does not allow is `403`. */
export class OrganizationResource {
    constructor(private readonly request: SessionRequest) {}

    /** Creates an organization with the user as its `org:admin`, while the environment allows it. */
    create = (input: CreateOrganizationInput): Promise<Organization> => this.request("POST", "/v1/organizations", input);
    get = (id: string): Promise<Organization> => this.request("GET", `/v1/organizations/${publicId(id)}`);
    /** Renames it or changes its slug or image, with `org:sys_profile:manage`. */
    update = (id: string, input: UpdateOrganizationInput): Promise<Organization> =>
        this.request("PATCH", `/v1/organizations/${publicId(id)}`, input);
    /** Deletes it, with `org:sys_profile:delete` and a recent first factor; every membership and invitation ends. */
    destroy = (id: string): Promise<void> => this.request("DELETE", `/v1/organizations/${publicId(id)}`);
    getMemberships = (id: string, page: DirectoryQuery = {}): Promise<CursorPage<OrganizationMember>> =>
        this.request("GET", `/v1/organizations/${publicId(id)}/memberships` + query(page));
    /** Changes a member's role, by key (`org:admin`). */
    updateMember = (id: string, userId: string, input: { role: string }): Promise<void> =>
        this.request("PATCH", `/v1/organizations/${publicId(id)}/memberships/${publicId(userId)}`, input);
    removeMember = (id: string, userId: string): Promise<void> =>
        this.request("DELETE", `/v1/organizations/${publicId(id)}/memberships/${publicId(userId)}`);
    getInvitations = (id: string, page: DirectoryQuery = {}): Promise<CursorPage<OrganizationInvitation>> =>
        this.request("GET", `/v1/organizations/${publicId(id)}/invitations` + query(page));
    /** Invites someone into a role, by key (`org:member`); without one, the environment's default role. */
    inviteMember = (id: string, input: { emailAddress: string; role?: string; lifetimeDays?: number }): Promise<SentInvitation> =>
        this.request("POST", `/v1/organizations/${publicId(id)}/invitations`, {
            email: input.emailAddress,
            ...(input.role ? { role: input.role } : {}),
            ...(input.lifetimeDays === undefined ? {} : { lifetimeDays: input.lifetimeDays }),
        });
    revokeInvitation = (id: string, invitationId: string): Promise<void> =>
        this.request("POST", `/v1/organizations/${publicId(id)}/invitations/${publicId(invitationId)}/revoke`);
    /** The roles the signed-in member may give others: none without `org:sys_memberships:manage`. */
    getRoles = async (id: string): Promise<OrganizationRole[]> =>
        (await this.request<CursorPage<OrganizationRole>>("GET", `/v1/organizations/${publicId(id)}/roles`)).items;
}
