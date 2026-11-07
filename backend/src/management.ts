import { parsePublishableKey } from "./keys.js";
import { authenticateRequest, verifyToken } from "./tokens.js";
import type { AcceptsToken, AuthenticateRequestOptions, AuthObjectFor, RequestState, SessionClaims, VerifyTokenOptions } from "./types.js";
import type {
    ManagementClientOptions,
    ManagementRequestOptions,
    ManagedInstance,
    ManagementListOptions,
    ManagementPage,
    User,
    EmailAddress,
    CreateUserInput,
    UpdateUserInput,
    UserStatus,
    DirectoryExternalAccount,
    Session,
    SessionListOptions,
    ApiKey,
    ApiKeyListOptions,
    UpdateApiKeyInput,
    Metadata,
    ManagedOrganization,
    CreateOrganizationInput,
    UpdateOrganizationInput,
    ManagedOrganizationMember,
    ManagedInvitation,
    InvitationResult,
    ManagedRole,
    RoleInput,
    ManagedPermission,
    DeletionBlocker,
    ManagedExternalProvider,
    CreateExternalProviderInput,
    UpdateExternalProviderInput,
    WebhookEndpointInput,
    UpdateWebhookEndpointInput,
    ManagedWebhookEndpoint,
    WebhookSecretResult,
    WebhookEventType,
    WebhookDeliveryListOptions,
    ManagedWebhookDelivery,
    WebhookDeliveryDetails,
} from "./management-types.js";

export type * from "./management-types.js";

/** Structured service failure. No credentials or raw requests are retained. */
export class PistiManagementError extends Error {
    constructor(
        message: string,
        readonly status: number,
        readonly requestId: string | null = null,
        readonly code: string | null = null,
        readonly retryAfterSeconds: number | null = null,
        readonly fieldErrors: Readonly<Record<string, string[]>> = {},
        readonly blockers: readonly DeletionBlocker[] = [],
    ) {
        super(message);
        this.name = "PistiManagementError";
    }
}

function integerId(value: string): string {
    if (!/^[1-9]\d{0,9}$/.test(value) || Number(value) > 2_147_483_647)
        throw new Error("Provide a positive resource ID.");
    return value;
}

function sessionId(value: string): string {
    if (
        !/^[1-9]\d{0,18}$/.test(value) ||
        BigInt(value) > 9_223_372_036_854_775_807n
    )
        throw new Error("Provide a valid session ID.");
    return value;
}

function userId(value: string): string {
    if (
        !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
            value,
        )
    )
        throw new Error("Provide a valid user ID.");
    return value;
}

function listQuery(
    options: ManagementListOptions & { status?: UserStatus } = {},
): string {
    const query = new URLSearchParams({ paged: "true" });
    if (options.limit !== undefined) {
        if (
            !Number.isInteger(options.limit) ||
            options.limit < 1 ||
            options.limit > 100
        )
            throw new Error("Use a page limit between 1 and 100.");
        query.set("limit", String(options.limit));
    }
    if (options.cursor !== undefined) {
        if (options.cursor.length > 128)
            throw new Error("The pagination cursor is too long.");
        query.set("cursor", options.cursor);
    }
    if (options.search !== undefined) {
        if (options.search.length > 200)
            throw new Error("Search must be at most 200 characters.");
        query.set("search", options.search);
    }
    if (options.status !== undefined) query.set("status", options.status);
    return "?" + query;
}

async function readJson(response: Response): Promise<unknown> {
    const reader = response.body?.getReader();
    if (!reader) return null;
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
        while (true) {
            const part = await reader.read();
            if (part.done) break;
            length += part.value.byteLength;
            if (length > 1_048_576) {
                await reader.cancel();
                throw new PistiManagementError(
                    "The service response is too large.",
                    502,
                );
            }
            chunks.push(part.value);
        }
    } finally {
        reader.releaseLock();
    }
    try {
        return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
        return null;
    }
}

function object(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
}

type RequestResource = <T>(
    method: string,
    path: string,
    body?: unknown,
    options?: ManagementRequestOptions,
) => Promise<T>;

/** Server-side client for one environment: request authentication and the management API. */
export class PistiClient {
    readonly #apiUrl: URL;
    readonly #secretKey: string | undefined;
    readonly #publishableKey: string;
    readonly #authorizedParties: string[] | undefined;
    #basePath: Promise<string> | undefined;
    readonly #timeoutMs: number;

    readonly users: ManagementUsers;
    readonly organizations: ManagementOrganizations;
    readonly sessions: ManagementSessions;
    readonly externalProviders: ManagementExternalProviders;
    readonly webhooks: ManagementWebhooks;
    readonly apiKeys: ManagementApiKeys;

    constructor(options: ManagementClientOptions = {}) {
        if (typeof window !== "undefined" && typeof document !== "undefined")
            throw new Error("The Pisti backend client belongs only in your server environment.");
        const secretKey = options.secretKey ?? process.env.PISTI_SECRET_KEY;
        const publishableKey = options.publishableKey ?? process.env.PISTI_PUBLISHABLE_KEY;
        if (!publishableKey)
            throw new Error(
                "Missing Pisti publishable key. Set PISTI_PUBLISHABLE_KEY (copy it from your application's Home page in the Pisti console) or pass { publishableKey }.",
            );
        const key = parsePublishableKey(publishableKey);
        if (secretKey !== undefined) {
            if (!/^sk_(?:test|live)_[a-f0-9]{16}\.[a-f0-9]{64}$/.test(secretKey))
                throw new Error("PISTI_SECRET_KEY doesn’t look like a Pisti secret key (sk_test_… or sk_live_…).");
            if ((key.environment === "live") !== secretKey.startsWith("sk_live_"))
                throw new Error("The secret key and publishable key belong to different environments.");
            if (key.apiUrl.protocol === "http:" && secretKey.startsWith("sk_live_"))
                throw new Error("Production credentials require HTTPS.");
        }
        this.#apiUrl = key.apiUrl;
        this.#secretKey = secretKey;
        this.#publishableKey = publishableKey;
        this.#authorizedParties = options.authorizedParties;
        this.#timeoutMs = options.timeoutMs ?? 10_000;
        if (
            !Number.isInteger(this.#timeoutMs) ||
            this.#timeoutMs < 1000 ||
            this.#timeoutMs > 60_000
        )
            throw new Error(
                "Use a timeout between 1000 and 60000 milliseconds.",
            );
        const request: RequestResource = async (method, path, body, requestOptions) =>
            this.#request(method, (await this.#instancePath()) + path, body, requestOptions);
        this.users = new ManagementUsers(request);
        this.organizations = new ManagementOrganizations(request);
        this.sessions = new ManagementSessions(request);
        this.externalProviders = new ManagementExternalProviders(request);
        this.webhooks = new ManagementWebhooks(request);
        this.apiKeys = new ManagementApiKeys(request);
    }

    /**
     * Authenticates a Fetch API `Request` using this client's publishable key. Never throws for a
     * missing or bad token; check `isAuthenticated` and call `toAuth()`.
     */
    authenticateRequest<T extends AcceptsToken = "session_token">(
        request: Request,
        options: AuthenticateRequestOptions & { acceptsToken?: T } = {},
    ): Promise<RequestState<AuthObjectFor<T>>> {
        return authenticateRequest(request, {
            publishableKey: this.#publishableKey,
            ...(this.#secretKey ? { secretKey: this.#secretKey } : {}),
            ...(this.#authorizedParties ? { authorizedParties: this.#authorizedParties } : {}),
            ...options,
        });
    }

    /** Verifies a session token and returns its claims. */
    verifyToken(token: string, options: VerifyTokenOptions = {}): Promise<SessionClaims> {
        return verifyToken(token, {
            publishableKey: this.#publishableKey,
            ...(this.#authorizedParties ? { authorizedParties: this.#authorizedParties } : {}),
            ...options,
        });
    }

    /** The environment the secret key belongs to. */
    getInstance(options: ManagementRequestOptions = {}): Promise<ManagedInstance> {
        return this.#request<ManagedInstance>("GET", "/v1/instance", undefined, options);
    }

    #requireSecretKey(): string {
        if (!this.#secretKey)
            throw new Error(
                "Missing Pisti secret key. Create one under API keys in the Pisti console and set PISTI_SECRET_KEY, or pass { secretKey }.",
            );
        return this.#secretKey;
    }

    // The secret key identifies its environment; resolve the management path from it once.
    #instancePath(): Promise<string> {
        return (this.#basePath ??= this.getInstance()
            .then((instance) => `/v1/management/instances/${integerId(instance.id)}`)
            .catch((error: unknown) => {
                this.#basePath = undefined;
                throw error;
            }));
    }

    async #request<T>(
        method: string,
        path: string,
        body?: unknown,
        options: ManagementRequestOptions = {},
    ): Promise<T> {
        const serialized =
            body === undefined ? undefined : JSON.stringify(body);
        if (serialized && Buffer.byteLength(serialized) > 65_536)
            throw new Error("The management request exceeds 64 KiB.");
        let response: Response;
        let payload: unknown;
        const timeout = AbortSignal.timeout(this.#timeoutMs);
        try {
            response = await fetch(
                new URL(path.slice(1), this.#apiUrl),
                {
                    method,
                    headers: {
                        Authorization: "Bearer " + this.#requireSecretKey(),
                        Accept: "application/json",
                        ...(serialized === undefined
                            ? {}
                            : { "Content-Type": "application/json" }),
                    },
                    ...(serialized === undefined ? {} : { body: serialized }),
                    signal: options.signal
                        ? AbortSignal.any([timeout, options.signal])
                        : timeout,
                    redirect: "error",
                },
            );
            if (response.status === 204) return undefined as T;
            payload = await readJson(response);
        } catch (error) {
            if (error instanceof PistiManagementError) throw error;
            throw new PistiManagementError(
                options.signal?.aborted
                    ? "The management request was canceled."
                    : "The management service could not be reached. Try again shortly.",
                0,
                null,
                options.signal?.aborted
                    ? "request_cancelled"
                    : timeout.aborted
                      ? "request_timeout"
                      : "service_unavailable",
            );
        }
        const value = object(payload);
        const meta = object(value?.meta);
        const requestId =
            typeof value?.requestId === "string"
                ? value.requestId
                : typeof meta?.requestId === "string"
                  ? meta.requestId
                  : response.headers.get("X-Request-ID");
        if (!response.ok) {
            const fields: Record<string, string[]> = Object.create(null);
            for (const [name, messages] of Object.entries(
                object(value?.errors) ?? {},
            ))
                if (Array.isArray(messages))
                    fields[name] = messages.filter(
                        (message): message is string =>
                            typeof message === "string",
                    );
            const blockers = Array.isArray(value?.blockers)
                ? value.blockers.flatMap((item) => {
                      const blocker = object(item);
                      return blocker &&
                          typeof blocker.resource === "string" &&
                          typeof blocker.count === "number" &&
                          typeof blocker.resolution === "string"
                          ? [
                                {
                                    resource: blocker.resource,
                                    count: blocker.count,
                                    resolution: blocker.resolution,
                                },
                            ]
                          : [];
                  })
                : [];
            const retry = response.headers.get("Retry-After");
            const retrySeconds =
                retry && /^\d{1,10}$/.test(retry) ? Number(retry) : null;
            throw new PistiManagementError(
                typeof value?.detail === "string"
                    ? value.detail
                    : typeof value?.title === "string"
                      ? value.title
                      : "The management request failed.",
                response.status,
                requestId,
                typeof value?.code === "string" ? value.code : null,
                retrySeconds,
                fields,
                blockers,
            );
        }
        if (
            !value ||
            !("data" in value) ||
            !meta ||
            typeof meta.requestId !== "string"
        )
            throw new PistiManagementError(
                "The management service returned an invalid response.",
                502,
                requestId,
            );
        return value.data as T;
    }
}

export class ManagementUsers {
    constructor(private readonly request: RequestResource) {}
    getUserList = (
        options: ManagementListOptions & { status?: UserStatus } = {},
    ): Promise<ManagementPage<User>> =>
        this.request("GET", "/users" + listQuery(options), undefined, options);
    async *getUserListAll(
        options: Omit<ManagementListOptions, "cursor"> & {
            status?: UserStatus;
        } = {},
    ): AsyncGenerator<User> {
        let cursor: string | undefined;
        const seen = new Set<string>();
        do {
            const page = await this.getUserList({
                ...options,
                ...(cursor ? { cursor } : {}),
            });
            for (const user of page.items) yield user;
            if (!page.hasMore) return;
            if (!page.nextCursor || seen.has(page.nextCursor))
                throw new PistiManagementError(
                    "The service returned an invalid pagination cursor.",
                    502,
                );
            cursor = page.nextCursor;
            seen.add(cursor);
        } while (true);
    }
    /** The number of users matching `search` and `status`. */
    getCount = async (
        options: Omit<ManagementListOptions, "cursor" | "limit"> & { status?: UserStatus } = {},
    ): Promise<number> =>
        (
            await this.request<{ totalCount: number }>(
                "GET",
                "/users/count" + listQuery(options),
                undefined,
                options,
            )
        ).totalCount;
    getUser = (
        id: string,
        options?: ManagementRequestOptions,
    ): Promise<User> =>
        this.request("GET", `/users/${userId(id)}`, undefined, options);
    createUser = (
        input: CreateUserInput,
        options?: ManagementRequestOptions,
    ): Promise<User> =>
        this.request("POST", "/users", input, options);
    updateUser = (
        id: string,
        input: UpdateUserInput,
        options?: ManagementRequestOptions,
    ): Promise<void> =>
        this.request("PUT", `/users/${userId(id)}`, input, options);
    private setStatus = (
        id: string,
        status: UserStatus,
        options?: ManagementRequestOptions,
    ): Promise<void> =>
        this.request("PUT", `/users/${userId(id)}/status`, { status }, options);
    /** Disables the account and ends its sessions. */
    banUser = (id: string, options?: ManagementRequestOptions): Promise<void> =>
        this.setStatus(id, "disabled", options);
    unbanUser = (id: string, options?: ManagementRequestOptions): Promise<void> =>
        this.setStatus(id, "active", options);
    lockUser = (id: string, options?: ManagementRequestOptions): Promise<void> =>
        this.setStatus(id, "locked", options);
    unlockUser = (id: string, options?: ManagementRequestOptions): Promise<void> =>
        this.setStatus(id, "active", options);
    deleteUser = (id: string, options?: ManagementRequestOptions): Promise<void> =>
        this.request("DELETE", `/users/${userId(id)}`, undefined, options);
    getUserEmailAddressList = (
        id: string,
        options?: ManagementRequestOptions,
    ): Promise<EmailAddress[]> =>
        this.request(
            "GET",
            `/users/${userId(id)}/email-addresses`,
            undefined,
            options,
        );
    addEmailAddress = (
        id: string,
        input: {
            email: string;
            status: "verified" | "unverified";
            isPrimary?: boolean;
            verificationReason?: string;
        },
        options?: ManagementRequestOptions,
    ): Promise<{ id: string }> =>
        this.request(
            "POST",
            `/users/${userId(id)}/email-addresses`,
            input,
            options,
        );
    setEmailVerification = (
        id: string,
        emailId: string,
        status: "verified" | "unverified",
        options?: ManagementRequestOptions & { verificationReason?: string },
    ): Promise<void> =>
        this.request(
            "PUT",
            `/users/${userId(id)}/email-addresses/${integerId(emailId)}`,
            {
                status,
                ...(options?.verificationReason
                    ? { verificationReason: options.verificationReason }
                    : {}),
            },
            options,
        );
    setPrimaryEmail = (
        id: string,
        emailId: string,
        options?: ManagementRequestOptions,
    ): Promise<void> =>
        this.request(
            "PUT",
            `/users/${userId(id)}/email-addresses/${integerId(emailId)}/primary`,
            undefined,
            options,
        );
    removeEmailAddress = (
        id: string,
        emailId: string,
        options?: ManagementRequestOptions,
    ): Promise<void> =>
        this.request(
            "DELETE",
            `/users/${userId(id)}/email-addresses/${integerId(emailId)}`,
            undefined,
            options,
        );
    getUserExternalAccountList = (
        id: string,
        options?: ManagementRequestOptions,
    ): Promise<DirectoryExternalAccount[]> =>
        this.request(
            "GET",
            `/users/${userId(id)}/external-accounts`,
            undefined,
            options,
        );
}

export class ManagementExternalProviders {
    constructor(private readonly request: RequestResource) {}

    list = (
        options?: ManagementRequestOptions,
    ): Promise<ManagedExternalProvider[]> =>
        this.request("GET", "/external-providers", undefined, options);

    create = (
        input: CreateExternalProviderInput,
        options?: ManagementRequestOptions,
    ): Promise<ManagedExternalProvider> =>
        this.request("POST", "/external-providers", input, options);

    update = (
        id: string,
        input: UpdateExternalProviderInput,
        options?: ManagementRequestOptions,
    ): Promise<ManagedExternalProvider> =>
        this.request(
            "PUT",
            `/external-providers/${integerId(id)}`,
            input,
            options,
        );

    delete = (id: string, options?: ManagementRequestOptions): Promise<void> =>
        this.request(
            "DELETE",
            `/external-providers/${integerId(id)}`,
            undefined,
            options,
        );
}

export class ManagementWebhooks {
    constructor(private readonly request: RequestResource) {}
    catalog = (
        options?: ManagementRequestOptions,
    ): Promise<WebhookEventType[]> =>
        this.request("GET", "/webhooks/catalog", undefined, options);
    endpoints = (
        options?: ManagementRequestOptions,
    ): Promise<ManagedWebhookEndpoint[]> =>
        this.request("GET", "/webhooks/endpoints", undefined, options);
    createEndpoint = (
        input: WebhookEndpointInput,
        options?: ManagementRequestOptions,
    ): Promise<WebhookSecretResult> =>
        this.request("POST", "/webhooks/endpoints", input, options);
    updateEndpoint = (
        id: string,
        input: UpdateWebhookEndpointInput,
        options?: ManagementRequestOptions,
    ): Promise<ManagedWebhookEndpoint> =>
        this.request(
            "PUT",
            `/webhooks/endpoints/${integerId(id)}`,
            input,
            options,
        );
    archiveEndpoint = (
        id: string,
        expectedUpdatedAt: string,
        options?: ManagementRequestOptions,
    ): Promise<void> =>
        this.request(
            "POST",
            `/webhooks/endpoints/${integerId(id)}/archive`,
            { expectedUpdatedAt },
            options,
        );
    rotateSecret = (
        id: string,
        expectedUpdatedAt: string,
        options?: ManagementRequestOptions,
    ): Promise<WebhookSecretResult> =>
        this.request(
            "POST",
            `/webhooks/endpoints/${integerId(id)}/rotate-secret`,
            { expectedUpdatedAt },
            options,
        );
    sendTest = (
        id: string,
        options?: ManagementRequestOptions,
    ): Promise<{ id: string; eventId: string }> =>
        this.request(
            "POST",
            `/webhooks/endpoints/${integerId(id)}/test`,
            undefined,
            options,
        );
    deliveries = (
        options: WebhookDeliveryListOptions = {},
    ): Promise<ManagementPage<ManagedWebhookDelivery>> => {
        const query = new URLSearchParams(
            listQuery({
                ...(options.limit === undefined
                    ? {}
                    : { limit: options.limit }),
                ...(options.cursor === undefined
                    ? {}
                    : { cursor: options.cursor }),
            }).slice(1),
        );
        if (options.endpointId !== undefined)
            query.set("endpointId", integerId(options.endpointId));
        if (options.status !== undefined) query.set("status", options.status);
        return this.request(
            "GET",
            "/webhooks/deliveries?" + query,
            undefined,
            options,
        );
    };
    delivery = (
        id: string,
        options?: ManagementRequestOptions,
    ): Promise<WebhookDeliveryDetails> =>
        this.request(
            "GET",
            `/webhooks/deliveries/${sessionId(id)}`,
            undefined,
            options,
        );
    replay = (id: string, options?: ManagementRequestOptions): Promise<void> =>
        this.request(
            "POST",
            `/webhooks/deliveries/${sessionId(id)}/replay`,
            undefined,
            options,
        );
}

export class ManagementApiKeys {
    constructor(private readonly request: RequestResource) {}
    getApiKeyList = (options: ApiKeyListOptions = {}): Promise<ManagementPage<ApiKey>> => {
        const query = new URLSearchParams();
        if (options.userId !== undefined) query.set("userId", userId(options.userId));
        if (options.includeRevoked) query.set("includeRevoked", "true");
        if (options.limit !== undefined) {
            if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100)
                throw new Error("Use a page limit between 1 and 100.");
            query.set("limit", String(options.limit));
        }
        if (options.cursor !== undefined) query.set("cursor", options.cursor);
        return this.request("GET", "/api-keys" + (query.size ? "?" + query : ""), undefined, options);
    };
    getApiKey = (id: string, options?: ManagementRequestOptions): Promise<ApiKey> =>
        this.request("GET", `/api-keys/${sessionId(id)}`, undefined, options);
    /** Sets what a key may do in your API. Only your backend grants scopes and claims; the key's owner cannot. */
    updateApiKey = (id: string, input: UpdateApiKeyInput, options?: ManagementRequestOptions): Promise<ApiKey> =>
        this.request("PUT", `/api-keys/${sessionId(id)}`, { scopes: input.scopes, claims: input.claims ?? null }, options);
    revokeApiKey = (id: string, options: ManagementRequestOptions & { revocationReason?: string } = {}): Promise<void> =>
        this.request(
            "POST",
            `/api-keys/${sessionId(id)}/revoke`,
            { revocationReason: options.revocationReason ?? null },
            options,
        );
    /** Verifies a presented `ak_` secret. Throws `PistiManagementError` (401) for unknown, expired or revoked keys. */
    verifySecret = (secret: string, options?: ManagementRequestOptions): Promise<ApiKey> =>
        this.request("POST", "/api-keys/verify", { secret }, options);
}

export class ManagementSessions {
    constructor(private readonly request: RequestResource) {}
    /** Sessions in the environment, newest first. Filter by `userId` and `status`. */
    getSessionList = (options: SessionListOptions = {}): Promise<ManagementPage<Session>> => {
        const query = new URLSearchParams();
        if (options.userId !== undefined) query.set("userId", userId(options.userId));
        if (options.status !== undefined) query.set("status", options.status);
        if (options.limit !== undefined) {
            if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100)
                throw new Error("Use a page limit between 1 and 100.");
            query.set("limit", String(options.limit));
        }
        if (options.cursor !== undefined) query.set("cursor", options.cursor);
        return this.request("GET", "/sessions" + (query.size ? "?" + query : ""), undefined, options);
    };
    getSession = (id: string, options?: ManagementRequestOptions): Promise<Session> =>
        this.request("GET", `/sessions/${sessionId(id)}`, undefined, options);
    revokeSession = (id: string, options?: ManagementRequestOptions): Promise<void> =>
        this.request(
            "DELETE",
            `/sessions/${sessionId(id)}`,
            undefined,
            options,
        );
}

export class ManagementOrganizations {
    constructor(private readonly request: RequestResource) {}
    getOrganizationList = (
        options: ManagementListOptions = {},
    ): Promise<ManagementPage<ManagedOrganization>> =>
        this.request(
            "GET",
            "/organizations" + listQuery(options),
            undefined,
            options,
        );
    getOrganization = (
        id: string,
        options?: ManagementRequestOptions,
    ): Promise<{
        organization: ManagedOrganization;
        privateMetadata: Metadata;
    }> =>
        this.request(
            "GET",
            `/organizations/${integerId(id)}`,
            undefined,
            options,
        );
    createOrganization = (
        input: CreateOrganizationInput,
        options?: ManagementRequestOptions,
    ): Promise<{ id: string }> =>
        this.request("POST", "/organizations", input, options);
    updateOrganization = (
        id: string,
        input: UpdateOrganizationInput,
        options?: ManagementRequestOptions,
    ): Promise<void> =>
        this.request("PUT", `/organizations/${integerId(id)}`, input, options);
    deleteOrganization = (id: string, options?: ManagementRequestOptions): Promise<void> =>
        this.request(
            "DELETE",
            `/organizations/${integerId(id)}`,
            undefined,
            options,
        );
    getOrganizationMembershipList = (
        id: string,
        options: ManagementListOptions = {},
    ): Promise<ManagementPage<ManagedOrganizationMember>> =>
        this.request(
            "GET",
            `/organizations/${integerId(id)}/memberships` + listQuery(options),
            undefined,
            options,
        );
    updateOrganizationMembership = (
        id: string,
        memberId: string,
        roleId: string,
        options?: ManagementRequestOptions,
    ): Promise<void> =>
        this.request(
            "PUT",
            `/organizations/${integerId(id)}/memberships/${userId(memberId)}`,
            { roleId: Number(integerId(roleId)) },
            options,
        );
    deleteOrganizationMembership = (
        id: string,
        memberId: string,
        options?: ManagementRequestOptions,
    ): Promise<void> =>
        this.request(
            "DELETE",
            `/organizations/${integerId(id)}/memberships/${userId(memberId)}`,
            undefined,
            options,
        );
    getOrganizationInvitationList = (
        id: string,
        options: ManagementListOptions = {},
    ): Promise<ManagementPage<ManagedInvitation>> =>
        this.request(
            "GET",
            `/organizations/${integerId(id)}/invitations` + listQuery(options),
            undefined,
            options,
        );
    createOrganizationInvitation = (
        id: string,
        input: { email: string; roleId: string; lifetimeDays?: number },
        options?: ManagementRequestOptions,
    ): Promise<InvitationResult> =>
        this.request(
            "POST",
            `/organizations/${integerId(id)}/invitations`,
            { ...input, roleId: Number(integerId(input.roleId)) },
            options,
        );
    reissueOrganizationInvitation = (
        id: string,
        invitationId: string,
        input: { expectedExpiresAt: string; lifetimeDays?: number },
        options?: ManagementRequestOptions,
    ): Promise<InvitationResult> =>
        this.request(
            "POST",
            `/organizations/${integerId(id)}/invitations/${integerId(invitationId)}/reissue`,
            input,
            options,
        );
    revokeOrganizationInvitation = (
        id: string,
        invitationId: string,
        options?: ManagementRequestOptions,
    ): Promise<void> =>
        this.request(
            "DELETE",
            `/organizations/${integerId(id)}/invitations/${integerId(invitationId)}`,
            undefined,
            options,
        );
    getRoleList = (
        id: string,
        options?: ManagementRequestOptions,
    ): Promise<ManagedRole[]> =>
        this.request(
            "GET",
            `/organizations/${integerId(id)}/roles`,
            undefined,
            options,
        );
    createRole = (
        id: string,
        input: RoleInput,
        options?: ManagementRequestOptions,
    ): Promise<{ id: string }> =>
        this.request(
            "POST",
            `/organizations/${integerId(id)}/roles`,
            input,
            options,
        );
    updateRole = (
        id: string,
        roleId: string,
        input: RoleInput,
        options?: ManagementRequestOptions,
    ): Promise<void> =>
        this.request(
            "PUT",
            `/organizations/${integerId(id)}/roles/${integerId(roleId)}`,
            input,
            options,
        );
    deleteRole = (
        id: string,
        roleId: string,
        options?: ManagementRequestOptions,
    ): Promise<void> =>
        this.request(
            "DELETE",
            `/organizations/${integerId(id)}/roles/${integerId(roleId)}`,
            undefined,
            options,
        );
    getPermissionList = (
        options?: ManagementRequestOptions,
    ): Promise<ManagedPermission[]> =>
        this.request("GET", "/permissions", undefined, options);
}

/**
 * Creates a backend client, like Clerk's `createClerkClient`. Without options it reads
 * `PISTI_PUBLISHABLE_KEY`, `PISTI_SECRET_KEY` and `PISTI_AUTHORIZED_PARTIES`.
 */
export function createPistiClient(options?: ManagementClientOptions): PistiClient {
    return new PistiClient(options);
}
