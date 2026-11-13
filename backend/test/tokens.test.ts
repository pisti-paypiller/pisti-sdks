import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { PistiError } from "../src/errors.js";
import { authenticateRequest, authObject, HANDSHAKE_PARAMETER, verifyToken } from "../src/tokens.js";
import type { SessionClaims } from "../src/types.js";
import { API_ORIGIN, APP_ORIGIN, HOST_ORIGIN, KINDS, publishableKey, sessionClaims, sign, signingKey, type SigningKey } from "./support.js";

let key: SigningKey;
let otherKey: SigningKey;

beforeAll(async () => {
    key = await signingKey();
    otherKey = await signingKey();
});

const SECRET_KEY = `sk_test_${"a".repeat(16)}.${"b".repeat(64)}`;
const options = () => ({ publishableKey: publishableKey(), jwtKey: key.pem, authorizedParties: [APP_ORIGIN] });
const withSecretKey = () => ({ ...options(), secretKey: SECRET_KEY, apiUrl: API_ORIGIN });

afterEach(() => {
    vi.unstubAllGlobals();
});

/** Answers the SDK's handshake redemption, the only Pisti API call these tests make, and records what it was sent. */
function stubRedemption(status: number, data: unknown) {
    const calls: { url: string; body: unknown; authorization: string | null }[] = [];
    vi.stubGlobal("fetch", async (input: URL | string, init: RequestInit) => {
        calls.push({
            url: String(input),
            body: JSON.parse(String(init.body)),
            authorization: new Headers(init.headers).get("authorization"),
        });
        const body = status < 400 ? { data, meta: { requestId: "req_1" } } : { title: "Invalid", status, code: "invalid_handshake" };
        return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    });
    return calls;
}

async function rejection(promise: Promise<unknown>): Promise<PistiError> {
    const error = await promise.then(
        () => null,
        (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(PistiError);
    return error as PistiError;
}

describe("verifyToken", () => {
    it("returns the claims of a valid session token", async () => {
        const claims = await verifyToken(await sign(key, sessionClaims()), options());

        expect(claims.sub).toBe("user_1");
        expect(claims.sid).toBe("sess_1");
    });

    it("rejects a token signed by another key", async () => {
        const error = await rejection(verifyToken(await sign(otherKey, sessionClaims()), options()));
        expect(error.code).toBe("invalid_token");
    });

    it("reports an expired token distinctly", async () => {
        const token = await sign(key, sessionClaims(), { issuedAt: Math.floor(Date.now() / 1000) - 600, expiresInSeconds: 60 });
        const error = await rejection(verifyToken(token, options()));
        expect(error.code).toBe("token_expired");
    });

    it("rejects a token from another issuer", async () => {
        const token = await sign(key, sessionClaims(), { issuer: "http://other-env-34.pisti.localhost:3000/" });
        expect((await rejection(verifyToken(token, options()))).code).toBe("invalid_token");
    });

    it.each(["oauth", "m2m", "handshake", undefined])("rejects a token whose ptyp is %s", async (ptyp) => {
        const token = await sign(key, sessionClaims({ ptyp }));
        expect((await rejection(verifyToken(token, options()))).message).toMatch(/not a session token/);
    });

    it.each([
        ["an OAuth access token type", { type: KINDS.access.type }],
        ["the generic JWT type", { type: "JWT" }],
        ["the access token audience", { audience: KINDS.access.audience }],
    ])("rejects a session token with %s", async (_, kind) => {
        const token = await sign(key, sessionClaims(), kind);
        expect((await rejection(verifyToken(token, options()))).code).toBe("invalid_token");
    });

    it("rejects a token issued to an origin that is not an authorized party", async () => {
        const token = await sign(key, sessionClaims({ azp: "http://localhost:9999" }));
        expect((await rejection(verifyToken(token, options()))).message).toMatch(/unexpected origin/);
    });

    it("rejects a token signed with an algorithm the environment does not use", async () => {
        const rsa = await signingKey("RS256");
        const token = await sign(rsa, sessionClaims(), { algorithm: "RS256" });
        expect((await rejection(verifyToken(token, options()))).code).toBe("invalid_token");
    });

    it("accepts tokens of either key while the jwtKey holds the current and the next one", async () => {
        const jwtKey = `${otherKey.pem}
${key.pem}`;

        expect((await verifyToken(await sign(key, sessionClaims()), { ...options(), jwtKey })).sub).toBe("user_1");
        expect((await verifyToken(await sign(otherKey, sessionClaims()), { ...options(), jwtKey })).sub).toBe("user_1");
    });

    it("refuses a jwtKey without a PEM public key as a configuration error", async () => {
        await expect(verifyToken(await sign(key, sessionClaims()), { ...options(), jwtKey: "not a key" })).rejects.toThrow(/PEM/);
    });

    it("requires authorized parties for production keys", async () => {
        const live = { publishableKey: publishableKey("live"), jwtKey: key.pem };
        await expect(verifyToken(await sign(key, sessionClaims()), live)).rejects.toThrow(/authorized parties/);
    });

    it("rejects oversized and empty tokens before verifying them", async () => {
        expect((await rejection(verifyToken("", options()))).code).toBe("invalid_token");
        expect((await rejection(verifyToken("a".repeat(16_385), options()))).code).toBe("invalid_token");
    });
});

describe("authObject", () => {
    const minutesAgo = (minutes: number) => Math.floor(Date.now() / 1000) - minutes * 60;
    const claims = (overrides: Partial<SessionClaims> = {}) => ({ ...sessionClaims(), ...overrides }) as SessionClaims;

    it("checks organization permissions and roles", () => {
        const auth = authObject(claims({ org_id: "org_1", org_role: "admin", org_permissions: ["org:members:write"] }), "token");

        expect(auth.orgId).toBe("org_1");
        expect(auth.has({ permission: "org:members:write" })).toBe(true);
        expect(auth.has({ permission: "org:billing:write" })).toBe(false);
        expect(auth.has({ role: "admin" })).toBe(true);
        expect(auth.has({ role: "member" })).toBe(false);
        expect(auth.has({})).toBe(false);
    });

    it("requires a recent second factor for strict reverification", () => {
        const recent = authObject(claims({ auth_time: minutesAgo(1), mfa_authenticated_at: minutesAgo(1) }), "token");
        const stale = authObject(claims({ auth_time: minutesAgo(1), mfa_authenticated_at: minutesAgo(30) }), "token");

        expect(recent.has({ reverification: "strict" })).toBe(true);
        expect(stale.has({ reverification: "strict" })).toBe(false);
        expect(stale.has({ reverification: "moderate" })).toBe(true);
    });

    it("falls back to the first factor for users without a second one, except for strict_mfa", () => {
        const auth = authObject(claims({ auth_time: minutesAgo(2) }), "token");

        expect(auth.has({ reverification: "strict" })).toBe(true);
        expect(auth.has({ reverification: "strict_mfa" })).toBe(false);
    });
});

describe("authenticateRequest", () => {
    const request = (headers: Record<string, string>, url = `${APP_ORIGIN}/dashboard`) => new Request(url, { headers });

    it("signs in a request with a valid bearer session token", async () => {
        const token = await sign(key, sessionClaims());
        const state = await authenticateRequest(request({ authorization: `Bearer ${token}` }), options());

        expect(state.status).toBe("signed-in");
        expect(state.toAuth().userId).toBe("user_1");
    });

    it("signs in a machine with a valid M2M access token", async () => {
        const token = await sign(key, { sub: "cli_1", ptyp: "m2m" }, KINDS.access);
        const state = await authenticateRequest(request({ authorization: `Bearer ${token}` }), { ...options(), acceptsToken: "m2m_token" });

        expect(state.status).toBe("signed-in");
        expect(state.toAuth().subject).toBe("cli_1");
    });

    it("rejects an M2M token that carries the session token type", async () => {
        const token = await sign(key, { sub: "cli_1", ptyp: "m2m" });
        const state = await authenticateRequest(request({ authorization: `Bearer ${token}` }), { ...options(), acceptsToken: "m2m_token" });

        expect(state.status).toBe("signed-out");
        expect(state.reason).toBe("token-invalid");
    });

    it("refuses a token type the endpoint does not accept", async () => {
        const token = await sign(key, sessionClaims({ ptyp: "m2m" }), KINDS.access);
        const state = await authenticateRequest(request({ authorization: `Bearer ${token}` }), options());

        expect(state.status).toBe("signed-out");
        expect(state.reason).toBe("token-type-mismatch");
    });

    it("signs out a request with a forged cookie", async () => {
        const token = await sign(otherKey, sessionClaims());
        const state = await authenticateRequest(request({ cookie: `__session=${token}` }), options());

        expect(state.status).toBe("signed-out");
        expect(state.reason).toBe("session-token-invalid");
    });

    it("starts a handshake when a page load carries an expired session cookie", async () => {
        const token = await sign(key, sessionClaims(), { issuedAt: Math.floor(Date.now() / 1000) - 600 });
        const state = await authenticateRequest(
            request({ cookie: `__session=${token}; __client_uat=1`, "sec-fetch-dest": "document" }),
            withSecretKey(),
        );

        expect(state.status).toBe("handshake");
        expect(state.headers.get("location")).toMatch(new RegExp(`^${HOST_ORIGIN}/v1/handshake\\?redirect_url=`));
    });

    it("forwards a development client cookie to the handshake", async () => {
        const token = await sign(key, sessionClaims(), { issuedAt: Math.floor(Date.now() / 1000) - 600 });
        const client = "a".repeat(64);
        const state = await authenticateRequest(
            request({ cookie: `__session=${token}; __client_uat=1; __pisti_client=${client}`, "sec-fetch-dest": "document" }),
            withSecretKey(),
        );

        expect(new URL(state.headers.get("location")!).searchParams.get("__pisti_client")).toBe(client);
    });

    it("does not start a handshake it could not redeem without the secret key", async () => {
        const token = await sign(key, sessionClaims(), { issuedAt: Math.floor(Date.now() / 1000) - 600 });
        const state = await authenticateRequest(
            request({ cookie: `__session=${token}; __client_uat=1`, "sec-fetch-dest": "document" }),
            options(),
        );

        expect(state.status).toBe("signed-out");
        expect(state.reason).toBe("session-token-expired");
    });

    it("does not redirect API calls with an expired session cookie", async () => {
        const token = await sign(key, sessionClaims(), { issuedAt: Math.floor(Date.now() / 1000) - 600 });
        const state = await authenticateRequest(request({ cookie: `__session=${token}; __client_uat=1` }), options());

        expect(state.status).toBe("signed-out");
        expect(state.reason).toBe("session-token-expired");
    });

    it("stops after repeated handshakes instead of looping", async () => {
        const state = await authenticateRequest(
            request({ cookie: "__client_uat=1; __pisti_redirect_loop=3", "sec-fetch-dest": "document" }),
            withSecretKey(),
        );

        expect(state.status).toBe("signed-out");
        expect(state.reason).toBe("handshake-loop");
    });

    it("redeems a returned handshake with the secret key and sets the session cookies", async () => {
        const session = await sign(key, sessionClaims());
        const calls = stubRedemption(200, { sessionToken: session, clientUat: "1700000000" });
        const state = await authenticateRequest(request({}, `${APP_ORIGIN}/dashboard?tab=1&${HANDSHAKE_PARAMETER}=nonce-1`), withSecretKey());
        const cookies = state.headers.getSetCookie();

        expect(calls).toEqual([
            { url: "http://localhost:3000/v1/handshake/redeem", body: { nonce: "nonce-1", origin: APP_ORIGIN }, authorization: `Bearer ${SECRET_KEY}` },
        ]);
        expect(state.status).toBe("handshake");
        expect(state.headers.get("location")).toBe(`${APP_ORIGIN}/dashboard?tab=1`);
        expect(cookies).toContain(`__session=${session}; Path=/; Max-Age=60; SameSite=Lax`);
        expect(cookies).toContain("__client_uat=1700000000; Path=/; Max-Age=31536000; SameSite=Lax");
    });

    it("clears the session cookie when the handshake redeems as signed out", async () => {
        stubRedemption(200, { sessionToken: null, clientUat: "0" });
        const state = await authenticateRequest(request({}, `${APP_ORIGIN}/?${HANDSHAKE_PARAMETER}=nonce-1`), withSecretKey());

        expect(state.headers.getSetCookie()).toContain("__session=; Path=/; Max-Age=0; SameSite=Lax");
        expect(state.headers.getSetCookie()).toContain("__client_uat=0; Path=/; Max-Age=31536000; SameSite=Lax");
    });

    it("signs out when Pisti refuses the handshake", async () => {
        stubRedemption(400, null);
        const state = await authenticateRequest(request({}, `${APP_ORIGIN}/?${HANDSHAKE_PARAMETER}=forged`), withSecretKey());

        expect(state.status).toBe("signed-out");
        expect(state.reason).toBe("handshake-invalid");
    });

    it("refuses a redeemed token that does not verify", async () => {
        stubRedemption(200, { sessionToken: await sign(otherKey, sessionClaims()), clientUat: "1" });
        const state = await authenticateRequest(request({}, `${APP_ORIGIN}/?${HANDSHAKE_PARAMETER}=nonce-1`), withSecretKey());

        expect(state.status).toBe("signed-out");
        expect(state.reason).toBe("handshake-invalid");
    });

    it("cannot complete a handshake without the secret key", async () => {
        const state = await authenticateRequest(request({}, `${APP_ORIGIN}/?${HANDSHAKE_PARAMETER}=nonce-1`), options());

        expect(state.status).toBe("signed-out");
        expect(state.message).toMatch(/PISTI_SECRET_KEY/);
    });
});
