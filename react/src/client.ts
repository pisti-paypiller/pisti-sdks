import {
    AccountResource,
    OrganizationResource,
    type SecurityProof,
} from "./resources.js";
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

export type {
    Profile,
    AccountSession,
    SecurityState,
    SecurityProof,
    VerificationRequest,
    AuthenticatorEnrollment,
    Organization,
    OrganizationInput,
    OrganizationMember,
    OrganizationInvitation,
    OrganizationRole,
} from "./resources.js";

export class PistiClientError extends Error {
    constructor(
        message: string,
        readonly status = 0,
        readonly code?: string,
    ) {
        super(message);
        this.name = "PistiClientError";
    }
}

interface SessionUserState {
    id: string;
    firstName: string;
    lastName: string;
    email: string;
    imageUrl: string | null;
}
interface SessionState {
    id: string;
    user: SessionUserState;
    organizationId: string | null;
    lastActiveAt: string;
    expireAt: string;
}
interface ClientState {
    sessions: SessionState[];
    lastActiveSessionId: string | null;
    clientToken: string | null;
}
type Completion = {
    status: "complete";
    sessionId: string;
    client: ClientState;
    recoveryCodes?: string[] | null;
};
type Outcome =
    | Completion
    | { status: "needs_second_factor"; attemptId: string; enrollmentRequired: boolean };

const INITIAL: AuthSnapshot = Object.freeze({
    status: "loading",
    isLoaded: false,
    isSignedIn: false,
    user: null,
    sessionId: null,
    sessionClaims: null,
    error: null,
});
const SIGNED_OUT: AuthSnapshot = Object.freeze({
    status: "signedOut",
    isLoaded: true,
    isSignedIn: false,
    user: null,
    sessionId: null,
    sessionClaims: null,
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
    /** The environment's own host, where its Frontend API and account API are `/v1/…`. */
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
    readonly account = new AccountResource(
        <T>(method: string, path: string, body?: unknown) =>
            this.withReverification(() => this.resource<T>(method, path, body)),
    );
    readonly organizations = new OrganizationResource(
        <T>(method: string, path: string, body?: unknown) =>
            this.withReverification(() => this.resource<T>(method, path, body)),
        () => {
            const identity = this.snapshot.sessionId;
            return () => this.requireIdentity(identity);
        },
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
        | { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void }
        | undefined;

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

    readonly signIn = {
        password: (identifier: string, password: string): Promise<SignInResult> =>
            this.complete(this.fapi<Outcome>("POST", "sign_in/password", { identifier, password })),
        sendEmailCode: (identifier: string): Promise<{ requestId: string }> =>
            this.fapi("POST", "sign_in/email_code", { identifier }),
        verifyEmailCode: (requestId: string, code: string): Promise<SignInResult> =>
            this.complete(this.fapi<Outcome>("POST", "sign_in/email_code/verify", { requestId, code })),
        secondFactorDetails: (attemptId: string): Promise<SecondFactorDetails> =>
            this.fapi("POST", "sign_in/second_factor/details", { attemptId }),
        completeSecondFactor: (attemptId: string, code: string, emailCode?: string): Promise<SignInResult> =>
            this.complete(this.fapi<Outcome>("POST", "sign_in/second_factor", { attemptId, code, ...(emailCode ? { emailCode } : {}) })),
    };

    readonly signUp = {
        sendEmailCode: (email: string): Promise<{ requestId: string }> =>
            this.fapi("POST", "sign_up", { identifier: email }),
        verify: (input: SignUpInput): Promise<SignInResult> =>
            this.complete(this.fapi<Outcome>("POST", "sign_up/verify", input)),
    };

    readonly passwordReset = {
        sendEmailCode: (identifier: string): Promise<{ requestId: string; resendAvailableAt: string }> =>
            this.fapi("POST", "password_reset", { identifier }),
        complete: (input: {
            requestId: string;
            code: string;
            password: string;
            authenticatorCode?: string;
        }): Promise<void> => this.fapi("POST", "password_reset/complete", input),
    };

    /** Restores a self-deactivated account during its 30-day grace period. The user then signs in again. */
    readonly reactivation = {
        sendEmailCode: (identifier: string): Promise<{ requestId: string; resendAvailableAt: string }> =>
            this.fapi("POST", "reactivation", { identifier }),
        complete: (input: { requestId: string; code: string; authenticatorCode?: string }): Promise<void> =>
            this.fapi("POST", "reactivation/complete", input),
    };

    readonly signOut = async (): Promise<void> => {
        await this.apply(await this.fapi<ClientState>("POST", "sign_out"));
        this.channel?.postMessage("changed");
    };

    readonly setActiveOrganization = async (organizationId: string | null): Promise<void> => {
        const sessionId = this.requireSession();
        await this.apply(
            await this.fapi<ClientState>("POST", `sessions/${sessionId}/touch`, { organizationId }),
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
                const result = await this.fapi<{ jwt: string; expiresAt: string }>(
                    "POST",
                    `sessions/${sessionId}/tokens`,
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

    // ----- Reverification (sensitive account changes) -----

    readonly subscribeReverification = (listener: () => void): (() => void) => {
        this.reverificationListeners.add(listener);
        return () => {
            this.reverificationListeners.delete(listener);
            if (this.reverificationListeners.size === 0) this.cancelReverification();
        };
    };
    readonly getReverificationSnapshot = (): boolean => this.reverification !== undefined;
    readonly getServerReverificationSnapshot = (): boolean => false;

    readonly requestReverification = (): Promise<void> => {
        if (!this.snapshot.isSignedIn)
            return Promise.reject(new PistiClientError("Sign in before verifying your identity.", 401));
        if (this.reverification) return this.reverification.promise;
        if (this.reverificationListeners.size === 0)
            return Promise.reject(
                new PistiClientError("Confirm your identity to continue.", 403, "reauthentication_required"),
            );
        let resolve!: () => void;
        let reject!: (error: Error) => void;
        const promise = new Promise<void>((complete, fail) => {
            resolve = complete;
            reject = fail;
        });
        this.reverification = { promise, resolve, reject };
        for (const listener of this.reverificationListeners) listener();
        return promise;
    };

    readonly completeReverification = async (proof: SecurityProof): Promise<void> => {
        const pending = this.reverification;
        if (!pending) throw new PistiClientError("Start identity verification again.", 400);
        await this.account.reauthenticate(proof);
        if (this.reverification !== pending) return;
        this.reverification = undefined;
        pending.resolve();
        for (const listener of this.reverificationListeners) listener();
    };

    readonly cancelReverification = (): void => {
        const pending = this.reverification;
        if (!pending) return;
        this.reverification = undefined;
        pending.reject(new PistiClientError("Identity verification was canceled.", 403, "reauthentication_cancelled"));
        for (const listener of this.reverificationListeners) listener();
    };

    /** Signs out so the user can sign in again, for example to prove who they are. */
    readonly reauthenticate = async (): Promise<void> => {
        this.cancelReverification();
        await this.signOut();
        this.redirectToSignIn();
    };

    readonly withReverification = async <T>(operation: () => Promise<T>): Promise<T> => {
        const identity = this.snapshot.sessionId;
        try {
            return await operation();
        } catch (error) {
            if (!(error instanceof PistiClientError) || error.code !== "reauthentication_required") throw error;
            this.requireIdentity(identity);
            await this.requestReverification();
            this.requireIdentity(identity);
            return operation();
        }
    };

    // ----- Internals -----

    private async complete(request: Promise<Outcome>): Promise<SignInResult> {
        const outcome = await request;
        if (outcome.status !== "complete") return outcome;
        await this.apply(outcome.client, outcome.sessionId);
        await this.getToken({ skipCache: true }).catch(() => {});
        this.channel?.postMessage("changed");
        return { status: "complete", recoveryCodes: outcome.recoveryCodes ?? null };
    }

    private async apply(state: ClientState, preferred?: string): Promise<void> {
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
            error: null,
            user: Object.freeze({
                id: session.user.id,
                issuer: this.issuer.href,
                fullName: fullName || null,
                firstName: session.user.firstName,
                lastName: session.user.lastName,
                primaryEmailAddress: session.user.email ? { emailAddress: session.user.email } : null,
                imageUrl: session.user.imageUrl,
                hasImage: Boolean(session.user.imageUrl),
                authenticatedAt: previous?.authenticatedAt ?? null,
                mfaAuthenticatedAt: previous?.mfaAuthenticatedAt ?? null,
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
            mfaAuthenticatedAt: typeof claims.mfa_authenticated_at === "number" ? claims.mfa_authenticated_at : null,
            organizationId: typeof claims.org_id === "string" ? claims.org_id : null,
            organizationSlug: typeof claims.org_slug === "string" ? claims.org_slug : null,
            organizationRole: typeof claims.org_role === "string" ? claims.org_role : null,
            organizationPermissions: Object.freeze(permissions),
        });
        this.setSnapshot({ ...this.snapshot, user: next, sessionClaims: Object.freeze({ ...claims }) });
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

    private async fapi<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
        const headers = new Headers({ Accept: "application/json" });
        if (body !== undefined) headers.set("Content-Type", "application/json");
        if (this.development) {
            try {
                const stored = localStorage.getItem(this.storageKey);
                if (stored) headers.set("X-Pisti-Client", stored);
            } catch {
                /* Fall back to the cookie. */
            }
        }
        let response: Response;
        try {
            response = await fetch(new URL(`/v1/${path}`, this.frontendApi), {
                method,
                headers,
                credentials: "include",
                cache: "no-store",
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            });
        } catch {
            throw new PistiClientError("Pisti can’t be reached. Check your connection and try again.");
        }
        if (!response.ok) throw await this.error(response);
        if (response.status === 204) return undefined as T;
        return ((await response.json()) as { data: T }).data;
    }

    private async resource<T>(method: string, path: string, body?: unknown): Promise<T> {
        const identity = this.snapshot.sessionId;
        if (!identity) throw new PistiClientError("Sign in before managing your account.", 401);
        // The account API lives on the environment's host too.
        const response = await this.authenticatedFetch(new URL(path, this.frontendApi), {
            method,
            headers: {
                Accept: "application/json",
                ...(body === undefined ? {} : { "Content-Type": "application/json" }),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        this.requireIdentity(identity);
        if (!response.ok) {
            if (response.status === 401) await this.load();
            throw await this.error(response);
        }
        const result = response.status === 204 ? undefined : ((await response.json()) as { data: T }).data;
        if (method !== "GET") {
            await this.load();
            await this.getToken({ skipCache: true }).catch(() => {});
        }
        return result as T;
    }

    private async error(response: Response): Promise<PistiClientError> {
        try {
            const problem = (await response.json()) as {
                detail?: string;
                title?: string;
                code?: string;
                errors?: Record<string, string[]>;
            };
            const validation = problem.errors ? Object.values(problem.errors).flat().join(" ") : "";
            return new PistiClientError(
                validation || problem.detail || problem.title || "The request could not be completed.",
                response.status,
                problem.code,
            );
        } catch {
            return new PistiClientError(
                response.status === 429 ? "Too many attempts. Wait a moment and try again." : "The request could not be completed.",
                response.status,
            );
        }
    }
}
