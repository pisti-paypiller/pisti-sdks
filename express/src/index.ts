import { randomUUID } from "node:crypto";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import {
    PistiError,
    acceptedTokenTypes,
    authenticateRequest,
    createPistiClient,
    signedOutAuthObject,
    unauthenticatedObject,
    type AcceptsToken,
    type AnyAuthObject,
    type AuthObject,
    type AuthObjectFor,
    type CheckAuthorizationParams,
    type PistiClient,
    type TokenType,
} from "@pisti-paypiller/backend";

declare global {
    // eslint-disable-next-line @typescript-eslint/no-namespace
    namespace Express {
        interface Request {
            /** Set by pistiMiddleware(). Prefer getAuth(req). */
            auth?: AnyAuthObject;
        }
    }
}

export interface PistiMiddlewareOptions {
    /** Defaults to `PISTI_PUBLISHABLE_KEY`. */
    publishableKey?: string | undefined;
    /** Verifies end users' API keys. Defaults to `PISTI_SECRET_KEY`. */
    secretKey?: string | undefined;
    /** Origins allowed to have requested the token. Defaults to `PISTI_AUTHORIZED_PARTIES` (comma-separated). */
    authorizedParties?: string[] | undefined;
    /** PEM public key for networkless verification. Defaults to `PISTI_JWT_KEY`. */
    jwtKey?: string | undefined;
    /** Session cookie written by @pisti-paypiller/react. Defaults to `__session`. */
    cookieName?: string | undefined;
}

// Why a request's credential failed, kept for requireAuth: the middleware itself never rejects a request, so
// public routes keep working whatever credential a client sends, and a route reports a failure only for a
// token type it accepts.
const failures = new WeakMap<Request, { error: unknown; tokenType: TokenType }>();

/** The kind of credential a request carries, without verifying it. */
function credentialType(req: Request): TokenType {
    const authorization = req.headers.authorization;
    if (!authorization?.startsWith("Bearer ")) return "session_token";
    const token = authorization.slice(7).trim();
    if (token.startsWith("ak_")) return "api_key";
    try {
        const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as { ptyp?: unknown };
        return payload.ptyp === "oauth" ? "oauth_token" : payload.ptyp === "m2m" ? "m2m_token" : "session_token";
    } catch {
        return "session_token";
    }
}

function absoluteUrl(req: Request): string {
    return `${req.protocol}://${req.get("host")}${req.originalUrl}`;
}

function fetchRequest(req: Request): globalThis.Request {
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
        if (typeof value === "string") headers.set(name, value);
        else if (Array.isArray(value)) for (const each of value) headers.append(name, each);
    }
    return new globalThis.Request(absoluteUrl(req), { method: req.method === "HEAD" ? "GET" : req.method, headers });
}

/**
 * Like Clerk's `clerkMiddleware()`: verifies the session token from the `__session` cookie or an
 * `Authorization: Bearer` header offline and sets `req.auth`. Bearer API keys, OAuth access tokens
 * and M2M tokens are verified too; routes choose what they accept with `getAuth(req, { acceptsToken })`.
 *
 * When a page request arrives with an expired session cookie, it answers with Clerk's handshake:
 * a redirect through Pisti that refreshes the cookie and returns to the same URL. Server-rendered
 * pages therefore never see a signed-in visitor as signed out.
 *
 * With no options it reads `PISTI_PUBLISHABLE_KEY`, `PISTI_SECRET_KEY`, `PISTI_JWT_KEY` and
 * `PISTI_AUTHORIZED_PARTIES`.
 */
export function pistiMiddleware(options: PistiMiddlewareOptions = {}): RequestHandler {
    // Fail at startup, not on the first request, when the key is missing or malformed.
    createPistiClient(options.publishableKey ? { publishableKey: options.publishableKey } : {});
    return async (req: Request, res: Response, next: NextFunction) => {
        try {
            const state = await authenticateRequest(fetchRequest(req), { ...options, acceptsToken: "any" });
            if (state.status === "handshake") {
                for (const value of state.headers.getSetCookie()) res.append("Set-Cookie", value);
                res.setHeader("Cache-Control", "no-store");
                res.redirect(307, state.headers.get("Location")!);
                return;
            }
            // A bad cookie is normal between refreshes; a bad bearer token is reported by routes that require auth.
            if (state.reason === "token-invalid" && req.headers.authorization?.startsWith("Bearer "))
                failures.set(req, {
                    error: new PistiError(401, state.message ?? "The token is invalid.", "invalid_token"),
                    tokenType: credentialType(req),
                });
            req.auth = state.toAuth();
            next();
        } catch (error) {
            // Verification could not run (Pisti unreachable, or API keys without a secret key). Public routes still
            // work; routes that require auth answer 503.
            failures.set(req, { error, tokenType: credentialType(req) });
            req.auth = signedOutAuthObject;
            next();
        }
    };
}

/**
 * The request's auth object, like Clerk's `getAuth(req)`. By default only session tokens count;
 * pass `acceptsToken` to allow API keys (`"api_key"`), M2M tokens, OAuth access tokens or `"any"`.
 */
export function getAuth(req: Request): AuthObject;
export function getAuth<T extends AcceptsToken>(req: Request, options: { acceptsToken: T }): AuthObjectFor<T>;
export function getAuth(req: Request, options?: { acceptsToken: AcceptsToken }): AnyAuthObject {
    if (!req.auth) throw new Error("Add app.use(pistiMiddleware()) before routes that call getAuth(req).");
    const types = acceptedTokenTypes(options?.acceptsToken);
    return types.includes(req.auth.tokenType) ? req.auth : unauthenticatedObject(types[0] ?? "session_token");
}

export interface RequireAuthOptions extends CheckAuthorizationParams {
    /**
     * Where to send signed-out browsers instead of answering 401. Defaults to `PISTI_SIGN_IN_URL`
     * for requests that accept HTML. The current URL is appended as `redirect_url`.
     */
    signInUrl?: string | undefined;
    /** Which tokens may call the route. Defaults to "session_token". */
    acceptsToken?: AcceptsToken | undefined;
}

/**
 * Protects a route. Signed-out requests get 401 JSON, or a redirect to the sign-in page for
 * browser navigations. Optional `permission`, `role` and `reverification` checks answer 403.
 */
export function requireAuth(options: RequireAuthOptions = {}): RequestHandler {
    return (req, res, next) => {
        const acceptsToken = options.acceptsToken ?? "session_token";
        const auth = getAuth(req, { acceptsToken });
        const failure = failures.get(req);
        if (!auth.isAuthenticated && failure && acceptedTokenTypes(acceptsToken).includes(failure.tokenType))
            return sendProblem(req, res, failure.error);
        if (!auth.isAuthenticated) {
            const signInUrl = options.signInUrl ?? process.env.PISTI_SIGN_IN_URL;
            if (signInUrl && req.method === "GET" && req.accepts(["html", "json"]) === "html") {
                const origin = `${req.protocol}://${req.get("host")}`;
                const target = new URL(signInUrl, origin);
                target.searchParams.set("redirect_url", new URL(req.originalUrl, origin).href);
                return res.redirect(307, target.origin === origin ? target.pathname + target.search : target.href);
            }
            return sendProblem(req, res, new PistiError(401, "Sign in to continue.", "signed_out"));
        }
        const { permission, role, reverification } = options;
        if (auth.tokenType === "session_token") {
            if ((permission || role) && !auth.has({ permission, role }))
                return sendProblem(req, res, new PistiError(403, "You don’t have permission to do this.", "forbidden"));
            if (reverification && !auth.has({ reverification }))
                return sendProblem(req, res, new PistiError(403, "Confirm it’s you to continue.", "reverification_required"));
        } else if (permission || role || reverification)
            return sendProblem(req, res, new PistiError(403, "This route needs a signed-in user.", "forbidden"));
        next();
    };
}

let shared: PistiClient | undefined;

/**
 * A ready-to-use backend client, like Clerk's `clerkClient`, created on first use from
 * `PISTI_SECRET_KEY` and `PISTI_PUBLISHABLE_KEY`: `await pistiClient.users.getUser(userId)`.
 */
export const pistiClient: PistiClient = new Proxy({} as PistiClient, {
    get(_target, property) {
        shared ??= createPistiClient();
        const value: unknown = Reflect.get(shared, property, shared);
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(shared) : value;
    },
});

function sendProblem(req: Request, res: Response, error: unknown): void {
    const status = error instanceof PistiError ? error.status : 503;
    const requestId = randomUUID();
    res.setHeader("X-Request-ID", requestId);
    res.setHeader("Cache-Control", "no-store");
    if (status === 401) res.setHeader("WWW-Authenticate", "Bearer");
    res.status(status)
        .type("application/problem+json")
        .json({
            type: "about:blank",
            status,
            title: status === 401 ? "Unauthorized" : status === 403 ? "Forbidden" : "Service Unavailable",
            detail: error instanceof PistiError ? error.message : "Authentication is temporarily unavailable.",
            instance: req.path,
            requestId,
            ...(error instanceof PistiError && error.code ? { code: error.code } : {}),
        });
}

export { createPistiClient, verifyToken, PistiError, PistiManagementError } from "@pisti-paypiller/backend";
export type {
    AuthObject,
    SignedInAuthObject,
    SignedOutAuthObject,
    SessionClaims,
    CheckAuthorizationParams,
    PistiClient,
    PistiWebhookEvent,
    TokenType,
    AcceptsToken,
    AnyAuthObject,
    AuthObjectFor,
    ApiKeyAuthObject,
    M2MAuthObject,
    OAuthAuthObject,
} from "@pisti-paypiller/backend";
