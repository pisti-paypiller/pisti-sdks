import { apiUrlFrom, parsePublishableKey } from "./keys.js";
import { authenticateRequest, verifyToken } from "./tokens.js";
import type { AcceptsToken, AuthenticateRequestOptions, AuthObjectFor, RequestState, SessionClaims, VerifyTokenOptions } from "./types.js";
import type {
    PistiClientOptions,
    RequestOptions,
    Instance,
    PageOptions,
    Page,
    SearchListOptions,
    UserListOptions,
    UserCountOptions,
    OrganizationListOptions,
    OrganizationCountOptions,
    User,
    EmailAddress,
    AddEmailAddressInput,
    CreateUserInput,
    UpdateUserInput,
    UserStatus,
    UserOrganization,
    ExternalAccount,
    CreateExternalAccountInput,
    DeletionPlan,
    Session,
    SessionListOptions,
    ApiKey,
    ApiKeyListOptions,
    UpdateApiKeyInput,
    Organization,
    OrganizationDetails,
    CreateOrganizationInput,
    UpdateOrganizationInput,
    OrganizationMembership,
    OrganizationInvitation,
    CreateOrganizationInvitationInput,
    ResendOrganizationInvitationInput,
    InvitationResult,
    Role,
    RoleInput,
    Permission,
    DeletionBlocker,
    ExternalProvider,
    CreateExternalProviderInput,
    UpdateExternalProviderInput,
    UpdateWebhookEndpointInput,
    WebhookEndpoint,
    HandshakeRedemption,
    WebhookEventType,
    WebhookEventListOptions,
    WebhookEventSummary,
    WebhookDeliveryListOptions,
    WebhookDelivery,
    WebhookDeliveryDetails,
} from "./client-types.js";

export type * from "./client-types.js";

/** Structured service failure. No credentials or raw requests are retained. */
export class PistiAPIResponseError extends Error {
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
        this.name = "PistiAPIResponseError";
    }
}

/** Checks the shape of a public ID (`user_…`, `org_…`); the API checks that its prefix fits. */
function publicId(value: string): string {
    if (!/^[a-z]+_[0-9A-Za-z]{11}$/.test(value))
        throw new Error("Provide a valid ID, such as user_0Hk3pQ9xZb2.");
    return value;
}

/** `limit`, `cursor` and the filters and order a list takes. Undefined values are left out. */
function listParams(
    options: PageOptions & { search?: string | undefined; orderBy?: string | undefined } = {},
    filters: Record<string, string | undefined> = {},
): URLSearchParams {
    const query = new URLSearchParams();
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
        if (options.cursor.length > 512)
            throw new Error("The pagination cursor is too long.");
        query.set("cursor", options.cursor);
    }
    if (options.orderBy !== undefined) query.set("orderBy", options.orderBy);
    if (options.search !== undefined) {
        if (options.search.length > 200)
            throw new Error("Search must be at most 200 characters.");
        query.set("search", options.search);
    }
    for (const [name, value] of Object.entries(filters))
        if (value !== undefined) query.set(name, value);
    return query;
}

/** Iterates every item of a cursor list, page by page, until `hasMore` is false. */
async function* paginate<T, O extends PageOptions>(
    load: (options: O) => Promise<Page<T>>,
    options: O,
): AsyncGenerator<T, void, undefined> {
    let cursor = options.cursor;
    const seen = new Set<string>();
    while (true) {
        const page = await load({ ...options, ...(cursor === undefined ? {} : { cursor }) });
        yield* page.items;
        if (!page.hasMore) return;
        if (!page.nextCursor || seen.has(page.nextCursor))
            throw new PistiAPIResponseError(
                "The service returned an invalid pagination cursor.",
                502,
            );
        cursor = page.nextCursor;
        seen.add(cursor);
    }
}

function queryString(query: URLSearchParams): string {
    return query.size ? "?" + query : "";
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
                throw new PistiAPIResponseError(
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
    options?: RequestOptions,
) => Promise<T>;

/** Server-side client for one environment: request authentication and the backend API. */
export class PistiClient {
    readonly #apiUrl: URL;
    readonly #secretKey: string | undefined;
    readonly #publishableKey: string | undefined;
    readonly #authorizedParties: string[] | undefined;
    readonly #timeoutMs: number;

    readonly users: UsersApi;
    readonly organizations: OrganizationsApi;
    readonly sessions: SessionsApi;
    readonly externalProviders: ExternalProvidersApi;
    readonly webhooks: WebhooksApi;
    readonly apiKeys: ApiKeysApi;

    constructor(options: PistiClientOptions = {}) {
        if (typeof window !== "undefined" && typeof document !== "undefined")
            throw new Error("The Pisti backend client belongs only in your server environment.");
        const secretKey = options.secretKey || process.env.PISTI_SECRET_KEY || undefined;
        const publishableKey = options.publishableKey || process.env.PISTI_PUBLISHABLE_KEY || undefined;
        if (secretKey === undefined && publishableKey === undefined)
            throw new Error(
                "Missing Pisti keys. Set PISTI_SECRET_KEY to call the Backend API and PISTI_PUBLISHABLE_KEY to authenticate requests (copy both from your application in the Pisti console), or pass { secretKey, publishableKey }.",
            );
        if (secretKey !== undefined && !/^sk_(?:test|live)_[a-f0-9]{16}\.[a-f0-9]{64}$/.test(secretKey))
            throw new Error("PISTI_SECRET_KEY doesn’t look like a Pisti secret key (sk_test_… or sk_live_…).");
        // The environment comes from the publishable key, or from the secret key when only the Backend API is used.
        const key = publishableKey === undefined ? undefined : parsePublishableKey(publishableKey);
        const live = key ? key.environment === "live" : secretKey!.startsWith("sk_live_");
        if (key && secretKey !== undefined && live !== secretKey.startsWith("sk_live_"))
            throw new Error("The secret key and publishable key belong to different environments.");
        const apiUrl = apiUrlFrom(options.apiUrl ?? process.env.PISTI_API_URL, !live);
        if (apiUrl.protocol === "http:" && secretKey?.startsWith("sk_live_"))
            throw new Error("Production credentials require HTTPS.");
        this.#apiUrl = apiUrl;
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
        const request: RequestResource = (method, path, body, requestOptions) =>
            this.#request(method, path, body, requestOptions);
        this.users = new UsersApi(request);
        this.organizations = new OrganizationsApi(request);
        this.sessions = new SessionsApi(request);
        this.externalProviders = new ExternalProvidersApi(request);
        this.webhooks = new WebhooksApi(request);
        this.apiKeys = new ApiKeysApi(request);
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

    /**
     * Redeems the nonce a handshake redirect brought back for the browser's session token (null when signed out) and
     * its last sign-in time. `authenticateRequest` calls this; apps don't need to.
     */
    redeemHandshake(
        nonce: string,
        origin: string,
        options: RequestOptions = {},
    ): Promise<HandshakeRedemption> {
        return this.#request("POST", "/v1/handshake/redeem", { nonce, origin }, options);
    }

    /** The environment the secret key belongs to. */
    getInstance(options: RequestOptions = {}): Promise<Instance> {
        return this.#request<Instance>("GET", "/v1/instance", undefined, options);
    }

    #requireSecretKey(): string {
        if (!this.#secretKey)
            throw new Error(
                "Missing Pisti secret key. Create one under API keys in the Pisti console and set PISTI_SECRET_KEY, or pass { secretKey }.",
            );
        return this.#secretKey;
    }

    async #request<T>(
        method: string,
        path: string,
        body?: unknown,
        options: RequestOptions = {},
    ): Promise<T> {
        const serialized =
            body === undefined ? undefined : JSON.stringify(body);
        if (serialized && Buffer.byteLength(serialized) > 65_536)
            throw new Error("The backend API request exceeds 64 KiB.");
        const secretKey = this.#requireSecretKey();
        let response: Response;
        let payload: unknown;
        const timeout = AbortSignal.timeout(this.#timeoutMs);
        try {
            response = await fetch(
                new URL(path.slice(1), this.#apiUrl),
                {
                    method,
                    headers: {
                        Authorization: "Bearer " + secretKey,
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
            if (error instanceof PistiAPIResponseError) throw error;
            throw new PistiAPIResponseError(
                options.signal?.aborted
                    ? "The backend API request was canceled."
                    : "The Pisti backend API could not be reached. Try again shortly.",
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
            throw new PistiAPIResponseError(
                typeof value?.detail === "string"
                    ? value.detail
                    : typeof value?.title === "string"
                      ? value.title
                      : "The backend API request failed.",
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
            throw new PistiAPIResponseError(
                "The Pisti backend API returned an invalid response.",
                502,
                requestId,
            );
        return value.data as T;
    }
}


export class UsersApi {
    constructor(private readonly request: RequestResource) {}
    /** One page of users, newest first unless `orderBy` says otherwise. */
    getUserList = (options: UserListOptions = {}): Promise<Page<User>> =>
        this.request(
            "GET",
            "/v1/users" + queryString(listParams(options, { status: options.status })),
            undefined,
            options,
        );
    /** Every user matching the filters: `for await (const user of pisti.users.list())`. */
    list = (options: UserListOptions = {}): AsyncGenerator<User, void, undefined> =>
        paginate(this.getUserList, options);
    /** The number of users matching `search` and `status`. */
    getCount = async (options: UserCountOptions = {}): Promise<number> =>
        (
            await this.request<{ totalCount: number }>(
                "GET",
                "/v1/users/count" + queryString(listParams({ ...(options.search === undefined ? {} : { search: options.search }) }, { status: options.status })),
                undefined,
                options,
            )
        ).totalCount;
    getUser = (id: string, options?: RequestOptions): Promise<User> =>
        this.request("GET", `/v1/users/${publicId(id)}`, undefined, options);
    createUser = (input: CreateUserInput, options?: RequestOptions): Promise<User> =>
        this.request("POST", "/v1/users", input, options);
    updateUser = (
        id: string,
        input: UpdateUserInput,
        options?: RequestOptions,
    ): Promise<void> =>
        this.request("PUT", `/v1/users/${publicId(id)}`, input, options);
    /** Sets, changes or (with null) removes the user's username. */
    updateUsername = (
        id: string,
        username: string | null,
        options?: RequestOptions,
    ): Promise<void> =>
        this.request("PUT", `/v1/users/${publicId(id)}/username`, { username }, options);
    private setStatus = (
        id: string,
        status: UserStatus,
        options?: RequestOptions,
    ): Promise<void> =>
        this.request("PUT", `/v1/users/${publicId(id)}/status`, { status }, options);
    /** Disables the account and ends its sessions. */
    banUser = (id: string, options?: RequestOptions): Promise<void> =>
        this.setStatus(id, "disabled", options);
    unbanUser = (id: string, options?: RequestOptions): Promise<void> =>
        this.setStatus(id, "active", options);
    lockUser = (id: string, options?: RequestOptions): Promise<void> =>
        this.setStatus(id, "locked", options);
    unlockUser = (id: string, options?: RequestOptions): Promise<void> =>
        this.setStatus(id, "active", options);
    /** What has to happen before the user can be deleted. */
    getUserDeletionPlan = (id: string, options?: RequestOptions): Promise<DeletionPlan> =>
        this.request("GET", `/v1/users/${publicId(id)}/deletion`, undefined, options);
    deleteUser = (id: string, options?: RequestOptions): Promise<void> =>
        this.request("DELETE", `/v1/users/${publicId(id)}`, undefined, options);
    /** The organizations the user belongs to. */
    getUserOrganizationList = (
        id: string,
        options: PageOptions = {},
    ): Promise<Page<UserOrganization>> =>
        this.request(
            "GET",
            `/v1/users/${publicId(id)}/organizations` + queryString(listParams(options)),
            undefined,
            options,
        );
    listOrganizations = (
        id: string,
        options: PageOptions = {},
    ): AsyncGenerator<UserOrganization, void, undefined> => {
        publicId(id);
        return paginate((page) => this.getUserOrganizationList(id, page), options);
    };
    /** The user's email addresses, whole, in one page. */
    getUserEmailAddressList = (
        id: string,
        options?: RequestOptions,
    ): Promise<Page<EmailAddress>> =>
        this.request("GET", `/v1/users/${publicId(id)}/email-addresses`, undefined, options);
    addEmailAddress = (
        id: string,
        input: AddEmailAddressInput,
        options?: RequestOptions,
    ): Promise<{ id: string }> =>
        this.request("POST", `/v1/users/${publicId(id)}/email-addresses`, input, options);
    setEmailVerification = (
        id: string,
        emailId: string,
        status: "verified" | "unverified",
        options?: RequestOptions & { verificationReason?: string },
    ): Promise<void> =>
        this.request(
            "PUT",
            `/v1/users/${publicId(id)}/email-addresses/${publicId(emailId)}`,
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
        options?: RequestOptions,
    ): Promise<void> =>
        this.request(
            "PUT",
            `/v1/users/${publicId(id)}/email-addresses/${publicId(emailId)}/primary`,
            undefined,
            options,
        );
    removeEmailAddress = (
        id: string,
        emailId: string,
        options?: RequestOptions,
    ): Promise<void> =>
        this.request(
            "DELETE",
            `/v1/users/${publicId(id)}/email-addresses/${publicId(emailId)}`,
            undefined,
            options,
        );
    /** The user's linked external accounts, whole, in one page. */
    getUserExternalAccountList = (
        id: string,
        options?: RequestOptions,
    ): Promise<Page<ExternalAccount>> =>
        this.request("GET", `/v1/users/${publicId(id)}/external-accounts`, undefined, options);
    /** Links an account at an upstream provider to the user. */
    createUserExternalAccount = (
        id: string,
        input: CreateExternalAccountInput,
        options?: RequestOptions,
    ): Promise<{ id: string }> =>
        this.request("POST", `/v1/users/${publicId(id)}/external-accounts`, input, options);
    deleteUserExternalAccount = (
        id: string,
        externalAccountId: string,
        options?: RequestOptions,
    ): Promise<void> =>
        this.request(
            "DELETE",
            `/v1/users/${publicId(id)}/external-accounts/${publicId(externalAccountId)}`,
            undefined,
            options,
        );
}

export class ExternalProvidersApi {
    constructor(private readonly request: RequestResource) {}
    /** The environment's upstream providers, whole, in one page. */
    getExternalProviderList = (options?: RequestOptions): Promise<Page<ExternalProvider>> =>
        this.request("GET", "/v1/external_providers", undefined, options);
    create = (
        input: CreateExternalProviderInput,
        options?: RequestOptions,
    ): Promise<ExternalProvider> =>
        this.request("POST", "/v1/external_providers", input, options);
    update = (
        id: string,
        input: UpdateExternalProviderInput,
        options?: RequestOptions,
    ): Promise<ExternalProvider> =>
        this.request("PUT", `/v1/external_providers/${publicId(id)}`, input, options);
    delete = (id: string, options?: RequestOptions): Promise<void> =>
        this.request("DELETE", `/v1/external_providers/${publicId(id)}`, undefined, options);
}

export class WebhooksApi {
    constructor(private readonly request: RequestResource) {}
    /** Every event type an endpoint can subscribe to, in one page. */
    catalog = (options?: RequestOptions): Promise<Page<WebhookEventType>> =>
        this.request("GET", "/v1/webhooks/catalog", undefined, options);
    /** The environment's endpoints, whole, in one page. */
    endpoints = (options?: RequestOptions): Promise<Page<WebhookEndpoint>> =>
        this.request("GET", "/v1/webhooks/endpoints", undefined, options);
    updateEndpoint = (
        id: string,
        input: UpdateWebhookEndpointInput,
        options?: RequestOptions,
    ): Promise<WebhookEndpoint> =>
        this.request("PUT", `/v1/webhooks/endpoints/${publicId(id)}`, input, options);
    archiveEndpoint = (
        id: string,
        expectedUpdatedAt: string,
        options?: RequestOptions,
    ): Promise<void> =>
        this.request(
            "POST",
            `/v1/webhooks/endpoints/${publicId(id)}/archive`,
            { expectedUpdatedAt },
            options,
        );
    sendTest = (
        id: string,
        options?: RequestOptions,
    ): Promise<{ id: string; eventId: string }> =>
        this.request("POST", `/v1/webhooks/endpoints/${publicId(id)}/test`, undefined, options);
    /** Queues every event since `since` (an ISO timestamp) again for one endpoint; returns how many were queued. */
    replayEndpoint = (
        id: string,
        since: string,
        options?: RequestOptions,
    ): Promise<{ queued: number }> =>
        this.request(
            "POST",
            `/v1/webhooks/endpoints/${publicId(id)}/replay`,
            { since },
            options,
        );
    /** Events the environment produced, newest first. */
    events = (options: WebhookEventListOptions = {}): Promise<Page<WebhookEventSummary>> => {
        const query = listParams(options, { type: options.type });
        return this.request("GET", "/v1/webhooks/events" + queryString(query), undefined, options);
    };
    listEvents = (options: WebhookEventListOptions = {}): AsyncGenerator<WebhookEventSummary, void, undefined> =>
        paginate(this.events, options);
    deliveries = (
        options: WebhookDeliveryListOptions = {},
    ): Promise<Page<WebhookDelivery>> => {
        const query = listParams(options, {
            endpointId: options.endpointId === undefined ? undefined : publicId(options.endpointId),
            status: options.status,
        });
        return this.request("GET", "/v1/webhooks/deliveries" + queryString(query), undefined, options);
    };
    listDeliveries = (options: WebhookDeliveryListOptions = {}): AsyncGenerator<WebhookDelivery, void, undefined> =>
        paginate(this.deliveries, options);
    delivery = (
        id: string,
        options?: RequestOptions,
    ): Promise<WebhookDeliveryDetails> =>
        this.request("GET", `/v1/webhooks/deliveries/${publicId(id)}`, undefined, options);
    /** Sends one delivery again. */
    replay = (id: string, options?: RequestOptions): Promise<void> =>
        this.request("POST", `/v1/webhooks/deliveries/${publicId(id)}/replay`, undefined, options);
}

export class ApiKeysApi {
    constructor(private readonly request: RequestResource) {}
    getApiKeyList = (options: ApiKeyListOptions = {}): Promise<Page<ApiKey>> => {
        const query = listParams(options, {
            userId: options.userId === undefined ? undefined : publicId(options.userId),
            includeRevoked: options.includeRevoked ? "true" : undefined,
        });
        return this.request("GET", "/v1/api_keys" + queryString(query), undefined, options);
    };
    list = (options: ApiKeyListOptions = {}): AsyncGenerator<ApiKey, void, undefined> =>
        paginate(this.getApiKeyList, options);
    getApiKey = (id: string, options?: RequestOptions): Promise<ApiKey> =>
        this.request("GET", `/v1/api_keys/${publicId(id)}`, undefined, options);
    /** Sets what a key may do in your API. Only your backend grants scopes and claims; the key's owner cannot. */
    updateApiKey = (id: string, input: UpdateApiKeyInput, options?: RequestOptions): Promise<ApiKey> =>
        this.request("PUT", `/v1/api_keys/${publicId(id)}`, { scopes: input.scopes, claims: input.claims ?? null }, options);
    revokeApiKey = (id: string, options: RequestOptions & { revocationReason?: string } = {}): Promise<void> =>
        this.request(
            "POST",
            `/v1/api_keys/${publicId(id)}/revoke`,
            { revocationReason: options.revocationReason ?? null },
            options,
        );
    /** Verifies a presented `ak_` secret. Throws `PistiAPIResponseError` (401) for unknown, expired or revoked keys. */
    verifySecret = (secret: string, options?: RequestOptions): Promise<ApiKey> =>
        this.request("POST", "/v1/api_keys/verify", { secret }, options);
}

export class SessionsApi {
    constructor(private readonly request: RequestResource) {}
    /** Sessions in the environment, newest first. Filter by `userId` and `status`. */
    getSessionList = (options: SessionListOptions = {}): Promise<Page<Session>> => {
        const query = listParams(options, {
            userId: options.userId === undefined ? undefined : publicId(options.userId),
            status: options.status,
        });
        return this.request("GET", "/v1/sessions" + queryString(query), undefined, options);
    };
    list = (options: SessionListOptions = {}): AsyncGenerator<Session, void, undefined> =>
        paginate(this.getSessionList, options);
    getSession = (id: string, options?: RequestOptions): Promise<Session> =>
        this.request("GET", `/v1/sessions/${publicId(id)}`, undefined, options);
    revokeSession = (id: string, options?: RequestOptions): Promise<void> =>
        this.request("DELETE", `/v1/sessions/${publicId(id)}`, undefined, options);
}

export class OrganizationsApi {
    constructor(private readonly request: RequestResource) {}
    /** One page of organizations, newest first unless `orderBy` says otherwise. */
    getOrganizationList = (options: OrganizationListOptions = {}): Promise<Page<Organization>> =>
        this.request("GET", "/v1/organizations" + queryString(listParams(options)), undefined, options);
    list = (options: OrganizationListOptions = {}): AsyncGenerator<Organization, void, undefined> =>
        paginate(this.getOrganizationList, options);
    /** The number of organizations matching `search`. */
    getCount = async (options: OrganizationCountOptions = {}): Promise<number> =>
        (
            await this.request<{ totalCount: number }>(
                "GET",
                "/v1/organizations/count" + queryString(listParams(options.search === undefined ? {} : { search: options.search })),
                undefined,
                options,
            )
        ).totalCount;
    getOrganization = (id: string, options?: RequestOptions): Promise<OrganizationDetails> =>
        this.request("GET", `/v1/organizations/${publicId(id)}`, undefined, options);
    createOrganization = (
        input: CreateOrganizationInput,
        options?: RequestOptions,
    ): Promise<{ id: string }> =>
        this.request("POST", "/v1/organizations", input, options);
    updateOrganization = (
        id: string,
        input: UpdateOrganizationInput,
        options?: RequestOptions,
    ): Promise<void> =>
        this.request("PUT", `/v1/organizations/${publicId(id)}`, input, options);
    /** What has to happen before the organization can be deleted. */
    getOrganizationDeletionPlan = (id: string, options?: RequestOptions): Promise<DeletionPlan> =>
        this.request("GET", `/v1/organizations/${publicId(id)}/deletion`, undefined, options);
    deleteOrganization = (id: string, options?: RequestOptions): Promise<void> =>
        this.request("DELETE", `/v1/organizations/${publicId(id)}`, undefined, options);
    getOrganizationMembershipList = (
        id: string,
        options: SearchListOptions = {},
    ): Promise<Page<OrganizationMembership>> =>
        this.request(
            "GET",
            `/v1/organizations/${publicId(id)}/memberships` + queryString(listParams(options)),
            undefined,
            options,
        );
    listMemberships = (
        id: string,
        options: SearchListOptions = {},
    ): AsyncGenerator<OrganizationMembership, void, undefined> => {
        publicId(id);
        return paginate((page) => this.getOrganizationMembershipList(id, page), options);
    };
    /** Changes a member's role. */
    updateOrganizationMembership = (
        id: string,
        userId: string,
        roleId: string,
        options?: RequestOptions,
    ): Promise<void> =>
        this.request(
            "PUT",
            `/v1/organizations/${publicId(id)}/memberships/${publicId(userId)}`,
            { roleId: publicId(roleId) },
            options,
        );
    deleteOrganizationMembership = (
        id: string,
        userId: string,
        options?: RequestOptions,
    ): Promise<void> =>
        this.request(
            "DELETE",
            `/v1/organizations/${publicId(id)}/memberships/${publicId(userId)}`,
            undefined,
            options,
        );
    getOrganizationInvitationList = (
        id: string,
        options: SearchListOptions = {},
    ): Promise<Page<OrganizationInvitation>> =>
        this.request(
            "GET",
            `/v1/organizations/${publicId(id)}/invitations` + queryString(listParams(options)),
            undefined,
            options,
        );
    listInvitations = (
        id: string,
        options: SearchListOptions = {},
    ): AsyncGenerator<OrganizationInvitation, void, undefined> => {
        publicId(id);
        return paginate((page) => this.getOrganizationInvitationList(id, page), options);
    };
    createOrganizationInvitation = (
        id: string,
        input: CreateOrganizationInvitationInput,
        options?: RequestOptions,
    ): Promise<InvitationResult> =>
        this.request(
            "POST",
            `/v1/organizations/${publicId(id)}/invitations`,
            { ...input, roleId: publicId(input.roleId) },
            options,
        );
    resendOrganizationInvitation = (
        id: string,
        invitationId: string,
        input: ResendOrganizationInvitationInput,
        options?: RequestOptions,
    ): Promise<InvitationResult> =>
        this.request(
            "POST",
            `/v1/organizations/${publicId(id)}/invitations/${publicId(invitationId)}/resend`,
            input,
            options,
        );
    revokeOrganizationInvitation = (
        id: string,
        invitationId: string,
        options?: RequestOptions,
    ): Promise<void> =>
        this.request(
            "DELETE",
            `/v1/organizations/${publicId(id)}/invitations/${publicId(invitationId)}`,
            undefined,
            options,
        );
    getRoleList = (id: string, options?: RequestOptions): Promise<Role[]> =>
        this.request("GET", `/v1/organizations/${publicId(id)}/roles`, undefined, options);
    createRole = (
        id: string,
        input: RoleInput,
        options?: RequestOptions,
    ): Promise<{ id: string }> =>
        this.request("POST", `/v1/organizations/${publicId(id)}/roles`, input, options);
    updateRole = (
        id: string,
        roleId: string,
        input: RoleInput,
        options?: RequestOptions,
    ): Promise<void> =>
        this.request(
            "PUT",
            `/v1/organizations/${publicId(id)}/roles/${publicId(roleId)}`,
            input,
            options,
        );
    deleteRole = (
        id: string,
        roleId: string,
        options?: RequestOptions,
    ): Promise<void> =>
        this.request(
            "DELETE",
            `/v1/organizations/${publicId(id)}/roles/${publicId(roleId)}`,
            undefined,
            options,
        );
    /** Every permission, whole, in one page. */
    getPermissionList = (options?: RequestOptions): Promise<Page<Permission>> =>
        this.request("GET", "/v1/permissions", undefined, options);
}

/**
 * Creates a backend client, like Clerk's `createClerkClient`. Without options it reads
 * `PISTI_PUBLISHABLE_KEY`, `PISTI_SECRET_KEY` and `PISTI_AUTHORIZED_PARTIES`.
 */
export function createPistiClient(options?: PistiClientOptions): PistiClient {
    return new PistiClient(options);
}
