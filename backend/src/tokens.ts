import { createHash } from "node:crypto";
import {
    createRemoteJWKSet,
    decodeJwt,
    errors as joseErrors,
    importSPKI,
    jwtVerify,
    type CryptoKey,
    type JWTPayload,
    type JWTVerifyGetKey,
} from "jose";
import { PistiError } from "./errors.js";
import { parsePublishableKey, trustedUrl, type PublishableKeyInfo } from "./keys.js";
import type { PistiClient } from "./management.js";
import type {
    AcceptsToken,
    AnyAuthObject,
    AuthenticateRequestOptions,
    AuthenticatedApiKey,
    AuthenticatedM2MToken,
    AuthenticatedOAuthToken,
    AuthObject,
    AuthObjectFor,
    CheckAuthorizationParams,
    RequestState,
    SessionClaims,
    SignedOutAuthObject,
    TokenType,
    VerifyTokenOptions,
} from "./types.js";

/** Cookies and parameters shared with @pisti-paypiller/react and the Frontend API. */
export const SESSION_COOKIE = "__session";
export const CLIENT_UAT_COOKIE = "__client_uat";
export const HANDSHAKE_PARAMETER = "__pisti_handshake";
const REDIRECT_LOOP_COOKIE = "__pisti_redirect_loop";

const keySets = new Map<string, Promise<JWTVerifyGetKey>>();
const pemKeys = new Map<string, Promise<CryptoKey>>();

function publishableKeyFrom(value: string | undefined): string {
    const key = value ?? process.env.PISTI_PUBLISHABLE_KEY;
    if (!key)
        throw new Error(
            "Missing Pisti publishable key. Set PISTI_PUBLISHABLE_KEY (copy it from your application's Home page in the Pisti console) or pass { publishableKey }.",
        );
    return key;
}

// Each environment is its own issuer with its own keys. The key set is discovered once per issuer and cached for the
// life of the process; jose refetches it when a token names a key it hasn't seen, so key rotation needs no restart.
function signingKeys(issuer: URL, development: boolean): Promise<JWTVerifyGetKey> {
    let keys = keySets.get(issuer.href);
    if (!keys) {
        keys = discoverKeys(issuer, development).catch((error) => {
            keySets.delete(issuer.href);
            throw error;
        });
        keySets.set(issuer.href, keys);
    }
    return keys;
}

async function discoverKeys(issuer: URL, development: boolean): Promise<JWTVerifyGetKey> {
    const discovery = new URL(`${issuer.href}/.well-known/openid-configuration`);
    let metadata: { issuer?: unknown; jwks_uri?: unknown };
    try {
        const response = await fetch(discovery, { signal: AbortSignal.timeout(10_000), redirect: "error" });
        if (!response.ok) throw new Error(String(response.status));
        metadata = (await response.json()) as typeof metadata;
    } catch {
        throw new PistiError(503, "Pisti's signing keys could not be loaded. Try again shortly.", "service_unavailable");
    }
    if (metadata.issuer !== issuer.href || typeof metadata.jwks_uri !== "string")
        throw new PistiError(503, "Pisti's discovery document does not match the publishable key.", "service_unavailable");
    const jwks = trustedUrl(metadata.jwks_uri, development);
    if (!jwks.href.startsWith(`${issuer.href}/`))
        throw new PistiError(503, "Pisti's signing keys must come from this environment's issuer.", "service_unavailable");
    return createRemoteJWKSet(jwks, { timeoutDuration: 10_000, cooldownDuration: 30_000 });
}

// With a PEM key (jwtKey / PISTI_JWT_KEY) verification never touches the network.
function verificationKey(key: PublishableKeyInfo, jwtKey: string | undefined): Promise<JWTVerifyGetKey | CryptoKey> {
    const pem = jwtKey ?? process.env.PISTI_JWT_KEY;
    if (!pem) return signingKeys(key.issuer, key.environment === "test");
    let imported = pemKeys.get(pem);
    if (!imported) {
        // Environment variables often carry the PEM on one line with literal \n.
        imported = importSPKI(pem.replaceAll("\\n", "\n"), "RS256").catch(() => {
            pemKeys.delete(pem);
            throw new Error("The JWT key is not a valid PEM public key. Copy it from API keys in the Pisti console.");
        });
        pemKeys.set(pem, imported);
    }
    return imported;
}

/** Verifies any Pisti-signed JWT for this environment and returns its payload. */
async function verifyJwt(token: string, key: PublishableKeyInfo, options: VerifyTokenOptions, kind: string): Promise<JWTPayload> {
    if (!token || token.length > 16_384) throw new PistiError(401, `The ${kind} is missing or too large.`, "invalid_token");
    const verifier = await verificationKey(key, options.jwtKey);
    let payload: JWTPayload;
    try {
        const verifyOptions = { issuer: key.issuer.href, algorithms: ["RS256"], clockTolerance: 5, requiredClaims: ["exp", "iat"] };
        ({ payload } =
            typeof verifier === "function"
                ? await jwtVerify(token, verifier, verifyOptions)
                : await jwtVerify(token, verifier, verifyOptions));
    } catch (error) {
        if (error instanceof PistiError) throw error;
        if (error instanceof joseErrors.JWTExpired) throw new PistiError(401, `The ${kind} has expired.`, "token_expired");
        throw new PistiError(401, `The ${kind} is invalid.`, "invalid_token");
    }
    if (payload.fid !== key.frontendApiId) throw new PistiError(401, `The ${kind} belongs to another environment.`, "invalid_token");
    return payload;
}

function authorizedParties(options: VerifyTokenOptions, development: boolean): string[] | undefined {
    return (
        options.authorizedParties ??
        process.env.PISTI_AUTHORIZED_PARTIES?.split(",")
            .map((value) => value.trim())
            .filter(Boolean)
    )?.map((origin) => trustedUrl(origin, development).origin);
}

/**
 * Verifies a session token and returns its claims. Throws `PistiError` (401) when the token is
 * invalid, expired (`code: "token_expired"`), or belongs to another environment.
 */
export async function verifyToken(token: string, options: VerifyTokenOptions = {}): Promise<SessionClaims> {
    const key = parsePublishableKey(publishableKeyFrom(options.publishableKey));
    const parties = authorizedParties(options, key.environment === "test");
    const payload = await verifyJwt(token, key, options, "session token");
    if (payload.ptyp !== "session" || typeof payload.sub !== "string" || typeof payload.sid !== "string")
        throw new PistiError(401, "This is not a session token.", "invalid_token");
    if (parties && (typeof payload.azp !== "string" || !parties.includes(payload.azp)))
        throw new PistiError(401, "The session token was issued to an unexpected origin.", "invalid_token");
    return payload as SessionClaims;
}

export const signedOutAuthObject: SignedOutAuthObject = Object.freeze({
    isAuthenticated: false,
    tokenType: "session_token",
    userId: null,
    sessionId: null,
    sessionStatus: null,
    sessionClaims: null,
    orgId: null,
    orgSlug: null,
    orgRole: null,
    orgPermissions: null,
    factorVerificationAge: null,
    has: () => false,
    getToken: async () => null,
});

/** The signed-out auth object for a token type. */
export function unauthenticatedObject<T extends TokenType>(type: T): AuthObjectFor<T> {
    if (type === "session_token") return signedOutAuthObject as AuthObjectFor<T>;
    return Object.freeze({
        isAuthenticated: false,
        tokenType: type,
        id: null,
        subject: null,
        userId: null,
        scopes: null,
        claims: null,
        getToken: async () => null,
    }) as unknown as AuthObjectFor<T>;
}

// Clerk's presets. "second_factor" falls back to the first factor for users without one.
const presets = {
    strict_mfa: { level: "multi_factor", afterMinutes: 10 },
    strict: { level: "second_factor", afterMinutes: 10 },
    moderate: { level: "second_factor", afterMinutes: 60 },
    lax: { level: "second_factor", afterMinutes: 1440 },
} as const;

/** Builds the auth object for verified session claims. */
export function authObject(claims: SessionClaims, token: string): AuthObject {
    const permissions = Array.isArray(claims.org_permissions)
        ? claims.org_permissions.filter((value): value is string => typeof value === "string")
        : typeof claims.org_permissions === "string"
          ? [claims.org_permissions]
          : null;
    const now = Date.now() / 1000;
    const age = (time: unknown) => (typeof time === "number" ? Math.floor((now - time) / 60) : -1);
    const factorVerificationAge: [number, number] = [age(claims.auth_time), age(claims.mfa_authenticated_at)];
    const orgRole = typeof claims.org_role === "string" ? claims.org_role : null;
    const has = ({ permission, role, reverification }: CheckAuthorizationParams): boolean => {
        if (permission && !permissions?.includes(permission)) return false;
        if (role && orgRole !== role) return false;
        if (reverification) {
            const { level, afterMinutes } = typeof reverification === "string" ? presets[reverification] : reverification;
            const [first, second] = factorVerificationAge;
            const fresh = (minutes: number) => minutes >= 0 && minutes <= afterMinutes;
            if (level === "first_factor" && !fresh(first)) return false;
            // Sign-in enforces enrolled authenticators, so a session without one never had a second factor.
            if (level === "second_factor" && !(second < 0 ? fresh(first) : fresh(second))) return false;
            if (level === "multi_factor" && !(fresh(first) && fresh(second))) return false;
        }
        return Boolean(permission || role || reverification);
    };
    return Object.freeze({
        isAuthenticated: true,
        tokenType: "session_token",
        userId: claims.sub,
        sessionId: claims.sid,
        sessionStatus: "active",
        sessionClaims: Object.freeze({ ...claims }),
        orgId: typeof claims.org_id === "string" ? claims.org_id : null,
        orgSlug: typeof claims.org_slug === "string" ? claims.org_slug : null,
        orgRole,
        orgPermissions: permissions,
        factorVerificationAge,
        has,
        getToken: async () => token,
    });
}

function scopesOf(payload: JWTPayload): string[] {
    return typeof payload.scope === "string" ? payload.scope.split(" ").filter(Boolean) : [];
}

/** Verifies an OAuth access token or M2M token offline. */
async function verifyMachineJwt(
    token: string,
    type: "oauth_token" | "m2m_token",
    key: PublishableKeyInfo,
    options: VerifyTokenOptions,
): Promise<AuthenticatedOAuthToken | AuthenticatedM2MToken> {
    const payload = await verifyJwt(token, key, options, type === "m2m_token" ? "machine token" : "OAuth access token");
    if (payload.ptyp !== (type === "m2m_token" ? "m2m" : "oauth") || typeof payload.sub !== "string")
        throw new PistiError(401, "The token type doesn't match.", "invalid_token");
    const claims = Object.freeze({ ...payload });
    const id = typeof payload.jti === "string" ? payload.jti : null;
    if (type === "m2m_token")
        return Object.freeze({
            isAuthenticated: true,
            tokenType: "m2m_token",
            id,
            subject: payload.sub,
            machineId: payload.sub,
            scopes: scopesOf(payload),
            claims,
            getToken: async () => token,
        });
    return Object.freeze({
        isAuthenticated: true,
        tokenType: "oauth_token",
        id,
        subject: payload.sub,
        userId: payload.sub,
        clientId: typeof payload.client_id === "string" ? payload.client_id : null,
        scopes: scopesOf(payload),
        claims,
        getToken: async () => token,
    });
}

const clients = new Map<string, PistiClient>();
// Verified API keys are reused briefly, so a busy API does not call Pisti on every request. A revoked key can keep
// working in each process for up to this long.
const API_KEY_CACHE_MS = 10_000;
const API_KEY_CACHE_LIMIT = 1_000;
const verifiedApiKeys = new Map<string, { key: AuthenticatedApiKey; expiresAt: number }>();

/** Verifies an end user's API key with the backend API, reusing a recent verification. */
async function verifyApiKey(token: string, options: AuthenticateRequestOptions, publishableKey: string): Promise<AuthenticatedApiKey> {
    const secretKey = options.secretKey ?? process.env.PISTI_SECRET_KEY;
    if (!secretKey) throw new Error("Verifying API keys needs your secret key. Set PISTI_SECRET_KEY or pass { secretKey }.");
    // Keyed by a digest, so the cache never holds the presented secrets themselves.
    const verification = createHash("sha256").update(`${secretKey}\n${publishableKey}\n${token}`).digest("base64url");
    const cached = verifiedApiKeys.get(verification);
    if (cached && cached.expiresAt > Date.now()) return cached.key;
    verifiedApiKeys.delete(verification);
    // Imported lazily: the management client itself depends on this module.
    const { createPistiClient, PistiManagementError } = await import("./management.js");
    const cacheKey = `${secretKey}\n${publishableKey}`;
    let client = clients.get(cacheKey);
    if (!client) {
        client = createPistiClient({ secretKey, publishableKey });
        clients.set(cacheKey, client);
    }
    try {
        const key = await client.apiKeys.verifySecret(token);
        const authenticated: AuthenticatedApiKey = Object.freeze({
            isAuthenticated: true,
            tokenType: "api_key",
            id: key.id,
            name: key.name,
            subject: key.subject,
            userId: key.userId,
            scopes: key.scopes,
            claims: key.claims,
            getToken: async () => token,
        });
        const expiresAt = Math.min(Date.now() + API_KEY_CACHE_MS, key.expiresAt ? Date.parse(key.expiresAt) : Infinity);
        if (verifiedApiKeys.size >= API_KEY_CACHE_LIMIT) {
            for (const [entry, value] of verifiedApiKeys) if (value.expiresAt <= Date.now()) verifiedApiKeys.delete(entry);
            // Maps iterate in insertion order, so the first entry is the oldest.
            const oldest = verifiedApiKeys.keys().next();
            if (verifiedApiKeys.size >= API_KEY_CACHE_LIMIT && !oldest.done) verifiedApiKeys.delete(oldest.value);
        }
        verifiedApiKeys.set(verification, { key: authenticated, expiresAt });
        return authenticated;
    } catch (error) {
        if (error instanceof PistiManagementError && (error.status === 401 || error.status === 404))
            throw new PistiError(401, "The API key is invalid, expired or revoked.", "invalid_token");
        throw error;
    }
}

/** Which token type a bearer value looks like, without verifying it. */
function classify(token: string): TokenType | null {
    if (token.startsWith("ak_")) return "api_key";
    try {
        const ptyp = decodeJwt(token).ptyp;
        return ptyp === "session" ? "session_token" : ptyp === "oauth" ? "oauth_token" : ptyp === "m2m" ? "m2m_token" : null;
    } catch {
        return null;
    }
}

/** The token types an `acceptsToken` value allows. */
export function acceptedTokenTypes(acceptsToken: AcceptsToken | undefined): readonly TokenType[] {
    const value = acceptsToken ?? "session_token";
    if (value === "any") return ["session_token", "api_key", "m2m_token", "oauth_token"];
    return typeof value === "string" ? [value as TokenType] : value;
}

/** Reads one cookie from a Cookie header. */
export function readCookie(header: string | null | undefined, name: string): string | undefined {
    if (!header) return undefined;
    for (const part of header.split(";")) {
        const separator = part.indexOf("=");
        if (separator > 0 && part.slice(0, separator).trim() === name) {
            try {
                return decodeURIComponent(part.slice(separator + 1).trim());
            } catch {
                return undefined;
            }
        }
    }
    return undefined;
}

/** Reads the session token from an `Authorization: Bearer` header or the `__session` cookie. */
export function tokenFrom(
    headers: { authorization?: string | null; cookie?: string | null },
    cookieName = SESSION_COOKIE,
): { token: string | null; fromHeader: boolean } {
    const authorization = headers.authorization;
    if (authorization?.startsWith("Bearer ")) return { token: authorization.slice(7).trim(), fromHeader: true };
    return { token: readCookie(headers.cookie, cookieName) ?? null, fromHeader: false };
}

function isDocumentRequest(request: Request): boolean {
    if (request.method !== "GET") return false;
    const destination = request.headers.get("sec-fetch-dest");
    if (destination) return destination === "document";
    return (request.headers.get("accept") ?? "").includes("text/html");
}

function state<T extends AnyAuthObject>(
    status: RequestState["status"],
    auth: T,
    details: { reason?: string; message?: string; token?: string; headers?: Headers } = {},
): RequestState<T> {
    return {
        isAuthenticated: auth.isAuthenticated,
        status,
        reason: details.reason ?? null,
        message: details.message ?? null,
        token: details.token ?? null,
        tokenType: auth.isAuthenticated ? auth.tokenType : null,
        headers: details.headers ?? new Headers(),
        toAuth: () => auth,
    };
}

function cookie(name: string, value: string, maxAge: number, secure: boolean): string {
    return `${name}=${value}; Path=/; Max-Age=${maxAge}; SameSite=Lax${secure ? "; Secure" : ""}`;
}

/** Sends the browser through the Frontend API to refresh an expired session cookie, like Clerk's handshake. */
function startHandshake(request: Request, url: URL, key: PublishableKeyInfo, reason: string): RequestState<AuthObject> {
    const loops = Number(readCookie(request.headers.get("cookie"), REDIRECT_LOOP_COOKIE) ?? 0) || 0;
    if (loops >= 3)
        return state("signed-out", signedOutAuthObject, {
            reason: "handshake-loop",
            message: "The session couldn't be refreshed. Check that this origin is allowed under Domains in the Pisti console.",
        });
    const target = new URL(`${key.frontendApi.href.replace(/\/$/, "")}/handshake`);
    target.searchParams.set("redirect_url", url.href);
    const headers = new Headers({ Location: target.href, "Cache-Control": "no-store" });
    headers.append("Set-Cookie", cookie(REDIRECT_LOOP_COOKIE, String(loops + 1), 5, url.protocol === "https:"));
    return state("handshake", signedOutAuthObject, { reason, message: "Refreshing the session cookie.", headers });
}

/** Turns a returned handshake into cookies and a redirect to the clean URL. */
async function completeHandshake(
    handshake: string,
    url: URL,
    key: PublishableKeyInfo,
    options: VerifyTokenOptions,
): Promise<RequestState<AuthObject>> {
    let payload: JWTPayload;
    try {
        payload = await verifyJwt(handshake, key, options, "handshake");
    } catch (error) {
        if (!(error instanceof PistiError)) throw error;
        return state("signed-out", signedOutAuthObject, { reason: "handshake-invalid", message: error.message });
    }
    if (payload.ptyp !== "handshake" || payload.azp !== url.origin || typeof payload.client_uat !== "number")
        return state("signed-out", signedOutAuthObject, { reason: "handshake-invalid", message: "The handshake is for another app." });
    const secure = url.protocol === "https:";
    const clean = new URL(url);
    clean.searchParams.delete(HANDSHAKE_PARAMETER);
    const headers = new Headers({ Location: clean.href, "Cache-Control": "no-store" });
    const session = typeof payload.session_token === "string" ? payload.session_token : null;
    headers.append("Set-Cookie", session ? cookie(SESSION_COOKIE, session, 60, secure) : cookie(SESSION_COOKIE, "", 0, secure));
    headers.append("Set-Cookie", cookie(CLIENT_UAT_COOKIE, String(Math.trunc(payload.client_uat)), 31_536_000, secure));
    headers.append("Set-Cookie", cookie(REDIRECT_LOOP_COOKIE, "", 0, secure));
    return state("handshake", signedOutAuthObject, { reason: "handshake-complete", message: "The session cookie was refreshed.", headers });
}

/**
 * Authenticates a Fetch API `Request` (Next.js route handlers, Hono, Bun, Deno, Workers), like
 * Clerk's `authenticateRequest`. It never throws for a missing or bad token.
 *
 * - `status: "signed-in"` or `"signed-out"`: use `toAuth()`.
 * - `status: "handshake"`: the session cookie expired on a page load. Respond with
 *   `new Response(null, { status: 307, headers: state.headers })`; the browser returns with a
 *   fresh cookie.
 *
 * Bearer tokens may be session tokens, OAuth access tokens, M2M tokens or API keys; `acceptsToken`
 * (default `"session_token"`) chooses which are allowed.
 */
export async function authenticateRequest<T extends AcceptsToken = "session_token">(
    request: Request,
    options: AuthenticateRequestOptions & { acceptsToken?: T } = {},
): Promise<RequestState<AuthObjectFor<T>>> {
    type Result = RequestState<AuthObjectFor<T>>;
    const publishableKey = publishableKeyFrom(options.publishableKey);
    const key = parsePublishableKey(publishableKey);
    const types = acceptedTokenTypes(options.acceptsToken);
    const fallback = unauthenticatedObject(types[0] ?? "session_token");
    const url = new URL(request.url);
    const authorization = request.headers.get("authorization");

    const handshake = url.searchParams.get(HANDSHAKE_PARAMETER);
    if (handshake && types.includes("session_token")) return (await completeHandshake(handshake, url, key, options)) as Result;

    if (authorization?.startsWith("Bearer ")) {
        const token = authorization.slice(7).trim();
        const type = classify(token);
        if (!type) return state("signed-out", fallback, { reason: "token-invalid", message: "The bearer token isn't a Pisti token." }) as Result;
        if (!types.includes(type))
            return state("signed-out", fallback, { reason: "token-type-mismatch", message: `This endpoint doesn't accept ${type} tokens.` }) as Result;
        try {
            const auth =
                type === "session_token"
                    ? authObject(await verifyToken(token, options), token)
                    : type === "api_key"
                      ? await verifyApiKey(token, options, publishableKey)
                      : await verifyMachineJwt(token, type, key, options);
            return state("signed-in", auth, { token }) as Result;
        } catch (error) {
            if (error instanceof PistiError && error.status === 401)
                return state("signed-out", unauthenticatedObject(type), { reason: "token-invalid", message: error.message }) as Result;
            throw error;
        }
    }

    if (!types.includes("session_token"))
        return state("signed-out", fallback, { reason: "token-missing", message: "No token in the request." }) as Result;
    const cookies = request.headers.get("cookie");
    const session = readCookie(cookies, options.cookieName ?? SESSION_COOKIE);
    const uatValue = readCookie(cookies, CLIENT_UAT_COOKIE);
    const uat = uatValue === undefined ? undefined : Number(uatValue) || 0;
    const document = isDocumentRequest(request);
    // Only page loads can take the handshake redirect; API calls are refreshed by the browser SDK.
    const refresh = (reason: string, message: string): Result =>
        (document ? startHandshake(request, url, key, reason) : state("signed-out", signedOutAuthObject, { reason, message })) as Result;

    if (!session) {
        if (uat !== undefined && uat > 0) return refresh("client-uat-without-session-token", "The session cookie is missing.");
        return state("signed-out", signedOutAuthObject, { reason: "session-token-missing", message: "No session token in the request." }) as Result;
    }
    if (uat === 0) return state("signed-out", signedOutAuthObject, { reason: "client-signed-out", message: "The browser signed out." }) as Result;
    try {
        const claims = await verifyToken(session, options);
        if (uat !== undefined && claims.iat < uat) return refresh("session-token-outdated", "The session cookie predates the latest sign-in.");
        return state("signed-in", authObject(claims, session), { token: session }) as Result;
    } catch (error) {
        if (!(error instanceof PistiError) || error.status !== 401) throw error;
        if (error.code === "token_expired") return refresh("session-token-expired", error.message);
        return state("signed-out", signedOutAuthObject, { reason: "session-token-invalid", message: error.message }) as Result;
    }
}
