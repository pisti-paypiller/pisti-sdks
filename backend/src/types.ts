/** The verified claims of a Pisti session token. */
export interface SessionClaims {
    /** The user's ID. */
    sub: string;
    /** The session's ID. */
    sid: string;
    iss: string;
    aud: string | string[];
    exp: number;
    iat: number;
    nbf?: number;
    /** The origin the token was issued to. */
    azp?: string;
    instance_id: string;
    /** The environment's Frontend API id. */
    fid: string;
    /** Present only when the environment includes profile claims in session tokens (console → Settings). */
    email?: string;
    /** Present only when the environment includes profile claims in session tokens (console → Settings). */
    name?: string;
    auth_time?: number;
    mfa_authenticated_at?: number;
    org_id?: string;
    org_slug?: string;
    org_role?: string;
    org_permissions?: string[];
    [claim: string]: unknown;
}

export type ReverificationLevel = "first_factor" | "second_factor" | "multi_factor";

export interface CheckAuthorizationParams {
    permission?: string | undefined;
    role?: string | undefined;
    /**
     * Require a recent verification, like Clerk: "strict_mfa" (both factors within 10 minutes),
     * "strict" (second factor, or the first for users without one, within 10 minutes), "moderate"
     * (60 minutes), "lax" (a day), or `{ level, afterMinutes }`.
     */
    reverification?:
        | "strict_mfa"
        | "strict"
        | "moderate"
        | "lax"
        | { level: ReverificationLevel; afterMinutes: number }
        | undefined;
}

interface AuthObjectBase {
    tokenType: "session_token";
    /** True when the active organization grants this permission or role, or the sign-in is recent enough. */
    has(params: CheckAuthorizationParams): boolean;
    /** The raw session token, for forwarding to another service. */
    getToken(): Promise<string | null>;
}

export interface SignedInAuthObject extends AuthObjectBase {
    isAuthenticated: true;
    userId: string;
    sessionId: string;
    sessionStatus: "active";
    sessionClaims: SessionClaims;
    /** The active organization, or null for the user's personal account. */
    orgId: string | null;
    orgSlug: string | null;
    orgRole: string | null;
    orgPermissions: string[] | null;
    /** Minutes since the first and second factor were verified; -1 when never in this session. */
    factorVerificationAge: [number, number];
}

export interface SignedOutAuthObject extends AuthObjectBase {
    isAuthenticated: false;
    userId: null;
    sessionId: null;
    sessionStatus: null;
    sessionClaims: null;
    orgId: null;
    orgSlug: null;
    orgRole: null;
    orgPermissions: null;
    factorVerificationAge: null;
}

/** Who is making a request. Narrow it with `isAuthenticated`. */
export type AuthObject = SignedInAuthObject | SignedOutAuthObject;

/** The kinds of token a request can carry, like Clerk's `acceptsToken`. */
export type TokenType = "session_token" | "api_key" | "m2m_token" | "oauth_token";
export type AcceptsToken = TokenType | readonly TokenType[] | "any";

/** An end user's API key, verified with the backend API (needs the secret key). */
export interface AuthenticatedApiKey {
    isAuthenticated: true;
    tokenType: "api_key";
    id: string;
    name: string;
    /** The user who owns the key. */
    subject: string;
    userId: string;
    scopes: string[];
    claims: Record<string, unknown> | null;
    getToken(): Promise<string>;
}

/** A machine-to-machine token from a confidential OAuth application's client credentials. */
export interface AuthenticatedM2MToken {
    isAuthenticated: true;
    tokenType: "m2m_token";
    id: string | null;
    /** The OAuth application's client ID. */
    subject: string;
    machineId: string;
    scopes: string[];
    claims: Record<string, unknown>;
    getToken(): Promise<string>;
}

/** An OAuth access token Pisti issued to an OAuth application on a user's behalf. */
export interface AuthenticatedOAuthToken {
    isAuthenticated: true;
    tokenType: "oauth_token";
    id: string | null;
    subject: string;
    userId: string;
    clientId: string | null;
    scopes: string[];
    claims: Record<string, unknown>;
    getToken(): Promise<string>;
}

export interface UnauthenticatedMachineObject<T extends Exclude<TokenType, "session_token">> {
    isAuthenticated: false;
    tokenType: T;
    id: null;
    subject: null;
    userId: null;
    scopes: null;
    claims: null;
    getToken(): Promise<null>;
}

export type ApiKeyAuthObject = AuthenticatedApiKey | UnauthenticatedMachineObject<"api_key">;
export type M2MAuthObject = AuthenticatedM2MToken | UnauthenticatedMachineObject<"m2m_token">;
export type OAuthAuthObject = AuthenticatedOAuthToken | UnauthenticatedMachineObject<"oauth_token">;
/** Any auth object; narrow it with `tokenType` and `isAuthenticated`. */
export type AnyAuthObject = AuthObject | ApiKeyAuthObject | M2MAuthObject | OAuthAuthObject;

type AuthObjectOf<T extends TokenType> = T extends "session_token"
    ? AuthObject
    : T extends "api_key"
      ? ApiKeyAuthObject
      : T extends "m2m_token"
        ? M2MAuthObject
        : OAuthAuthObject;

/** The auth object a given `acceptsToken` can produce. */
export type AuthObjectFor<T extends AcceptsToken> = T extends "any"
    ? AnyAuthObject
    : T extends readonly TokenType[]
      ? AuthObjectOf<T[number]>
      : T extends TokenType
        ? AuthObjectOf<T>
        : never;

export interface RequestState<T extends AnyAuthObject = AnyAuthObject> {
    isAuthenticated: boolean;
    /**
     * "handshake" means the session cookie expired on a page request: send the response described by
     * `headers` (a redirect through Pisti that refreshes the cookie) instead of rendering.
     */
    status: "signed-in" | "signed-out" | "handshake";
    /** Why the request is signed out or needs a handshake, for logging; null when signed in. */
    reason: string | null;
    message: string | null;
    token: string | null;
    tokenType: TokenType | null;
    /** Headers to send: `Location` and `Set-Cookie` during a handshake. */
    headers: Headers;
    toAuth(): T;
}

export interface VerifyTokenOptions {
    /** Defaults to `PISTI_PUBLISHABLE_KEY`. */
    publishableKey?: string | undefined;
    /** Origins allowed to have requested the token (`azp`). Defaults to `PISTI_AUTHORIZED_PARTIES` (comma-separated). */
    authorizedParties?: string[] | undefined;
    /**
     * The PEM public key from the console (API keys → JWT public key) or `client.getInstance()`.
     * Verifies tokens without fetching signing keys. Defaults to `PISTI_JWT_KEY`. While a rotation
     * is under way, put the current and the next key (`nextJwtKey`) one after the other.
     */
    jwtKey?: string | undefined;
}

export interface AuthenticateRequestOptions extends VerifyTokenOptions {
    /** Which tokens to accept. Defaults to "session_token". */
    acceptsToken?: AcceptsToken | undefined;
    /** Verifies API keys. Defaults to `PISTI_SECRET_KEY`. */
    secretKey?: string | undefined;
    /** The Pisti management API, which verifies API keys and redeems handshakes. Defaults to `PISTI_API_URL`, else
     * `https://pisti-api.paypiller.com`. */
    apiUrl?: string | undefined;
    /** Cookie the React SDK writes. Defaults to `__session`. */
    cookieName?: string | undefined;
}
