import { beforeAll, describe, expect, it } from "vitest";
import { PistiError } from "../src/errors.js";
import { authenticateRequest, authObject, HANDSHAKE_PARAMETER, verifyToken } from "../src/tokens.js";
import type { SessionClaims } from "../src/types.js";
import { APP_ORIGIN, KINDS, publishableKey, sessionClaims, sign, signingKey, type SigningKey } from "./support.js";

let key: SigningKey;
let otherKey: SigningKey;

beforeAll(async () => {
    key = await signingKey();
    otherKey = await signingKey();
});

const options = () => ({ publishableKey: publishableKey(), jwtKey: key.pem, authorizedParties: [APP_ORIGIN] });

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
        const token = await sign(key, sessionClaims(), { issuer: "http://localhost:3000/i/fa_other" });
        expect((await rejection(verifyToken(token, options()))).code).toBe("invalid_token");
    });

    it("rejects a token for another environment", async () => {
        const token = await sign(key, sessionClaims({ fid: "fa_other" }));
        expect((await rejection(verifyToken(token, options()))).message).toMatch(/another environment/);
    });

    it.each(["oauth", "m2m", "handshake", undefined])("rejects a token whose ptyp is %s", async (ptyp) => {
        const token = await sign(key, sessionClaims({ ptyp }));
        expect((await rejection(verifyToken(token, options()))).message).toMatch(/not a session token/);
    });

    it.each([
        ["an OAuth access token type", { type: KINDS.access.type }],
        ["the generic JWT type", { type: "JWT" }],
        ["the access token audience", { audience: KINDS.access.audience }],
        ["the handshake audience", { audience: KINDS.handshake.audience }],
    ])("rejects a session token with %s", async (_, kind) => {
        const token = await sign(key, sessionClaims(), kind);
        expect((await rejection(verifyToken(token, options()))).code).toBe("invalid_token");
    });

    it("rejects a token issued to an origin that is not an authorized party", async () => {
        const token = await sign(key, sessionClaims({ azp: "http://localhost:9999" }));
        expect((await rejection(verifyToken(token, options()))).message).toMatch(/unexpected origin/);
    });

    it("rejects a token signed with an algorithm the environment does not use", async () => {
        const es256 = await signingKey("ES256");
        const token = await sign(es256, sessionClaims(), { algorithm: "ES256" });
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
        const token = await sign(key, { sub: "cli_1", ptyp: "m2m", fid: "fa_test123" }, KINDS.access);
        const state = await authenticateRequest(request({ authorization: `Bearer ${token}` }), { ...options(), acceptsToken: "m2m_token" });

        expect(state.status).toBe("signed-in");
        expect(state.toAuth().subject).toBe("cli_1");
    });

    it("rejects an M2M token that carries the session token type", async () => {
        const token = await sign(key, { sub: "cli_1", ptyp: "m2m", fid: "fa_test123" });
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
            options(),
        );

        expect(state.status).toBe("handshake");
        expect(state.headers.get("location")).toMatch(/\/v1\/fapi\/fa_test123\/handshake\?redirect_url=/);
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
            options(),
        );

        expect(state.status).toBe("signed-out");
        expect(state.reason).toBe("handshake-loop");
    });

    it("rejects a handshake addressed to another app origin", async () => {
        const handshake = await sign(key, { ptyp: "handshake", fid: "fa_test123", azp: "http://localhost:9999", client_uat: 1 }, KINDS.handshake);
        const url = `${APP_ORIGIN}/dashboard?${HANDSHAKE_PARAMETER}=${handshake}`;
        const state = await authenticateRequest(request({}, url), options());

        expect(state.status).toBe("signed-out");
        expect(state.reason).toBe("handshake-invalid");
    });
});
