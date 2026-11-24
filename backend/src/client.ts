import { apiUrlFrom, parsePublishableKey } from "./keys.js";
import { authenticateRequest, verifyToken } from "./tokens.js";
import type { AcceptsToken, AuthenticateRequestOptions, AuthObjectFor, RequestState, SessionClaims, VerifyTokenOptions } from "./types.js";
import type { paths } from "./generated/backend.js";
import type {
    PistiClientOptions,
    RequestOptions,
    MutationOptions,
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
    WebhookCatalogEntry,
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

/** The validated `limit` and `cursor` of one page. */
function page(options: PageOptions): { limit: number | undefined; cursor: string | undefined } {
    if (options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 100))
        throw new Error("Use a page limit between 1 and 100.");
    if (options.cursor !== undefined && options.cursor.length > 512)
        throw new Error("The pagination cursor is too long.");
    return { limit: options.limit, cursor: options.cursor };
}

function search(value: string | undefined): string | undefined {
    if (value !== undefined && value.length > 200) throw new Error("Search must be at most 200 characters.");
    return value;
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

type Method = "get" | "put" | "post" | "delete";
/** The paths that accept `M`. */
type PathsWith<M extends Method> = {
    [P in keyof paths]: [NonNullable<paths[P][M]>] extends [never] ? never : P;
}[keyof paths];
type Operation<M extends Method, P extends keyof paths> = NonNullable<paths[P][M]>;
type Json<T> = [T] extends [{ content: { "application/json": infer B } }] ? B : never;
type Present<T> = [NonNullable<T>] extends [never] ? never : NonNullable<T>;
type PathParams<O> = O extends { parameters: { path?: infer V } } ? Present<V> : never;
type QueryParams<O> = O extends { parameters: { query?: infer V } } ? Present<V> : never;
type Body<O> = O extends { requestBody?: infer R } ? ([Present<R>] extends [never] ? never : Json<Present<R>>) : never;
/** The `data` of a 200 response, or nothing for a response without a body. */
type ResponseData<O> = O extends { responses: infer R }
    ? 200 extends keyof R
        ? [Json<R[200]>] extends [never]
            ? void
            : [Json<R[200]>] extends [{ data: infer D }] ? D : void
        : void
    : never;
/** The path parameters, query and JSON body one operation takes, each checked against the contract. */
type RequestInit<O> = ([PathParams<O>] extends [never] ? { path?: never } : { path: PathParams<O> }) &
    ([QueryParams<O>] extends [never]
        ? { query?: never }
        : { query?: { [K in keyof QueryParams<O>]?: QueryParams<O>[K] | undefined } }) &
    ([Body<O>] extends [never] ? { body?: never } : { body: Body<O> });

type RequestResource = <M extends Method, P extends PathsWith<M>>(
    method: M,
    path: P,
    init: RequestInit<Operation<M, P>>,
    options?: M extends "get" ? RequestOptions : MutationOptions,
) => Promise<ResponseData<Operation<M, P>>>;

/** Fills a path template's `{name}` parameters and appends the query, leaving out undefined values. */
function resolvePath(
    template: string,
    path: Record<string, string> = {},
    query: Record<string, string | number | boolean | undefined> = {},
): string {
    const resolved = template.replace(/\{(\w+)\}/g, (_, name: string) => {
        const value = path[name];
        if (value === undefined) throw new Error(`Missing path parameter ${name}.`);
        return encodeURIComponent(value);
    });
    const search = new URLSearchParams();
    for (const [name, value] of Object.entries(query))
        if (value !== undefined) search.set(name, String(value));
    return search.size ? resolved + "?" + search : resolved;
}

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
    readonly #api: RequestResource;

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
        const request: RequestResource = (method, path, init, requestOptions) =>
            this.#request(
                method.toUpperCase(),
                resolvePath(path, init.path, init.query as Record<string, string | number | boolean | undefined>),
                init.body,
                requestOptions,
            ) as never;
        this.#api = request;
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
        return this.#api("post", "/v1/handshake/redeem", { body: { nonce, origin } }, options);
    }

    /** The environment the secret key belongs to. */
    getInstance(options: RequestOptions = {}): Promise<Instance> {
        return this.#api("get", "/v1/instance", {}, options);
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
        options: MutationOptions = {},
    ): Promise<T> {
        const serialized =
            body === undefined ? undefined : JSON.stringify(body);
        if (serialized && Buffer.byteLength(serialized) > 65_536)
            throw new Error("The backend API request exceeds 64 KiB.");
        const { idempotencyKey } = options;
        if (idempotencyKey !== undefined && !/^[ -~]{1,255}$/.test(idempotencyKey))
            throw new Error("Use an idempotency key of 1 to 255 printable ASCII characters.");
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
                        ...(idempotencyKey === undefined
                            ? {}
                            : { "Idempotency-Key": idempotencyKey }),
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
                          typeof blocker.code === "string" &&
                          typeof blocker.count === "number" &&
                          typeof blocker.message === "string"
                          ? [
                                {
                                    code: blocker.code,
                                    count: blocker.count,
                                    message: blocker.message,
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
            "get",
            "/v1/users",
            { query: { ...page(options), orderBy: options.orderBy, search: search(options.search), status: options.status } },
            options,
        );
    /** Every user matching the filters: `for await (const user of pisti.users.list())`. */
    list = (options: UserListOptions = {}): AsyncGenerator<User, void, undefined> =>
        paginate(this.getUserList, options);
    /** The number of users matching `search` and `status`. */
    getCount = async (options: UserCountOptions = {}): Promise<number> =>
        (
            await this.request(
                "get",
                "/v1/users/count",
                { query: { search: search(options.search), status: options.status } },
                options,
            )
        ).totalCount;
    getUser = (id: string, options?: RequestOptions): Promise<User> =>
        this.request("get", "/v1/users/{userId}", { path: { userId: publicId(id) } }, options);
    createUser = (input: CreateUserInput, options?: MutationOptions): Promise<User> =>
        this.request("post", "/v1/users", { body: input }, options);
    updateUser = (id: string, input: UpdateUserInput, options?: MutationOptions): Promise<void> =>
        this.request("put", "/v1/users/{userId}", { path: { userId: publicId(id) }, body: input }, options);
    /** Sets, changes or (with null) removes the user's username. */
    updateUsername = (id: string, username: string | null, options?: MutationOptions): Promise<void> =>
        this.request("put", "/v1/users/{userId}/username", { path: { userId: publicId(id) }, body: { username } }, options);
    private setStatus = (id: string, status: UserStatus, options?: MutationOptions): Promise<void> =>
        this.request("put", "/v1/users/{userId}/status", { path: { userId: publicId(id) }, body: { status } }, options);
    /** Disables the account and ends its sessions. */
    banUser = (id: string, options?: MutationOptions): Promise<void> =>
        this.setStatus(id, "disabled", options);
    unbanUser = (id: string, options?: MutationOptions): Promise<void> =>
        this.setStatus(id, "active", options);
    lockUser = (id: string, options?: MutationOptions): Promise<void> =>
        this.setStatus(id, "locked", options);
    unlockUser = (id: string, options?: MutationOptions): Promise<void> =>
        this.setStatus(id, "active", options);
    /** Deletes the user. Throws `PistiAPIResponseError` (409) with `blockers` while something stops it. */
    deleteUser = (id: string, options?: MutationOptions): Promise<void> =>
        this.request("delete", "/v1/users/{userId}", { path: { userId: publicId(id) } }, options);
    /** The organizations the user belongs to. */
    getUserOrganizationList = (id: string, options: PageOptions = {}): Promise<Page<UserOrganization>> =>
        this.request(
            "get",
            "/v1/users/{userId}/organizations",
            { path: { userId: publicId(id) }, query: page(options) },
            options,
        );
    listOrganizations = (id: string, options: PageOptions = {}): AsyncGenerator<UserOrganization, void, undefined> => {
        publicId(id);
        return paginate((page) => this.getUserOrganizationList(id, page), options);
    };
    /** The user's email addresses, whole, in one page. */
    getUserEmailAddressList = (id: string, options?: RequestOptions): Promise<Page<EmailAddress>> =>
        this.request("get", "/v1/users/{userId}/email-addresses", { path: { userId: publicId(id) } }, options);
    addEmailAddress = (id: string, input: AddEmailAddressInput, options?: MutationOptions): Promise<{ id: string }> =>
        this.request("post", "/v1/users/{userId}/email-addresses", { path: { userId: publicId(id) }, body: input }, options);
    setEmailVerification = (
        id: string,
        emailId: string,
        status: "verified" | "unverified",
        options?: MutationOptions & { verificationReason?: string },
    ): Promise<void> =>
        this.request(
            "put",
            "/v1/users/{userId}/email-addresses/{emailId}",
            {
                path: { userId: publicId(id), emailId: publicId(emailId) },
                body: {
                    status,
                    ...(options?.verificationReason ? { verificationReason: options.verificationReason } : {}),
                },
            },
            options,
        );
    setPrimaryEmail = (id: string, emailId: string, options?: MutationOptions): Promise<void> =>
        this.request(
            "put",
            "/v1/users/{userId}/email-addresses/{emailId}/primary",
            { path: { userId: publicId(id), emailId: publicId(emailId) } },
            options,
        );
    removeEmailAddress = (id: string, emailId: string, options?: MutationOptions): Promise<void> =>
        this.request(
            "delete",
            "/v1/users/{userId}/email-addresses/{emailId}",
            { path: { userId: publicId(id), emailId: publicId(emailId) } },
            options,
        );
    /** The user's linked external accounts, whole, in one page. */
    getUserExternalAccountList = (id: string, options?: RequestOptions): Promise<Page<ExternalAccount>> =>
        this.request("get", "/v1/users/{userId}/external-accounts", { path: { userId: publicId(id) } }, options);
    /** Links an account at an upstream provider to the user. */
    createUserExternalAccount = (
        id: string,
        input: CreateExternalAccountInput,
        options?: MutationOptions,
    ): Promise<{ id: string }> =>
        this.request("post", "/v1/users/{userId}/external-accounts", { path: { userId: publicId(id) }, body: input }, options);
    deleteUserExternalAccount = (id: string, externalAccountId: string, options?: MutationOptions): Promise<void> =>
        this.request(
            "delete",
            "/v1/users/{userId}/external-accounts/{externalId}",
            { path: { userId: publicId(id), externalId: publicId(externalAccountId) } },
            options,
        );
}

export class ExternalProvidersApi {
    constructor(private readonly request: RequestResource) {}
    /** The environment's upstream providers, whole, in one page. */
    getExternalProviderList = (options?: RequestOptions): Promise<Page<ExternalProvider>> =>
        this.request("get", "/v1/external_providers", {}, options);
    create = (input: CreateExternalProviderInput, options?: MutationOptions): Promise<ExternalProvider> =>
        this.request("post", "/v1/external_providers", { body: input }, options);
    update = (id: string, input: UpdateExternalProviderInput, options?: MutationOptions): Promise<ExternalProvider> =>
        this.request("put", "/v1/external_providers/{providerId}", { path: { providerId: publicId(id) }, body: input }, options);
    delete = (id: string, options?: MutationOptions): Promise<void> =>
        this.request("delete", "/v1/external_providers/{providerId}", { path: { providerId: publicId(id) } }, options);
}

export class WebhooksApi {
    constructor(private readonly request: RequestResource) {}
    /** Every event type an endpoint can subscribe to, in one page. */
    catalog = (options?: RequestOptions): Promise<Page<WebhookCatalogEntry>> =>
        this.request("get", "/v1/webhooks/catalog", {}, options);
    /** The environment's endpoints, whole, in one page. */
    endpoints = (options?: RequestOptions): Promise<Page<WebhookEndpoint>> =>
        this.request("get", "/v1/webhooks/endpoints", {}, options);
    /** Replaces an endpoint's settings. Pass `expectedUpdatedAt` to fail if it changed since you read it. */
    updateEndpoint = (id: string, input: UpdateWebhookEndpointInput, options?: MutationOptions): Promise<WebhookEndpoint> =>
        this.request("put", "/v1/webhooks/endpoints/{endpointId}", { path: { endpointId: publicId(id) }, body: input }, options);
    archiveEndpoint = (id: string, options?: MutationOptions): Promise<void> =>
        this.request("post", "/v1/webhooks/endpoints/{endpointId}/archive", { path: { endpointId: publicId(id) } }, options);
    sendTest = (id: string, options?: MutationOptions): Promise<{ id: string; eventId: string }> =>
        this.request("post", "/v1/webhooks/endpoints/{endpointId}/test", { path: { endpointId: publicId(id) } }, options);
    /** Queues every event since `since` (an ISO timestamp) again for one endpoint; returns how many were queued. */
    replayEndpoint = (id: string, since: string, options?: MutationOptions): Promise<{ queued: number }> =>
        this.request(
            "post",
            "/v1/webhooks/endpoints/{endpointId}/replay",
            { path: { endpointId: publicId(id) }, body: { since } },
            options,
        );
    /** Events the environment produced, newest first. */
    events = (options: WebhookEventListOptions = {}): Promise<Page<WebhookEventSummary>> =>
        this.request("get", "/v1/webhooks/events", { query: { ...page(options), type: options.type } }, options);
    listEvents = (options: WebhookEventListOptions = {}): AsyncGenerator<WebhookEventSummary, void, undefined> =>
        paginate(this.events, options);
    deliveries = (options: WebhookDeliveryListOptions = {}): Promise<Page<WebhookDelivery>> =>
        this.request(
            "get",
            "/v1/webhooks/deliveries",
            {
                query: {
                    ...page(options),
                    endpointId: options.endpointId === undefined ? undefined : publicId(options.endpointId),
                    status: options.status,
                },
            },
            options,
        );
    listDeliveries = (options: WebhookDeliveryListOptions = {}): AsyncGenerator<WebhookDelivery, void, undefined> =>
        paginate(this.deliveries, options);
    delivery = async (id: string, options?: RequestOptions): Promise<WebhookDeliveryDetails> =>
        (await this.request(
            "get",
            "/v1/webhooks/deliveries/{deliveryId}",
            { path: { deliveryId: publicId(id) } },
            options,
        )) as WebhookDeliveryDetails;
    /** Sends one delivery again. */
    replay = (id: string, options?: MutationOptions): Promise<void> =>
        this.request("post", "/v1/webhooks/deliveries/{deliveryId}/replay", { path: { deliveryId: publicId(id) } }, options);
}

export class ApiKeysApi {
    constructor(private readonly request: RequestResource) {}
    getApiKeyList = (options: ApiKeyListOptions = {}): Promise<Page<ApiKey>> =>
        this.request(
            "get",
            "/v1/api_keys",
            {
                query: {
                    ...page(options),
                    userId: options.userId === undefined ? undefined : publicId(options.userId),
                    includeRevoked: options.includeRevoked ? true : undefined,
                },
            },
            options,
        );
    list = (options: ApiKeyListOptions = {}): AsyncGenerator<ApiKey, void, undefined> =>
        paginate(this.getApiKeyList, options);
    getApiKey = (id: string, options?: RequestOptions): Promise<ApiKey> =>
        this.request("get", "/v1/api_keys/{keyId}", { path: { keyId: publicId(id) } }, options);
    /** Sets what a key may do in your API. Only your backend grants scopes and claims; the key's owner cannot. */
    updateApiKey = (id: string, input: UpdateApiKeyInput, options?: MutationOptions): Promise<ApiKey> =>
        this.request(
            "put",
            "/v1/api_keys/{keyId}",
            { path: { keyId: publicId(id) }, body: { scopes: input.scopes, claims: input.claims ?? null } },
            options,
        );
    revokeApiKey = (id: string, options: MutationOptions & { revocationReason?: string } = {}): Promise<void> =>
        this.request(
            "post",
            "/v1/api_keys/{keyId}/revoke",
            { path: { keyId: publicId(id) }, body: { revocationReason: options.revocationReason ?? null } },
            options,
        );
    /** Verifies a presented `ak_` secret. Throws `PistiAPIResponseError` (401) for unknown, expired or revoked keys. */
    verifySecret = (secret: string, options?: RequestOptions): Promise<ApiKey> =>
        this.request("post", "/v1/api_keys/verify", { body: { secret } }, options);
}

export class SessionsApi {
    constructor(private readonly request: RequestResource) {}
    /** Sessions in the environment, newest first. Filter by `userId` and `status`. */
    getSessionList = (options: SessionListOptions = {}): Promise<Page<Session>> =>
        this.request(
            "get",
            "/v1/sessions",
            {
                query: {
                    ...page(options),
                    userId: options.userId === undefined ? undefined : publicId(options.userId),
                    status: options.status,
                },
            },
            options,
        );
    list = (options: SessionListOptions = {}): AsyncGenerator<Session, void, undefined> =>
        paginate(this.getSessionList, options);
    getSession = (id: string, options?: RequestOptions): Promise<Session> =>
        this.request("get", "/v1/sessions/{sessionId}", { path: { sessionId: publicId(id) } }, options);
    revokeSession = (id: string, options?: MutationOptions): Promise<void> =>
        this.request("delete", "/v1/sessions/{sessionId}", { path: { sessionId: publicId(id) } }, options);
}

export class OrganizationsApi {
    constructor(private readonly request: RequestResource) {}
    /** One page of organizations, newest first unless `orderBy` says otherwise. */
    getOrganizationList = (options: OrganizationListOptions = {}): Promise<Page<Organization>> =>
        this.request(
            "get",
            "/v1/organizations",
            { query: { ...page(options), orderBy: options.orderBy, search: search(options.search) } },
            options,
        );
    list = (options: OrganizationListOptions = {}): AsyncGenerator<Organization, void, undefined> =>
        paginate(this.getOrganizationList, options);
    /** The number of organizations matching `search`. */
    getCount = async (options: OrganizationCountOptions = {}): Promise<number> =>
        (await this.request("get", "/v1/organizations/count", { query: { search: search(options.search) } }, options))
            .totalCount;
    getOrganization = (id: string, options?: RequestOptions): Promise<OrganizationDetails> =>
        this.request("get", "/v1/organizations/{organizationId}", { path: { organizationId: publicId(id) } }, options);
    createOrganization = (input: CreateOrganizationInput, options?: MutationOptions): Promise<{ id: string }> =>
        this.request("post", "/v1/organizations", { body: input }, options);
    updateOrganization = (id: string, input: UpdateOrganizationInput, options?: MutationOptions): Promise<void> =>
        this.request(
            "put",
            "/v1/organizations/{organizationId}",
            { path: { organizationId: publicId(id) }, body: input },
            options,
        );
    /** Deletes the organization. Throws `PistiAPIResponseError` (409) with `blockers` while something stops it. */
    deleteOrganization = (id: string, options?: MutationOptions): Promise<void> =>
        this.request("delete", "/v1/organizations/{organizationId}", { path: { organizationId: publicId(id) } }, options);
    getOrganizationMembershipList = (
        id: string,
        options: SearchListOptions = {},
    ): Promise<Page<OrganizationMembership>> =>
        this.request(
            "get",
            "/v1/organizations/{organizationId}/memberships",
            { path: { organizationId: publicId(id) }, query: { ...page(options), search: search(options.search) } },
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
    updateOrganizationMembership = (id: string, userId: string, roleId: string, options?: MutationOptions): Promise<void> =>
        this.request(
            "put",
            "/v1/organizations/{organizationId}/memberships/{userId}",
            { path: { organizationId: publicId(id), userId: publicId(userId) }, body: { roleId: publicId(roleId) } },
            options,
        );
    deleteOrganizationMembership = (id: string, userId: string, options?: MutationOptions): Promise<void> =>
        this.request(
            "delete",
            "/v1/organizations/{organizationId}/memberships/{userId}",
            { path: { organizationId: publicId(id), userId: publicId(userId) } },
            options,
        );
    getOrganizationInvitationList = (
        id: string,
        options: SearchListOptions = {},
    ): Promise<Page<OrganizationInvitation>> =>
        this.request(
            "get",
            "/v1/organizations/{organizationId}/invitations",
            { path: { organizationId: publicId(id) }, query: { ...page(options), search: search(options.search) } },
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
        options?: MutationOptions,
    ): Promise<InvitationResult> =>
        this.request(
            "post",
            "/v1/organizations/{organizationId}/invitations",
            { path: { organizationId: publicId(id) }, body: { ...input, roleId: publicId(input.roleId) } },
            options,
        );
    resendOrganizationInvitation = (
        id: string,
        invitationId: string,
        input: ResendOrganizationInvitationInput,
        options?: MutationOptions,
    ): Promise<InvitationResult> =>
        this.request(
            "post",
            "/v1/organizations/{organizationId}/invitations/{invitationId}/resend",
            { path: { organizationId: publicId(id), invitationId: publicId(invitationId) }, body: input },
            options,
        );
    revokeOrganizationInvitation = (id: string, invitationId: string, options?: MutationOptions): Promise<void> =>
        this.request(
            "delete",
            "/v1/organizations/{organizationId}/invitations/{invitationId}",
            { path: { organizationId: publicId(id), invitationId: publicId(invitationId) } },
            options,
        );
    getRoleList = (id: string, options?: RequestOptions): Promise<Role[]> =>
        this.request("get", "/v1/organizations/{organizationId}/roles", { path: { organizationId: publicId(id) } }, options);
    createRole = (id: string, input: RoleInput, options?: MutationOptions): Promise<{ id: string }> =>
        this.request(
            "post",
            "/v1/organizations/{organizationId}/roles",
            { path: { organizationId: publicId(id) }, body: input },
            options,
        );
    updateRole = (id: string, roleId: string, input: RoleInput, options?: MutationOptions): Promise<void> =>
        this.request(
            "put",
            "/v1/organizations/{organizationId}/roles/{roleId}",
            { path: { organizationId: publicId(id), roleId: publicId(roleId) }, body: input },
            options,
        );
    deleteRole = (id: string, roleId: string, options?: MutationOptions): Promise<void> =>
        this.request(
            "delete",
            "/v1/organizations/{organizationId}/roles/{roleId}",
            { path: { organizationId: publicId(id), roleId: publicId(roleId) } },
            options,
        );
    /** Every permission, whole, in one page. */
    getPermissionList = (options?: RequestOptions): Promise<Page<Permission>> =>
        this.request("get", "/v1/permissions", {}, options);
}


/**
 * Creates a backend client, like Clerk's `createClerkClient`. Without options it reads
 * `PISTI_PUBLISHABLE_KEY`, `PISTI_SECRET_KEY` and `PISTI_AUTHORIZED_PARTIES`.
 */
export function createPistiClient(options?: PistiClientOptions): PistiClient {
    return new PistiClient(options);
}
