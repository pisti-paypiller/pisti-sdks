import type { components } from "./generated/frontend.js";
import { MeResource, OrganizationResource, type ClientState, type SessionRequest } from "./resources.js";
import type {
    RedirectOptions,
    AuthSnapshot,
    EnvironmentConfig,
    GetTokenOptions,
    PermissionCheck,
    PistiClientOptions,
    PistiModal,
    PistiNavigationOptions,
    PistiUser,
    SecondFactorDetails,
    SignInResult,
    SignUpInput,
} from "./types.js";

/** What a sensitive action needs: the factors to verify again (`first_factor`, or `multi_factor` for both) and how
 * recently, in minutes. */
export interface ReverificationRequirement {
    level: "first_factor" | "multi_factor";
    afterMinutes: number;
}
/** A session verification in progress (`/v1/client/sessions/{id}/verify`). */
export type SessionVerification = components["schemas"]["SessionVerificationResponse"];

export class PistiClientError extends Error {
    constructor(
        message: string,
        readonly status = 0,
        readonly code?: string,
        /** Set on `403 session_reverification_required`: what to verify before retrying. */
        readonly reverification?: ReverificationRequirement,
    ) {
        super(message);
        this.name = "PistiClientError";
    }
}

/** The requirement a failed call reports, when it failed because the session must verify again. */
export function reverificationOf(error: unknown): ReverificationRequirement | null {
    if (!error || typeof error !== "object") return null;
    const { code, reverification } = error as { code?: unknown; reverification?: Partial<ReverificationRequirement> };
    // The problem always carries both fields; anything else is not a requirement this SDK can satisfy.
    if (code !== "session_reverification_required" || !reverification) return null;
    const { level, afterMinutes } = reverification;
    if ((level !== "first_factor" && level !== "multi_factor") || typeof afterMinutes !== "number") return null;
    return { level, afterMinutes };
}

/** The requirement that satisfies both: the stricter level and the shorter window. */
function strictest(a: ReverificationRequirement, b: ReverificationRequirement): ReverificationRequirement {
    const level = a.level === "multi_factor" || b.level === "multi_factor" ? "multi_factor" : "first_factor";
    const afterMinutes = Math.min(a.afterMinutes, b.afterMinutes);
    return level === a.level && afterMinutes === a.afterMinutes ? a : { level, afterMinutes };
}

/** Runs a WebAuthn ceremony, reporting a dismissed or timed-out prompt as `passkey_cancelled`. */
export async function passkeyCeremony<T>(ceremony: () => Promise<T | null>): Promise<T> {
    let result: T | null;
    try {
        result = await ceremony();
    } catch (error) {
        const name = (error as { name?: unknown } | null)?.name;
        if (name === "NotAllowedError" || name === "AbortError")
            throw new PistiClientError("The passkey prompt was closed or timed out. Try again.", 400, "passkey_cancelled");
        throw error;
    }
    if (!result) throw new PistiClientError("No passkey was chosen.", 400, "passkey_cancelled");
    return result;
}

/** A sign-in or sign-up in progress, as the Frontend API returns it. */
export interface AttemptResource {
    id: string;
    object: "sign_in" | "sign_up";
    status: "needs_first_factor" | "needs_second_factor" | "missing_requirements" | "complete";
    identifier?: string | null;
    emailAddress?: string | null;
    supportedFirstFactors?: { strategy: string }[];
    firstFactorVerification?: {
        strategy: string;
        status: string;
        externalVerificationRedirectUrl: string | null;
        passkeyOptions: PublicKeyCredentialRequestOptionsJSON | null;
        error: string | null;
    } | null;
    secondFactor: SecondFactorDetails | null;
    createdSessionId: string | null;
    recoveryCodes: string[] | null;
    expiresAt: string;
}

interface AttemptEnvelope {
    response: AttemptResource;
    client: ClientState;
}

/** WebAuthn request options as JSON (base64url buffers), the shape Pisti returns. */
export interface PublicKeyCredentialRequestOptionsJSON {
    challenge: string;
    rpId?: string;
    timeout?: number;
    userVerification?: UserVerificationRequirement;
    allowCredentials?: { id: string; type: "public-key"; transports?: string[] }[];
}

/** WebAuthn creation options as JSON (base64url buffers). */
export interface PublicKeyCredentialCreationOptionsJSON {
    challenge: string;
    rp: { id?: string; name: string };
    user: { id: string; name: string; displayName: string };
    pubKeyCredParams: { type: "public-key"; alg: number }[];
    timeout?: number;
    excludeCredentials?: { id: string; type: "public-key"; transports?: string[] }[];
    authenticatorSelection?: AuthenticatorSelectionCriteria;
    attestation?: AttestationConveyancePreference;
}


const INITIAL: AuthSnapshot = Object.freeze({
    status: "loading",
    isLoaded: false,
    isSignedIn: false,
    user: null,
    sessionId: null,
    sessionClaims: null,
    factorVerificationAge: null,
    error: null,
});
const SIGNED_OUT: AuthSnapshot = Object.freeze({
    status: "signedOut",
    isLoaded: true,
    isSignedIn: false,
    user: null,
    sessionId: null,
    sessionClaims: null,
    factorVerificationAge: null,
    error: null,
});

/** Reads `VITE_<name>` or `<name>` from Vite's import.meta.env, then process.env. */
function envValue(name: string): string | undefined {
    try {
        const env = (import.meta as { env?: Record<string, string | undefined> }).env;
        const value = env?.[`VITE_${name}`] ?? env?.[name];
        if (value) return value;
    } catch {
        /* Not a Vite build. */
    }
    const processEnv = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
    return processEnv?.[`VITE_${name}`] ?? processEnv?.[name];
}

function withEnvironmentDefaults(options: PistiNavigationOptions): PistiNavigationOptions {
    return {
        ...options,
        signInUrl: options.signInUrl ?? envValue("PISTI_SIGN_IN_URL"),
        signUpUrl: options.signUpUrl ?? envValue("PISTI_SIGN_UP_URL"),
        signInFallbackRedirectUrl: options.signInFallbackRedirectUrl ?? envValue("PISTI_SIGN_IN_FALLBACK_REDIRECT_URL"),
        signUpFallbackRedirectUrl: options.signUpFallbackRedirectUrl ?? envValue("PISTI_SIGN_UP_FALLBACK_REDIRECT_URL"),
        signInForceRedirectUrl: options.signInForceRedirectUrl ?? envValue("PISTI_SIGN_IN_FORCE_REDIRECT_URL"),
        signUpForceRedirectUrl: options.signUpForceRedirectUrl ?? envValue("PISTI_SIGN_UP_FORCE_REDIRECT_URL"),
        afterSignOutUrl: options.afterSignOutUrl ?? envValue("PISTI_AFTER_SIGN_OUT_URL"),
    };
}

/** Parses `pk_test_…`/`pk_live_…`: base64url of the environment's host URL followed by `$`. */
export function parsePublishableKey(key: string | undefined): {
    /** The environment's own host, where its Frontend API and session API are `/v1/…`. */
    frontendApi: URL;
    /** This environment's own token issuer: its host with a trailing slash. */
    issuer: URL;
    development: boolean;
} {
    if (!key)
        throw new Error(
            "Missing Pisti publishable key. Set VITE_PISTI_PUBLISHABLE_KEY in your .env file (copy it from your application's Home page in the Pisti console), or pass publishableKey to <PistiProvider>.",
        );
    const match = /^pk_(test|live)_([A-Za-z0-9_-]+)$/.exec(key.trim());
    if (!match)
        throw new Error(
            "That isn't a Pisti publishable key. It should start with pk_test_ or pk_live_.",
        );
    const base64 = match[2]!.replace(/-/g, "+").replace(/_/g, "/");
    const decoded = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
    if (!decoded.endsWith("$"))
        throw new Error("The publishable key is malformed.");
    const host = new URL(decoded.slice(0, -1));
    if (host.pathname !== "/" || host.search || host.hash)
        throw new Error("The publishable key is malformed.");
    const development = match[1] === "test";
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(host.hostname) || host.hostname.endsWith(".localhost");
    if (host.protocol !== "https:" && !(development && loopback))
        throw new Error("Pisti requires HTTPS outside local development.");
    return { frontendApi: new URL(host.origin), issuer: new URL(`${host.origin}/`), development };
}

function decodeClaims(token: string): Record<string, unknown> {
    try {
        const payload = token.split(".")[1]!.replace(/-/g, "+").replace(/_/g, "/");
        return JSON.parse(
            decodeURIComponent(
                Array.from(
                    atob(payload + "=".repeat((4 - (payload.length % 4)) % 4)),
                    (character) => "%" + character.charCodeAt(0).toString(16).padStart(2, "0"),
                ).join(""),
            ),
        ) as Record<string, unknown>;
    } catch {
        return {};
    }
}

/**
 * Talks to the environment's Frontend API from the browser: sign-in and sign-up
 * steps, the signed-in session, and short-lived session tokens. Keeps the
 * `__session` cookie fresh so same-site backends can read it.
 */
export class PistiClient {
    readonly publishableKey: string;
    readonly frontendApi: URL;
    /** This environment's token issuer. */
    readonly issuer: URL;
    readonly development: boolean;
    /** The signed-in user's own resources, `/v1/me`. */
    readonly me: MeResource = new MeResource(
        <T>(method: Parameters<SessionRequest>[0], path: string, body?: unknown, options?: Parameters<SessionRequest>[3]) =>
            this.sessionRequest<T>(method, path, body, options),
        async (state) => {
            await this.apply(state, state.lastActiveSessionId ?? undefined);
            this.channel?.postMessage("changed");
        },
    );
    /** What members manage in their organizations, `/v1/organizations/{id}`. */
    readonly organizations: OrganizationResource = new OrganizationResource(
        <T>(method: Parameters<SessionRequest>[0], path: string, body?: unknown) => this.sessionRequest<T>(method, path, body),
    );

    private snapshot: AuthSnapshot = INITIAL;
    private environmentConfig: EnvironmentConfig | null = null;
    private environmentRequest: Promise<EnvironmentConfig> | undefined;
    private readonly listeners = new Set<() => void>();
    private token: { value: string; expiresAt: number; sessionId: string } | undefined;
    private renewing: Promise<string | null> | undefined;
    private loading: Promise<void> | undefined;
    private timer: ReturnType<typeof setInterval> | undefined;
    private channel: BroadcastChannel | undefined;
    private readonly storageKey: string;
    private navigation: PistiNavigationOptions;
    private modal: PistiModal = null;
    private modalOptions: RedirectOptions = {};
    private readonly modalListeners = new Set<() => void>();
    private readonly reverificationListeners = new Set<() => void>();
    private reverification:
        | { requirement: ReverificationRequirement; promise: Promise<void>; resolve: () => void; reject: (error: Error) => void }
        | undefined;
    private csrf: Promise<components["schemas"]["CsrfTokenResponse"]> | undefined;

    constructor(options: PistiClientOptions = {}) {
        const publishableKey = options.publishableKey ?? envValue("PISTI_PUBLISHABLE_KEY");
        const key = parsePublishableKey(publishableKey);
        this.publishableKey = publishableKey!;
        this.frontendApi = key.frontendApi;
        this.issuer = key.issuer;
        this.development = key.development;
        this.storageKey = `pisti_client:${key.frontendApi.host}`;
        const { publishableKey: _key, ...navigation } = options;
        this.navigation = withEnvironmentDefaults(navigation);
    }

    /** Updates redirect URLs and router functions without recreating the client. */
    configure(navigation: PistiNavigationOptions): void {
        this.navigation = withEnvironmentDefaults(navigation);
    }

    readonly subscribe = (listener: () => void): (() => void) => {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    };
    readonly getSnapshot = (): AuthSnapshot => this.snapshot;
    readonly getServerSnapshot = (): AuthSnapshot => INITIAL;
    get environment(): EnvironmentConfig | null {
        return this.environmentConfig;
    }

    start(): () => void {
        if (typeof window === "undefined") return () => {};
        void this.load();
        void this.loadEnvironment().catch(() => {});
        this.timer = setInterval(() => {
            if (this.snapshot.isSignedIn && document.visibilityState === "visible")
                void this.getToken().catch(() => {});
        }, 15_000);
        const focus = () => {
            if (document.visibilityState === "visible") void this.load();
        };
        document.addEventListener("visibilitychange", focus);
        if (typeof BroadcastChannel !== "undefined") {
            this.channel = new BroadcastChannel(`pisti:${this.frontendApi.host}`);
            this.channel.onmessage = () => void this.load();
        }
        return () => {
            clearInterval(this.timer);
            document.removeEventListener("visibilitychange", focus);
            this.channel?.close();
            this.channel = undefined;
        };
    }

    /** Re-reads the browser's session from Pisti. */
    readonly load = (): Promise<void> =>
        (this.loading ??= (async () => {
            try {
                const state = await this.fapi<ClientState>("GET", "client");
                await this.apply(state);
            } catch (error) {
                this.setSnapshot({
                    ...SIGNED_OUT,
                    status: "error",
                    error: error instanceof Error ? error : new Error("Pisti is unavailable."),
                });
            } finally {
                this.loading = undefined;
            }
        })());

    readonly loadEnvironment = (): Promise<EnvironmentConfig> =>
        this.environmentConfig
            ? Promise.resolve(this.environmentConfig)
            : (this.environmentRequest ??= this.fapi<EnvironmentConfig>("GET", "environment").then(
                  (value) => {
                      this.environmentConfig = value;
                      for (const listener of this.listeners) listener();
                      return value;
                  },
                  (error: unknown) => {
                      this.environmentRequest = undefined;
                      throw error;
                  },
              ));

    /** Sign-ins as resources (Clerk's `SignIn`): create one, then prepare and attempt its factors. A completed attempt
     * signs the browser in. The step helpers below wrap these for the common flows. */
    readonly signIn = {
        create: (input: { identifier?: string; strategy?: string; password?: string; redirectUrl?: string }): Promise<AttemptResource> =>
            this.attempt("POST", "client/sign_ins", input),
        get: (id: string): Promise<AttemptResource> => this.attempt("GET", `client/sign_ins/${encodeURIComponent(id)}`),
        prepareFirstFactor: (id: string, strategy: "email_code" | "passkey"): Promise<AttemptResource> =>
            this.attempt("POST", `client/sign_ins/${encodeURIComponent(id)}/prepare_first_factor`, { strategy }),
        attemptFirstFactor: (id: string, input: { strategy: string; password?: string; code?: string; credential?: unknown }): Promise<AttemptResource> =>
            this.attempt("POST", `client/sign_ins/${encodeURIComponent(id)}/attempt_first_factor`, input),
        attemptSecondFactor: (id: string, input: { strategy: "totp" | "backup_code"; code: string; emailCode?: string }): Promise<AttemptResource> =>
            this.attempt("POST", `client/${id.startsWith("sua_") ? "sign_ups" : "sign_ins"}/${encodeURIComponent(id)}/attempt_second_factor`, input),

        password: async (identifier: string, password: string): Promise<SignInResult> =>
            this.result(await this.signIn.create({ identifier, password })),
        sendEmailCode: async (identifier: string): Promise<{ requestId: string }> => {
            const created = await this.signIn.create({ identifier });
            await this.signIn.prepareFirstFactor(created.id, "email_code");
            return { requestId: created.id };
        },
        verifyEmailCode: async (requestId: string, code: string): Promise<SignInResult> =>
            this.result(await this.signIn.attemptFirstFactor(requestId, { strategy: "email_code", code })),
        secondFactorDetails: async (attemptId: string): Promise<SecondFactorDetails> => {
            const attempt = await this.signIn.get(attemptId);
            return { ...(attempt.secondFactor ?? { enrollmentRequired: false, setupKey: null, authenticatorUri: null, emailCodeRequired: false }),
                expiresAt: attempt.expiresAt };
        },
        completeSecondFactor: async (attemptId: string, code: string, emailCode?: string): Promise<SignInResult> =>
            this.result(await this.signIn.attemptSecondFactor(attemptId, {
                // Authenticator codes are six digits; recovery codes are longer.
                strategy: /^\d{6}$/.test(code.trim()) ? "totp" : "backup_code",
                code: code.trim(),
                ...(emailCode ? { emailCode } : {}),
            })),
        /** Signs in with a passkey: the browser asks the user to choose one of theirs for this application. */
        passkey: async (): Promise<SignInResult> => {
            const created = await this.signIn.create({ strategy: "passkey" });
            const options = created.firstFactorVerification?.passkeyOptions;
            if (!options) throw new PistiClientError("Passkeys aren’t available here.", 400, "strategy_not_supported");
            const credential = await passkeyCeremony(() => navigator.credentials.get({ publicKey: requestOptions(options) }));
            return this.result(await this.signIn.attemptFirstFactor(created.id, {
                strategy: "passkey",
                credential: assertionJson(credential as PublicKeyCredential),
            }));
        },
        /** Signs in through an upstream provider (`oauth_{id}` from the environment): the browser goes there and comes
         * back to `redirectUrl` (this page by default), where `handleRedirectCallback()` finishes. */
        withProvider: async (strategy: string, redirectUrl: string = location.href): Promise<never> => {
            const created = await this.signIn.create({ strategy, redirectUrl });
            const target = created.firstFactorVerification?.externalVerificationRedirectUrl;
            if (!target) throw new PistiClientError("That provider isn’t available here.", 400, "strategy_not_supported");
            location.assign(target);
            return new Promise<never>(() => {});
        },
    };

    /** Sign-ups as resources (Clerk's `SignUp`): create one, verify its email, and the account is created and signed in. */
    readonly signUp = {
        create: (input: { emailAddress?: string; password?: string; firstName?: string; lastName?: string; username?: string; invitationToken?: string }): Promise<AttemptResource> =>
            this.attempt("POST", "client/sign_ups", input),
        get: (id: string): Promise<AttemptResource> => this.attempt("GET", `client/sign_ups/${encodeURIComponent(id)}`),
        update: (id: string, input: { emailAddress?: string; password?: string; firstName?: string; lastName?: string; username?: string }): Promise<AttemptResource> =>
            this.attempt("PATCH", `client/sign_ups/${encodeURIComponent(id)}`, input),
        prepareVerification: (id: string): Promise<AttemptResource> =>
            this.attempt("POST", `client/sign_ups/${encodeURIComponent(id)}/prepare_verification`, { strategy: "email_code" }),
        attemptVerification: (id: string, code: string): Promise<AttemptResource> =>
            this.attempt("POST", `client/sign_ups/${encodeURIComponent(id)}/attempt_verification`, { strategy: "email_code", code }),

        sendEmailCode: async (email: string, invitationToken?: string, username?: string): Promise<{ requestId: string }> => {
            const created = await this.signUp.create({
                emailAddress: email,
                ...(invitationToken ? { invitationToken } : {}),
                ...(username ? { username } : {}),
            });
            await this.signUp.prepareVerification(created.id);
            return { requestId: created.id };
        },
        verify: async (input: SignUpInput): Promise<SignInResult> => {
            if (input.firstName !== undefined || input.lastName !== undefined || input.password)
                await this.signUp.update(input.requestId, {
                    ...(input.firstName !== undefined ? { firstName: input.firstName } : {}),
                    ...(input.lastName !== undefined ? { lastName: input.lastName } : {}),
                    ...(input.password ? { password: input.password } : {}),
                });
            return this.result(await this.signUp.attemptVerification(input.requestId, input.code));
        },
    };

    /** After a provider round trip the browser returns with `__pisti_attempt`: this reads that attempt, removes the
     * parameter, and returns it (complete, waiting for its second factor, or a sign-up to verify), or null. */
    readonly handleRedirectCallback = async (): Promise<AttemptResource | null> => {
        const url = new URL(location.href);
        const id = url.searchParams.get("__pisti_attempt");
        if (!id) return null;
        url.searchParams.delete("__pisti_attempt");
        history.replaceState(history.state, "", url.href);
        const attempt = id.startsWith("sua_") ? await this.signUp.get(id) : await this.signIn.get(id);
        if (attempt.status === "complete") await this.result(attempt);
        return attempt;
    };

    /** Turns an attempt from the resource methods into a step result; a completed one signs the browser in. */
    readonly completeAttempt = (attempt: AttemptResource): Promise<SignInResult> => this.result(attempt);

    /** Every user signed in to this browser (several only when the environment allows multi-session). */
    get sessions(): { id: string; userId: string; email: string; fullName: string | null }[] {
        return this.clientState?.sessions.map((item) => ({
            id: item.id,
            userId: item.user.id,
            email: item.user.email,
            fullName: `${item.user.firstName} ${item.user.lastName}`.trim() || null,
        })) ?? [];
    }

    /** Makes another of this browser's sessions the active one. */
    readonly setActive = async (sessionId: string): Promise<void> => {
        const touch = (organizationId: string | null) =>
            this.fapi<ClientState>("POST", `client/sessions/${encodeURIComponent(sessionId)}/touch`, { organizationId });
        const organizationId = this.clientState?.sessions.find((item) => item.id === sessionId)?.organizationId ?? null;
        let state: ClientState;
        try {
            state = await touch(organizationId);
        } catch (error) {
            // The session's organization may have gone elsewhere (membership removed, organization deleted): read the
            // client again and switch once more without it, landing on the personal account.
            if (organizationId === null || !(error instanceof PistiClientError) || (error.status !== 403 && error.status !== 404)) throw error;
            await this.load();
            state = await touch(null);
        }
        await this.apply(state, sessionId);
        await this.getToken({ skipCache: true }).catch(() => {});
        this.channel?.postMessage("changed");
    };

    readonly passwordReset = {
        sendEmailCode: (identifier: string): Promise<{ requestId: string; resendAvailableAt: string }> =>
            this.fapi("POST", "client/password_reset", { identifier }),
        complete: (input: {
            requestId: string;
            code: string;
            password: string;
            authenticatorCode?: string;
        }): Promise<void> => this.fapi("POST", "client/password_reset/complete", input),
    };

    /** Restores a self-deactivated account during its 30-day grace period. The user then signs in again. */
    readonly reactivation = {
        sendEmailCode: (identifier: string): Promise<{ requestId: string; resendAvailableAt: string }> =>
            this.fapi("POST", "client/reactivation", { identifier }),
        complete: (input: { requestId: string; code: string; authenticatorCode?: string }): Promise<void> =>
            this.fapi("POST", "client/reactivation/complete", input),
    };

    readonly signOut = async (): Promise<void> => {
        await this.apply(await this.fapi<ClientState>("POST", "client/sign_out"));
        this.channel?.postMessage("changed");
    };

    readonly setActiveOrganization = async (organizationId: string | null): Promise<void> => {
        const sessionId = this.requireSession();
        await this.apply(
            await this.fapi<ClientState>("POST", `client/sessions/${encodeURIComponent(sessionId)}/touch`, { organizationId }),
        );
        await this.getToken({ skipCache: true });
        this.channel?.postMessage("changed");
    };

    /** A fresh session token for your backend, or null when signed out. Tokens last about a minute. */
    readonly getToken = (options: GetTokenOptions = {}): Promise<string | null> => {
        const sessionId = this.snapshot.sessionId;
        if (!sessionId) return Promise.resolve(null);
        if (
            !options.skipCache &&
            this.token?.sessionId === sessionId &&
            this.token.expiresAt - Date.now() > 20_000
        )
            return Promise.resolve(this.token.value);
        return (this.renewing ??= (async () => {
            try {
                const result = await this.fapi<components["schemas"]["SessionTokenResponse"]>(
                    "POST",
                    `client/sessions/${sessionId}/tokens`,
                );
                if (this.snapshot.sessionId !== sessionId) return null;
                this.token = { value: result.jwt, expiresAt: Date.parse(result.expiresAt), sessionId };
                this.writeCookie(result.jwt);
                this.applyClaims(decodeClaims(result.jwt));
                return result.jwt;
            } catch (error) {
                if (error instanceof PistiClientError && error.status === 401) await this.load();
                throw error;
            } finally {
                this.renewing = undefined;
            }
        })());
    };

    readonly has = (check: PermissionCheck): boolean => {
        const user = this.snapshot.user;
        return Boolean(
            user &&
                (check.permission || check.role) &&
                (!check.permission || user.organizationPermissions.includes(check.permission)) &&
                (!check.role || user.organizationRole === check.role),
        );
    };

    /** `fetch` with the session token attached as a bearer credential. */
    readonly authenticatedFetch = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
        const token = await this.getToken();
        const headers = new Headers(init.headers);
        if (token) headers.set("Authorization", "Bearer " + token);
        const response = await fetch(input, { ...init, headers });
        if (response.status !== 401 || !token) return response;
        const renewed = await this.getToken({ skipCache: true });
        if (!renewed) return response;
        headers.set("Authorization", "Bearer " + renewed);
        return fetch(input, { ...init, headers });
    };

    get signInUrl(): string | null {
        return this.navigation.signInUrl ?? this.environmentConfig?.paths.signInUrl ?? null;
    }
    get signUpUrl(): string | null {
        return this.navigation.signUpUrl ?? this.environmentConfig?.paths.signUpUrl ?? null;
    }

    /** Goes to your sign-in page (remembering the current page), or opens sign-in in a modal when you have none. */
    readonly redirectToSignIn = (): void => {
        const target = this.signInUrl;
        if (target) this.navigate(this.withReturn(target));
        else this.openSignIn();
    };
    readonly redirectToSignUp = (): void => {
        const target = this.signUpUrl;
        if (target) this.navigate(this.withReturn(target));
        else this.openSignUp();
    };
    /** Force redirect, then `redirect_url`, then the fallback, then the console setting, then "/". */
    readonly redirectAfterSignIn = (options: RedirectOptions = {}): void =>
        this.navigate(
            options.forceRedirectUrl ??
                this.navigation.signInForceRedirectUrl ??
                this.returnUrl() ??
                options.fallbackRedirectUrl ??
                this.navigation.signInFallbackRedirectUrl ??
                this.environmentConfig?.paths.afterSignInUrl ??
                "/",
            true,
        );
    readonly redirectAfterSignUp = (options: RedirectOptions = {}): void =>
        this.navigate(
            options.forceRedirectUrl ??
                this.navigation.signUpForceRedirectUrl ??
                this.returnUrl() ??
                options.fallbackRedirectUrl ??
                this.navigation.signUpFallbackRedirectUrl ??
                this.environmentConfig?.paths.afterSignUpUrl ??
                this.navigation.signInFallbackRedirectUrl ??
                this.environmentConfig?.paths.afterSignInUrl ??
                "/",
            true,
        );
    readonly redirectAfterSignOut = (): void =>
        this.navigate(this.navigation.afterSignOutUrl ?? this.environmentConfig?.paths.afterSignOutUrl ?? "/");

    /** Navigates with your router when you passed routerPush, otherwise with a normal page load. */
    readonly navigate = (to: string, replace = false): void => {
        if (typeof window === "undefined") return;
        const url = new URL(to, window.location.href);
        const router = replace ? (this.navigation.routerReplace ?? this.navigation.routerPush) : this.navigation.routerPush;
        if (url.origin === window.location.origin && router) void router(url.pathname + url.search + url.hash);
        else if (replace) window.location.replace(url.href);
        else window.location.assign(url.href);
    };

    // ----- Modals -----

    readonly subscribeModal = (listener: () => void): (() => void) => {
        this.modalListeners.add(listener);
        return () => {
            this.modalListeners.delete(listener);
        };
    };
    readonly getModal = (): PistiModal => this.modal;
    readonly getServerModal = (): PistiModal => null;
    /** Redirect options the open modal was given, for example by a sign-in button. */
    readonly getModalOptions = (): RedirectOptions => this.modalOptions;
    readonly openSignIn = (options: RedirectOptions = {}): void => this.setModal("sign-in", options);
    readonly openSignUp = (options: RedirectOptions = {}): void => this.setModal("sign-up", options);
    readonly openUserProfile = (): void => this.setModal("user-profile");
    readonly closeModal = (): void => this.setModal(null);

    /**
     * Whether a passkey ceremony can run on this page. WebAuthn must be available, and the page must be able to use the
     * environment's relying party: in production its primary domain (the Frontend API host's parent, `acme.com` for
     * `auth.acme.com`), over HTTPS, on that domain or a subdomain of it; in development the hosted pages' host
     * (`quiet-fox-12-accounts.<dev-domain>` for `quiet-fox-12.<dev-domain>`), since generated hosts share a domain.
     */
    get passkeysAvailable(): boolean {
        if (typeof window === "undefined" || !("PublicKeyCredential" in window) || typeof navigator === "undefined" || !navigator.credentials)
            return false;
        const here = window.location;
        const [label, ...rest] = this.frontendApi.hostname.split(".");
        if (!label || rest.length === 0) return false;
        if (this.development) return here.hostname === `${label}-accounts.${rest.join(".")}`;
        const relyingParty = rest.join(".");
        return here.protocol === "https:" && (here.hostname === relyingParty || here.hostname.endsWith("." + relyingParty));
    }

    // ----- Reverification (sensitive account changes) -----

    /** The active session's verification (`/v1/client/sessions/{id}/verify`), like Clerk's `session.startVerification`:
     * create one for a level, then prepare and attempt its first and second factor until its status is `complete`. */
    readonly sessionVerification = {
        create: (level: ReverificationRequirement["level"]): Promise<SessionVerification> =>
            this.verify("POST", "", { level }),
        get: (): Promise<SessionVerification> => this.verify("GET", ""),
        prepareFirstFactor: (strategy: "email_code" | "passkey"): Promise<SessionVerification> =>
            this.verify("POST", "/prepare_first_factor", { strategy }),
        attemptFirstFactor: (input: { strategy: "password" | "email_code" | "passkey"; password?: string; code?: string; credential?: unknown }): Promise<SessionVerification> =>
            this.verify("POST", "/attempt_first_factor", input),
        prepareSecondFactor: (strategy: "totp" | "backup_code"): Promise<SessionVerification> =>
            this.verify("POST", "/prepare_second_factor", { strategy }),
        attemptSecondFactor: (input: { strategy: "totp" | "backup_code"; code: string }): Promise<SessionVerification> =>
            this.verify("POST", "/attempt_second_factor", input),
        /** Verifies the first factor with a passkey: the browser asks the user to choose one. */
        passkey: async (): Promise<SessionVerification> => {
            const prepared = await this.sessionVerification.prepareFirstFactor("passkey");
            const options = prepared.firstFactorVerification?.passkeyOptions;
            if (!options) throw new PistiClientError("Passkeys aren’t available here.", 400, "strategy_not_supported");
            const credential = await passkeyCeremony(() =>
                navigator.credentials.get({ publicKey: requestOptions(options as unknown as PublicKeyCredentialRequestOptionsJSON) }),
            );
            return this.sessionVerification.attemptFirstFactor({ strategy: "passkey", credential: assertionJson(credential as PublicKeyCredential) });
        },
    };

    readonly subscribeReverification = (listener: () => void): (() => void) => {
        this.reverificationListeners.add(listener);
        return () => {
            this.reverificationListeners.delete(listener);
            if (this.reverificationListeners.size === 0) this.cancelReverification();
        };
    };
    /** The requirement the open reverification step asks for, or null. */
    readonly getReverificationSnapshot = (): ReverificationRequirement | null => this.reverification?.requirement ?? null;
    readonly getServerReverificationSnapshot = (): ReverificationRequirement | null => null;

    /** Asks the user to verify the session (the provider's reverification step) and resolves once they have. */
    readonly requestReverification = (requirement: ReverificationRequirement): Promise<void> => {
        if (!this.snapshot.isSignedIn)
            return Promise.reject(new PistiClientError("Sign in before verifying your identity.", 401));
        const pending = this.reverification;
        if (pending) {
            // Requests waiting together are satisfied together: a stricter one escalates the step it joins.
            const merged = strictest(pending.requirement, requirement);
            if (merged !== pending.requirement) {
                pending.requirement = merged;
                for (const listener of this.reverificationListeners) listener();
            }
            return pending.promise;
        }
        if (this.reverificationListeners.size === 0)
            return Promise.reject(
                new PistiClientError("Verify your identity to continue.", 403, "session_reverification_required", requirement),
            );
        let resolve!: () => void;
        let reject!: (error: Error) => void;
        const promise = new Promise<void>((complete, fail) => {
            resolve = complete;
            reject = fail;
        });
        this.reverification = { requirement, promise, resolve, reject };
        for (const listener of this.reverificationListeners) listener();
        return promise;
    };

    /** Ends the reverification step once the session's verification, read again from the server, is `complete` at the
     * level the waiting requests need, so they are retried. */
    readonly completeReverification = async (): Promise<void> => {
        const pending = this.reverification;
        if (!pending) throw new PistiClientError("Start identity verification again.", 400);
        const verification = await this.sessionVerification.get();
        if (verification.status !== "complete" || (pending.requirement.level === "multi_factor" && verification.level !== "multi_factor"))
            throw new PistiClientError("Finish verifying your identity first.", 400, "verification_incomplete");
        await this.load();
        await this.getToken({ skipCache: true }).catch(() => {});
        if (this.reverification !== pending) return;
        this.reverification = undefined;
        pending.resolve();
        for (const listener of this.reverificationListeners) listener();
    };

    readonly cancelReverification = (): void => {
        const pending = this.reverification;
        if (!pending) return;
        this.reverification = undefined;
        pending.reject(new PistiClientError("Identity verification was canceled.", 403, "reverification_cancelled"));
        for (const listener of this.reverificationListeners) listener();
    };

    /** Runs `operation`; when it fails with `session_reverification_required`, asks the user to verify and runs it again. */
    readonly withReverification = async <T>(operation: () => Promise<T>): Promise<T> => {
        const identity = this.snapshot.sessionId;
        try {
            return await operation();
        } catch (error) {
            const requirement = reverificationOf(error);
            if (!requirement) throw error;
            this.requireIdentity(identity);
            await this.requestReverification(requirement);
            this.requireIdentity(identity);
            return operation();
        }
    };

    // ----- Internals -----

    private clientState: ClientState | null = null;
    private attemptClient: ClientState | null = null;

    /** Calls an attempt endpoint, keeping the browser client's token for the development header fallback. */
    private async attempt(method: "GET" | "POST" | "PATCH", path: string, body?: unknown): Promise<AttemptResource> {
        const envelope = await this.fapi<AttemptEnvelope>(method, path, body);
        this.keepClientToken(envelope.client);
        this.attemptClient = envelope.client;
        return envelope.response;
    }

    /** Turns an attempt into a step result; a completed one signs the browser in to its new session. */
    private async result(attempt: AttemptResource): Promise<SignInResult> {
        if (attempt.status === "needs_second_factor")
            return { status: "needs_second_factor", attemptId: attempt.id, enrollmentRequired: attempt.secondFactor?.enrollmentRequired ?? false };
        if (attempt.status !== "complete")
            throw new PistiClientError("Verify your email address to continue.", 409, "missing_requirements");
        await this.apply(this.attemptClient ?? (await this.fapi<ClientState>("GET", "client")), attempt.createdSessionId ?? undefined);
        await this.getToken({ skipCache: true }).catch(() => {});
        this.channel?.postMessage("changed");
        return { status: "complete", recoveryCodes: attempt.recoveryCodes ?? null };
    }

    private keepClientToken(state: ClientState): void {
        if (state.clientToken && this.development) {
            try {
                localStorage.setItem(this.storageKey, state.clientToken);
            } catch {
                /* The HttpOnly cookie still works when storage is unavailable. */
            }
            // Development only: a cookie on the app's own origin lets a server-rendered app pass the client to the
            // handshake, since the environment's generated host is another site.
            document.cookie = `__pisti_client=${state.clientToken}; Path=/; Max-Age=31536000; SameSite=Lax`;
        }
    }

    private async apply(state: ClientState, preferred?: string): Promise<void> {
        // The antiforgery token is cached per browser client. ClientState has no client ID, so a client is taken to have
        // changed when none of its sessions remain (sign-out, or a sign-in that made a new client) or its token changes.
        const before = this.clientState;
        if (
            before &&
            ((state.clientToken !== null && state.clientToken !== before.clientToken && before.clientToken !== null) ||
                !state.sessions.some((item) => before.sessions.some((old) => old.id === item.id)))
        )
            this.csrf = undefined;
        this.keepClientToken(state);
        this.clientState = state;
        const session =
            state.sessions.find((item) => item.id === preferred) ??
            state.sessions.find((item) => item.id === state.lastActiveSessionId) ??
            state.sessions[0];
        if (!session) {
            this.token = undefined;
            this.writeCookie(null);
            this.setSnapshot(SIGNED_OUT);
            return;
        }
        const previous = this.snapshot.user?.id === session.user.id ? this.snapshot.user : null;
        const fullName = `${session.user.firstName} ${session.user.lastName}`.trim();
        const sameOrganization = previous?.organizationId === session.organizationId;
        this.setSnapshot({
            status: "signedIn",
            isLoaded: true,
            isSignedIn: true,
            sessionId: session.id,
            sessionClaims: this.snapshot.sessionId === session.id ? this.snapshot.sessionClaims : null,
            factorVerificationAge: factorAge(session.factorVerificationAge),
            error: null,
            user: Object.freeze({
                id: session.user.id,
                issuer: this.issuer.href,
                fullName: fullName || null,
                firstName: session.user.firstName,
                lastName: session.user.lastName,
                primaryEmailAddress: session.user.email ? { emailAddress: session.user.email } : null,
                username: session.user.username ?? null,
                imageUrl: session.user.imageUrl,
                hasImage: Boolean(session.user.imageUrl),
                authenticatedAt: previous?.authenticatedAt ?? null,
                instanceId: previous?.instanceId ?? "",
                organizationId: session.organizationId,
                organizationSlug: sameOrganization ? (previous?.organizationSlug ?? null) : null,
                organizationRole: sameOrganization ? (previous?.organizationRole ?? null) : null,
                organizationPermissions: sameOrganization ? (previous?.organizationPermissions ?? []) : [],
            }),
        });
        if (this.token?.sessionId !== session.id || !sameOrganization) await this.getToken({ skipCache: true }).catch(() => {});
    }

    private applyClaims(claims: Record<string, unknown>) {
        const user = this.snapshot.user;
        if (!user) return;
        const permissions = Array.isArray(claims.org_permissions)
            ? claims.org_permissions.filter((value): value is string => typeof value === "string")
            : typeof claims.org_permissions === "string"
              ? [claims.org_permissions]
              : [];
        const next: PistiUser = Object.freeze({
            ...user,
            instanceId: typeof claims.instance_id === "string" ? claims.instance_id : user.instanceId,
            authenticatedAt: typeof claims.auth_time === "number" ? claims.auth_time : null,
            organizationId: typeof claims.org_id === "string" ? claims.org_id : null,
            organizationSlug: typeof claims.org_slug === "string" ? claims.org_slug : null,
            organizationRole: typeof claims.org_role === "string" ? claims.org_role : null,
            organizationPermissions: Object.freeze(permissions),
        });
        this.setSnapshot({
            ...this.snapshot,
            user: next,
            sessionClaims: Object.freeze({ ...claims }),
            factorVerificationAge: factorAge(claims.fva) ?? this.snapshot.factorVerificationAge,
        });
    }

    /**
     * Writes `__session` and `__client_uat` (the session's sign-in time, or 0 when signed out) on the
     * app's origin. Backend SDKs use `__client_uat` to tell an expired cookie that needs a handshake
     * from a visitor who is simply signed out.
     */
    private writeCookie(token: string | null) {
        if (typeof document === "undefined") return;
        const secure = window.location.protocol === "https:" ? "; Secure" : "";
        const authTime = token ? decodeClaims(token).auth_time : 0;
        document.cookie = token
            ? `__session=${token}; Path=/; Max-Age=60; SameSite=Lax${secure}`
            : `__session=; Path=/; Max-Age=0; SameSite=Lax${secure}`;
        document.cookie = `__client_uat=${typeof authTime === "number" ? authTime : 0}; Path=/; Max-Age=31536000; SameSite=Lax${secure}`;
    }

    private setSnapshot(next: AuthSnapshot) {
        this.snapshot = next;
        for (const listener of this.listeners) listener();
    }

    private setModal(modal: PistiModal, options: RedirectOptions = this.modalOptions) {
        this.modalOptions = modal ? options : {};
        if (this.modal === modal) return;
        this.modal = modal;
        for (const listener of this.modalListeners) listener();
    }

    /** Adds the current page as `redirect_url`, so sign-in returns here. */
    private withReturn(target: string): string {
        if (typeof window === "undefined") return target;
        const url = new URL(target, window.location.href);
        if (url.origin === window.location.origin && url.pathname === window.location.pathname) return target;
        url.searchParams.set("redirect_url", window.location.pathname + window.location.search + window.location.hash);
        return url.origin === window.location.origin ? url.pathname + url.search + url.hash : url.href;
    }

    /** A same-origin `redirect_url` from the address bar, if any. Other origins are ignored to avoid open redirects. */
    private returnUrl(): string | null {
        if (typeof window === "undefined") return null;
        const value = new URL(window.location.href).searchParams.get("redirect_url");
        if (!value) return null;
        try {
            const url = new URL(value, window.location.href);
            if (url.origin === window.location.origin) return url.pathname + url.search + url.hash;
            const allowed = this.navigation.allowedRedirectOrigins ?? [];
            return allowed.some((origin) => (typeof origin === "string" ? origin === url.origin : origin.test(url.origin)))
                ? url.href
                : null;
        } catch {
            return null;
        }
    }

    private requireSession(): string {
        if (!this.snapshot.sessionId) throw new PistiClientError("Sign in to continue.", 401, "signed_out");
        return this.snapshot.sessionId;
    }

    private requireIdentity(identity: string | null) {
        if (identity !== this.snapshot.sessionId)
            throw new PistiClientError("The signed-in account changed. Try again.", 409, "identity_changed");
    }

    private async fapi<T>(method: "GET" | "POST" | "PATCH", path: string, body?: unknown): Promise<T> {
        return this.send<T>(method, new URL(`/v1/${path}`, this.frontendApi), body, false);
    }

    /** The development header with the browser client, when this browser keeps one. */
    private clientHeader(): string | null {
        if (!this.development) return null;
        try {
            return localStorage.getItem(this.storageKey);
        } catch {
            return null; /* Fall back to the cookie. */
        }
    }

    /** The antiforgery token for cookie mutations, fetched once per browser client and refetched after `csrf_invalid`. */
    private csrfToken(): Promise<components["schemas"]["CsrfTokenResponse"]> {
        return (this.csrf ??= this.fapi<components["schemas"]["CsrfTokenResponse"]>("GET", "client/csrf").catch((error: unknown) => {
            this.csrf = undefined;
            throw error;
        }));
    }

    /**
     * Sends a request with the browser client: its cookie, or outside production the `X-Pisti-Client` header. With
     * `antiforgery`, a cookie mutation also carries the CSRF token, refetched and sent again once if it is refused.
     */
    private async send<T>(method: string, url: URL, body: unknown, antiforgery: boolean, retried = false): Promise<T> {
        const headers = new Headers({ Accept: "application/json" });
        if (body !== undefined) headers.set("Content-Type", "application/json");
        const client = this.clientHeader();
        if (client) headers.set("X-Pisti-Client", client);
        // A header is never sent by the browser on its own, so header requests need no antiforgery token.
        else if (antiforgery && method !== "GET") {
            const csrf = await this.csrfToken();
            headers.set(csrf.headerName || "X-CSRF-TOKEN", csrf.token);
        }
        let response: Response;
        try {
            response = await fetch(url, {
                method,
                headers,
                credentials: "include",
                cache: "no-store",
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            });
        } catch {
            throw new PistiClientError("Pisti can’t be reached. Check your connection and try again.");
        }
        if (!response.ok) {
            const error = await this.error(response);
            if (antiforgery && !retried && error.status === 403 && error.code === "csrf_invalid") {
                this.csrf = undefined;
                return this.send<T>(method, url, body, antiforgery, true);
            }
            throw error;
        }
        if (response.status === 204) return undefined as T;
        return ((await response.json()) as { data: T }).data;
    }

    /** Calls the active session's verification. The path names the session. */
    private verify(method: "GET" | "POST", path: string, body?: unknown): Promise<SessionVerification> {
        const sessionId = this.requireSession();
        return this.send(method, new URL(`/v1/client/sessions/${encodeURIComponent(sessionId)}/verify${path}`, this.frontendApi), body, true);
    }

    /**
     * One session API request (`/v1/me`, `/v1/organizations`) as the active session, named by `_pisti_session_id`
     * because a browser client may hold several. `403 session_reverification_required` opens the reverification step
     * and retries; a change re-reads the client and the session token afterwards.
     */
    private async sessionRequest<T>(
        method: "GET" | "POST" | "PATCH" | "DELETE",
        path: string,
        body?: unknown,
        options: { reload?: boolean } = {},
    ): Promise<T> {
        const identity = this.snapshot.sessionId;
        if (!identity) throw new PistiClientError("Sign in before managing your account.", 401, "signed_out");
        const run = async () => {
            const url = new URL(path, this.frontendApi);
            url.searchParams.set("_pisti_session_id", identity);
            let result: T;
            try {
                result = await this.send<T>(method, url, body, true);
            } catch (error) {
                if (error instanceof PistiClientError && error.status === 401) await this.load();
                throw error;
            }
            this.requireIdentity(identity);
            return result;
        };
        let result: T;
        try {
            result = await run();
        } catch (error) {
            const requirement = reverificationOf(error);
            if (!requirement) throw error;
            await this.requestReverification(requirement);
            this.requireIdentity(identity);
            result = await run();
        }
        if (method !== "GET" && options.reload !== false) {
            await this.load();
            await this.getToken({ skipCache: true }).catch(() => {});
        }
        return result;
    }

    private async error(response: Response): Promise<PistiClientError> {
        try {
            const problem = (await response.json()) as {
                detail?: string;
                title?: string;
                code?: string;
                errors?: Record<string, string[]>;
                reverification?: ReverificationRequirement;
            };
            const validation = problem.errors ? Object.values(problem.errors).flat().join(" ") : "";
            const requirement = reverificationOf(problem);
            return new PistiClientError(
                validation || problem.detail || problem.title || "The request could not be completed.",
                response.status,
                problem.code,
                ...(requirement ? [requirement] : []),
            );
        } catch {
            return new PistiClientError(
                response.status === 429 ? "Too many attempts. Wait a moment and try again." : "The request could not be completed.",
                response.status,
            );
        }
    }
}

/** A `[first, second]` factor verification age, or null. */
function factorAge(value: unknown): readonly [number, number] | null {
    if (!Array.isArray(value) || value.length !== 2 || !value.every((item) => Number.isInteger(item))) return null;
    return Object.freeze([value[0] as number, value[1] as number] as const);
}

function fromBase64Url(value: string): ArrayBuffer {
    const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    return bytes.buffer;
}

function toBase64Url(value: ArrayBuffer): string {
    let binary = "";
    for (const byte of new Uint8Array(value)) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function descriptor(item: { id: string; type: "public-key"; transports?: string[] }): PublicKeyCredentialDescriptor {
    return { type: item.type, id: fromBase64Url(item.id), ...(item.transports ? { transports: item.transports as AuthenticatorTransport[] } : {}) };
}

/** Pisti's JSON request options as the browser's WebAuthn API takes them. */
export function requestOptions(options: PublicKeyCredentialRequestOptionsJSON): PublicKeyCredentialRequestOptions {
    const { challenge, allowCredentials, ...rest } = options;
    return {
        ...(rest as Omit<PublicKeyCredentialRequestOptions, "challenge" | "allowCredentials">),
        challenge: fromBase64Url(challenge),
        ...(allowCredentials ? { allowCredentials: allowCredentials.map(descriptor) } : {}),
    };
}

/** Pisti's JSON creation options as the browser's WebAuthn API takes them. */
export function creationOptions(options: PublicKeyCredentialCreationOptionsJSON): PublicKeyCredentialCreationOptions {
    const { challenge, user, excludeCredentials, ...rest } = options;
    return {
        ...(rest as Omit<PublicKeyCredentialCreationOptions, "challenge" | "user" | "excludeCredentials">),
        challenge: fromBase64Url(challenge),
        user: { ...user, id: fromBase64Url(user.id) },
        ...(excludeCredentials ? { excludeCredentials: excludeCredentials.map(descriptor) } : {}),
    };
}

/** A passkey assertion as the JSON Pisti verifies. */
export function assertionJson(credential: PublicKeyCredential): unknown {
    const response = credential.response as AuthenticatorAssertionResponse;
    return {
        id: credential.id,
        rawId: toBase64Url(credential.rawId),
        type: credential.type,
        extensions: credential.getClientExtensionResults(),
        response: {
            authenticatorData: toBase64Url(response.authenticatorData),
            clientDataJSON: toBase64Url(response.clientDataJSON),
            signature: toBase64Url(response.signature),
            userHandle: response.userHandle ? toBase64Url(response.userHandle) : null,
        },
    };
}

/** A new passkey as the JSON Pisti registers. */
export function attestationJson(credential: PublicKeyCredential): unknown {
    const response = credential.response as AuthenticatorAttestationResponse;
    return {
        id: credential.id,
        rawId: toBase64Url(credential.rawId),
        type: credential.type,
        extensions: credential.getClientExtensionResults(),
        response: {
            attestationObject: toBase64Url(response.attestationObject),
            clientDataJSON: toBase64Url(response.clientDataJSON),
            transports: response.getTransports?.() ?? [],
        },
    };
}
