import { afterEach, describe, expect, it, vi } from "vitest";
import { PistiClient, PistiClientError, reverificationOf, type SessionVerification } from "../src/client.js";
import { describeOrganizationError } from "../src/organizations.js";
import type { ClientState } from "../src/resources.js";

const SESSION = "sess_0Hk3pQ9xZb2";
const OTHER_SESSION = "sess_0Hk3pQ9xZb9";
const USER = "user_0Hk3pQ9xZb2";
const ORG = "org_0Hk3pQ9xZb2";
const EMAIL = "idn_0Hk3pQ9xZb2";
const PASSKEY = "passkey_0Hk3pQ9xZb2";
const EXTERNAL = "eac_0Hk3pQ9xZb2";
const KEY = "ak_0Hk3pQ9xZb2";
const INVITATION = "orginv_0Hk3pQ9xZb2";
const CLIENT_TOKEN = "client-token-1";
const LIVE_HOST = "https://auth.example.com";
const DEV_HOST = "http://quiet-fox-12.pisti.localhost:3000";

const base64url = (text: string) =>
    btoa(String.fromCharCode(...new TextEncoder().encode(text))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const key = (host: string, environment: "test" | "live") => `pk_${environment}_${base64url(`${host}$`)}`;

/** A session token the client can decode (it never verifies one). */
const jwt = (claims: Record<string, unknown>) =>
    `e30.${base64url(JSON.stringify(claims))}.sig`;

const clientState = (sessionId = SESSION): ClientState => ({
    sessions: [
        {
            id: sessionId,
            user: { id: USER, firstName: "Ada", lastName: "Lovelace", email: "ada@example.com", imageUrl: null, username: null },
            organizationId: null,
            lastActiveAt: "2026-01-01T00:00:00Z",
            expireAt: "2026-01-08T00:00:00Z",
            factorVerificationAge: [5, -1],
        },
    ],
    lastActiveSessionId: sessionId,
    clientToken: null,
});

interface Call {
    method: string;
    url: URL;
    body: unknown;
    headers: Headers;
}
type Answer = { status?: number; data?: unknown; problem?: Record<string, unknown> };
type Handler = (call: Call) => Answer | undefined;

/** Answers the Frontend API: the client, tokens and CSRF by default, everything else through `handler`. */
function stubApi(handler: Handler = () => undefined) {
    const calls: Call[] = [];
    vi.stubGlobal("fetch", async (input: URL | string, init: RequestInit) => {
        const call: Call = {
            method: String(init.method ?? "GET"),
            url: new URL(String(input)),
            body: init.body === undefined ? undefined : JSON.parse(String(init.body)),
            headers: new Headers(init.headers),
        };
        calls.push(call);
        const answer = handler(call) ?? defaults(call);
        const status = answer.status ?? 200;
        if (answer.problem)
            return new Response(JSON.stringify({ title: "Refused", status, ...answer.problem }), {
                status,
                headers: { "Content-Type": "application/problem+json" },
            });
        if (status === 204 || answer.data === undefined) return new Response(null, { status: 204 });
        return new Response(JSON.stringify({ data: answer.data, meta: { requestId: "req_1" } }), {
            status,
            headers: { "Content-Type": "application/json" },
        });
    });
    return calls;
}

let csrfCount = 0;
function defaults(call: Call): Answer {
    const path = call.url.pathname;
    if (path === "/v1/client") return { data: clientState() };
    if (path.endsWith("/tokens"))
        return { data: { jwt: jwt({ sid: SESSION, auth_time: 1, fva: [5, -1] }), expiresAt: new Date(Date.now() + 60_000).toISOString() } };
    if (path === "/v1/client/csrf") return { data: { token: `csrf-${++csrfCount}`, headerName: "X-CSRF-TOKEN" } };
    return { status: 204 };
}

async function signedIn(environment: "live" | "test" = "live") {
    const client = new PistiClient({ publishableKey: environment === "live" ? key(LIVE_HOST, "live") : key(DEV_HOST, "test") });
    await client.load();
    expect(client.getSnapshot().sessionId).toBe(SESSION);
    return client;
}

/** The calls to the session API (everything but the client, tokens and CSRF). */
const sessionCalls = (calls: Call[]) =>
    calls.filter((call) => !/^\/v1\/client(\/csrf|\/sessions\/[^/]+\/tokens)?$/.test(call.url.pathname));

afterEach(() => {
    vi.unstubAllGlobals();
    csrfCount = 0;
});

type Route = [name: string, call: (client: PistiClient) => Promise<unknown>, method: string, path: string, body?: unknown];

const routes: Route[] = [
    ["me.get", (c) => c.me.get(), "GET", "/v1/me"],
    ["me.update", (c) => c.me.update({ firstName: "Ada", username: "" }), "PATCH", "/v1/me", { firstName: "Ada", username: "" }],
    ["me.delete", (c) => c.me.delete(), "DELETE", "/v1/me"],
    ["me.getEmailAddresses", (c) => c.me.getEmailAddresses(), "GET", "/v1/me/email_addresses"],
    ["me.createEmailAddress", (c) => c.me.createEmailAddress({ emailAddress: "a@example.com" }), "POST", "/v1/me/email_addresses", { emailAddress: "a@example.com" }],
    ["me.getPasskeys", (c) => c.me.getPasskeys(), "GET", "/v1/me/passkeys"],
    ["me.deletePasskey", (c) => c.me.deletePasskey(PASSKEY), "DELETE", `/v1/me/passkeys/${PASSKEY}`],
    ["me.createTOTP", (c) => c.me.createTOTP(), "POST", "/v1/me/totp"],
    ["me.verifyTOTP", (c) => c.me.verifyTOTP({ code: "123456" }), "POST", "/v1/me/totp/attempt_verification", { code: "123456" }],
    ["me.disableTOTP", (c) => c.me.disableTOTP(), "DELETE", "/v1/me/totp"],
    ["me.createBackupCode", (c) => c.me.createBackupCode(), "POST", "/v1/me/backup_codes"],
    ["me.getExternalAccounts", (c) => c.me.getExternalAccounts(), "GET", "/v1/me/external_accounts"],
    ["me.createExternalAccount", (c) => c.me.createExternalAccount({ strategy: "oauth_idp_0Hk3pQ9xZb2", redirectUrl: "https://app.example.com/account" }), "POST", "/v1/me/external_accounts", { strategy: "oauth_idp_0Hk3pQ9xZb2", redirectUrl: "https://app.example.com/account" }],
    ["me.deleteExternalAccount", (c) => c.me.deleteExternalAccount(EXTERNAL), "DELETE", `/v1/me/external_accounts/${EXTERNAL}`],
    ["me.getSessions", (c) => c.me.getSessions({ limit: 10, cursor: "c1" }), "GET", "/v1/me/sessions?limit=10&cursor=c1"],
    ["me.revokeSession", (c) => c.me.revokeSession(OTHER_SESSION), "POST", `/v1/me/sessions/${OTHER_SESSION}/revoke`],
    ["me.revokeAllSessions", (c) => c.me.revokeAllSessions(), "POST", "/v1/me/sessions/revoke_all"],
    ["me.getApiKeys", (c) => c.me.getApiKeys(), "GET", "/v1/me/api_keys"],
    ["me.createApiKey", (c) => c.me.createApiKey({ name: "Deploy", secondsUntilExpiration: 3600 }), "POST", "/v1/me/api_keys", { name: "Deploy", secondsUntilExpiration: "3600" }],
    ["me.revokeApiKey", (c) => c.me.revokeApiKey(KEY, "lost"), "POST", `/v1/me/api_keys/${KEY}/revoke`, { revocationReason: "lost" }],
    ["me.getOrganizationMemberships", (c) => c.me.getOrganizationMemberships({ search: "acme" }), "GET", "/v1/me/organization_memberships?search=acme"],
    ["me.leaveOrganization", (c) => c.me.leaveOrganization(ORG), "DELETE", `/v1/me/organization_memberships/${ORG}`],
    ["me.getOrganizationInvitations", (c) => c.me.getOrganizationInvitations(), "GET", "/v1/me/organization_invitations"],
    ["me.acceptOrganizationInvitation", (c) => c.me.acceptOrganizationInvitation(INVITATION), "POST", `/v1/me/organization_invitations/${INVITATION}/accept`],
    ["organizations.create", (c) => c.organizations.create({ name: "Acme", slug: "acme" }), "POST", "/v1/organizations", { name: "Acme", slug: "acme" }],
    ["organizations.get", (c) => c.organizations.get(ORG), "GET", `/v1/organizations/${ORG}`],
    ["organizations.update", (c) => c.organizations.update(ORG, { name: "Acme 2" }), "PATCH", `/v1/organizations/${ORG}`, { name: "Acme 2" }],
    ["organizations.destroy", (c) => c.organizations.destroy(ORG), "DELETE", `/v1/organizations/${ORG}`],
    ["organizations.getMemberships", (c) => c.organizations.getMemberships(ORG, { limit: 5 }), "GET", `/v1/organizations/${ORG}/memberships?limit=5`],
    ["organizations.updateMember", (c) => c.organizations.updateMember(ORG, USER, { role: "org:admin" }), "PATCH", `/v1/organizations/${ORG}/memberships/${USER}`, { role: "org:admin" }],
    ["organizations.removeMember", (c) => c.organizations.removeMember(ORG, USER), "DELETE", `/v1/organizations/${ORG}/memberships/${USER}`],
    ["organizations.getInvitations", (c) => c.organizations.getInvitations(ORG), "GET", `/v1/organizations/${ORG}/invitations`],
    ["organizations.inviteMember", (c) => c.organizations.inviteMember(ORG, { emailAddress: "b@example.com", role: "org:member" }), "POST", `/v1/organizations/${ORG}/invitations`, { email: "b@example.com", role: "org:member" }],
    ["organizations.revokeInvitation", (c) => c.organizations.revokeInvitation(ORG, INVITATION), "POST", `/v1/organizations/${ORG}/invitations/${INVITATION}/revoke`],
    ["organizations.getRoles", (c) => c.organizations.getRoles(ORG), "GET", `/v1/organizations/${ORG}/roles`],
];

const listPaths = /\/(email_addresses|passkeys|external_accounts|api_keys|roles)$/;

describe("session API routes", () => {
    it.each(routes)("%s", async (_name, call, method, path, body) => {
        const calls = stubApi((sent) => {
            if (sent.url.pathname.startsWith("/v1/client")) return undefined;
            if (sent.method === "GET" && listPaths.test(sent.url.pathname)) return { data: { items: [], nextCursor: null, hasMore: false } };
            if (sent.url.pathname === "/v1/me/email_addresses") return { data: { id: EMAIL, emailAddress: "a@example.com" } };
            return { data: {} };
        });
        const client = await signedIn();
        await call(client);

        const [sent] = sessionCalls(calls);
        const expected = new URL(path, LIVE_HOST);
        expect(sent?.method).toBe(method);
        expect(sent?.url.pathname).toBe(expected.pathname);
        for (const [name, value] of expected.searchParams) expect(sent?.url.searchParams.get(name)).toBe(value);
        expect(sent?.url.searchParams.get("_pisti_session_id")).toBe(SESSION);
        expect(sent?.body).toEqual(body);
        expect(calls.some((item) => item.url.pathname.startsWith("/v1/account"))).toBe(false);
    });

    it("verifies a new email address by its ID", async () => {
        const calls = stubApi((sent) =>
            sent.url.pathname.startsWith("/v1/me/email_addresses")
                ? { data: { id: EMAIL, emailAddress: "a@example.com", primary: false, verification: { status: "unverified" } } }
                : undefined,
        );
        const client = await signedIn();
        const address = await client.me.createEmailAddress({ emailAddress: "a@example.com" });
        await address.prepareVerification();
        await address.attemptVerification({ code: "123456" });
        await address.destroy();

        expect(sessionCalls(calls).map((call) => [call.method, call.url.pathname, call.body])).toEqual([
            ["POST", "/v1/me/email_addresses", { emailAddress: "a@example.com" }],
            ["POST", `/v1/me/email_addresses/${EMAIL}/prepare_verification`, { strategy: "email_code" }],
            ["POST", `/v1/me/email_addresses/${EMAIL}/attempt_verification`, { code: "123456" }],
            ["DELETE", `/v1/me/email_addresses/${EMAIL}`, undefined],
        ]);
    });

    it("switches to the session a new password starts", async () => {
        stubApi((sent) => (sent.url.pathname === "/v1/me/change_password" ? { data: clientState(OTHER_SESSION) } : undefined));
        const client = await signedIn();
        // After the change, the client reads its sessions again and finds the replacement.
        stubApi((sent) =>
            sent.url.pathname === "/v1/me/change_password" || sent.url.pathname === "/v1/client"
                ? { data: clientState(OTHER_SESSION) }
                : undefined,
        );
        await client.me.updatePassword({ newPassword: "a long new password" });

        expect(client.getSnapshot().sessionId).toBe(OTHER_SESSION);
    });

    it("applies the client a new password returns without reading it again", async () => {
        stubApi();
        const client = await signedIn();
        const calls = stubApi((sent) => (sent.url.pathname === "/v1/me/change_password" ? { data: clientState(OTHER_SESSION) } : undefined));
        await client.me.updatePassword({ newPassword: "a long new password" });

        expect(client.getSnapshot().sessionId).toBe(OTHER_SESSION);
        expect(calls.some((call) => call.url.pathname === "/v1/client")).toBe(false);
    });

    it("refuses invalid IDs before sending anything", async () => {
        const calls = stubApi();
        const client = await signedIn();
        expect(() => client.organizations.get("../me")).toThrow(/valid ID/);
        expect(sessionCalls(calls)).toHaveLength(0);
    });
});

describe("session naming", () => {
    it("names the active session and sends the cookie, without a bearer token", async () => {
        const calls = stubApi((sent) => (sent.url.pathname === "/v1/me" ? { data: {} } : undefined));
        const client = await signedIn();
        await client.me.get();

        const [sent] = sessionCalls(calls);
        expect(sent?.url.origin).toBe(LIVE_HOST);
        expect(sent?.url.searchParams.get("_pisti_session_id")).toBe(SESSION);
        expect(sent?.headers.get("authorization")).toBeNull();
        expect(sent?.headers.get("x-pisti-client")).toBeNull();
    });

    it("sends the development header with the stored browser client, and then needs no CSRF token", async () => {
        vi.stubGlobal("localStorage", { getItem: () => CLIENT_TOKEN, setItem: () => {} });
        const calls = stubApi();
        const client = await signedIn("test");
        await client.me.revokeAllSessions();

        const [sent] = sessionCalls(calls);
        expect(sent?.headers.get("x-pisti-client")).toBe(CLIENT_TOKEN);
        expect(sent?.url.searchParams.get("_pisti_session_id")).toBe(SESSION);
        expect(sent?.headers.get("x-csrf-token")).toBeNull();
        expect(calls.some((call) => call.url.pathname === "/v1/client/csrf")).toBe(false);
    });

    it("refuses to act when signed out", async () => {
        stubApi((sent) => (sent.url.pathname === "/v1/client" ? { data: { sessions: [], lastActiveSessionId: null, clientToken: null } } : undefined));
        const client = new PistiClient({ publishableKey: key(LIVE_HOST, "live") });
        await client.load();
        await expect(client.me.get()).rejects.toMatchObject({ status: 401, code: "signed_out" });
    });
});

describe("switching sessions", () => {
    const withOrganization = (sessionId: string, organizationId: string | null): ClientState => {
        const state = clientState(sessionId);
        return { ...state, sessions: state.sessions.map((session) => ({ ...session, organizationId })) };
    };

    it.each([403, 404])("lands on the personal account when the session's organization is gone (%i)", async (status) => {
        let organization: string | null = ORG;
        const calls = stubApi((sent) => {
            if (sent.url.pathname === "/v1/client") return { data: withOrganization(SESSION, organization) };
            if (sent.url.pathname.endsWith("/touch")) {
                const body = sent.body as { organizationId: string | null };
                if (body.organizationId) return { status, problem: { code: status === 403 ? "forbidden" : "not_found" } };
                return { data: withOrganization(SESSION, null) };
            }
            return undefined;
        });
        const client = await signedIn();
        organization = null;
        await client.setActive(SESSION);

        const touches = calls.filter((call) => call.url.pathname.endsWith("/touch")).map((call) => call.body);
        expect(touches).toEqual([{ organizationId: ORG }, { organizationId: null }]);
        expect(client.getSnapshot().user?.organizationId).toBeNull();
    });

    it("does not retry other failures", async () => {
        const calls = stubApi((sent) => {
            if (sent.url.pathname === "/v1/client") return { data: withOrganization(SESSION, ORG) };
            if (sent.url.pathname.endsWith("/touch")) return { status: 409, problem: { code: "conflict" } };
            return undefined;
        });
        const client = await signedIn();
        await expect(client.setActive(SESSION)).rejects.toMatchObject({ status: 409 });
        expect(calls.filter((call) => call.url.pathname.endsWith("/touch"))).toHaveLength(1);
    });
});

describe("passkey availability", () => {
    const at = (href: string) => vi.stubGlobal("window", { location: new URL(href), PublicKeyCredential: class {} });

    it("needs the environment's relying party: its primary domain in production", async () => {
        stubApi();
        const client = await signedIn();
        vi.stubGlobal("navigator", { credentials: {} });
        at("https://app.example.com/account");
        expect(client.passkeysAvailable).toBe(true);
        at("https://example.org/account");
        expect(client.passkeysAvailable).toBe(false);
        at("http://app.example.com/account");
        expect(client.passkeysAvailable).toBe(false);
    });

    it("needs the hosted pages' host in development, and WebAuthn", async () => {
        vi.stubGlobal("localStorage", { getItem: () => CLIENT_TOKEN, setItem: () => {} });
        stubApi();
        const client = await signedIn("test");
        vi.stubGlobal("navigator", { credentials: {} });
        at("http://localhost:5173/");
        expect(client.passkeysAvailable).toBe(false);
        at("http://quiet-fox-12-accounts.pisti.localhost:3000/user");
        expect(client.passkeysAvailable).toBe(true);
        vi.stubGlobal("window", { location: new URL("http://quiet-fox-12-accounts.pisti.localhost:3000/user") });
        expect(client.passkeysAvailable).toBe(false);
    });
});

describe("CSRF", () => {
    it("fetches the token once and sends it on every cookie mutation, not on reads", async () => {
        const calls = stubApi((sent) => (sent.url.pathname === "/v1/me" && sent.method === "GET" ? { data: {} } : undefined));
        const client = await signedIn();
        await client.me.get();
        await client.me.revokeAllSessions();
        await client.me.delete();

        const [read, first, second] = sessionCalls(calls);
        expect(read?.headers.get("x-csrf-token")).toBeNull();
        expect(first?.headers.get("x-csrf-token")).toBe("csrf-1");
        expect(second?.headers.get("x-csrf-token")).toBe("csrf-1");
        expect(calls.filter((call) => call.url.pathname === "/v1/client/csrf")).toHaveLength(1);
    });

    it("sends no token when choosing the active organization, which checks only the origin", async () => {
        const calls = stubApi((sent) => (sent.url.pathname.endsWith("/touch") ? { data: clientState() } : undefined));
        const client = await signedIn();
        await client.setActiveOrganization(ORG);

        const touch = calls.find((call) => call.url.pathname === `/v1/client/sessions/${SESSION}/touch`);
        expect(touch?.body).toEqual({ organizationId: ORG });
        expect(touch?.headers.get("x-csrf-token")).toBeNull();
        expect(calls.some((call) => call.url.pathname === "/v1/client/csrf")).toBe(false);
    });

    it("fetches a new token once the browser client changes", async () => {
        let current = SESSION;
        const calls = stubApi((sent) => {
            if (sent.url.pathname === "/v1/client") return { data: clientState(current) };
            if (sent.url.pathname === "/v1/client/sign_out") return { data: { sessions: [], lastActiveSessionId: null, clientToken: null } };
            return undefined;
        });
        const client = await signedIn();
        await client.me.revokeAllSessions();
        await client.signOut();
        current = OTHER_SESSION;
        await client.load();
        await client.me.delete();

        const mutations = calls.filter((call) => call.url.pathname === "/v1/me/sessions/revoke_all" || (call.url.pathname === "/v1/me" && call.method === "DELETE"));
        expect(mutations.map((call) => call.headers.get("x-csrf-token"))).toEqual(["csrf-1", "csrf-2"]);
    });

    it("fetches a new token and retries once on csrf_invalid", async () => {
        const calls = stubApi((sent) =>
            sent.url.pathname === "/v1/me/sessions/revoke_all" && sent.headers.get("x-csrf-token") === "csrf-1"
                ? { status: 403, problem: { code: "csrf_invalid" } }
                : undefined,
        );
        const client = await signedIn();
        await client.me.revokeAllSessions();

        const attempts = calls.filter((call) => call.url.pathname === "/v1/me/sessions/revoke_all");
        expect(attempts.map((call) => call.headers.get("x-csrf-token"))).toEqual(["csrf-1", "csrf-2"]);
    });

    it("gives up after one retry", async () => {
        const calls = stubApi((sent) =>
            sent.url.pathname === "/v1/me/sessions/revoke_all" ? { status: 403, problem: { code: "csrf_invalid" } } : undefined,
        );
        const client = await signedIn();
        await expect(client.me.revokeAllSessions()).rejects.toMatchObject({ status: 403, code: "csrf_invalid" });
        expect(calls.filter((call) => call.url.pathname === "/v1/me/sessions/revoke_all")).toHaveLength(2);
    });
});

describe("reverification", () => {
    const required = { status: 403, problem: { code: "session_reverification_required", reverification: { level: "multi_factor", afterMinutes: 10 } } };
    const verification = (status: SessionVerification["status"]): SessionVerification => ({
        id: "sv_1",
        object: "session_verification",
        status,
        level: "multi_factor",
        sessionId: SESSION,
        supportedFirstFactors: [{ strategy: "password" }, { strategy: "email_code" }, { strategy: "passkey" }],
        supportedSecondFactors: [{ strategy: "totp" }, { strategy: "backup_code" }],
        firstFactorVerification: null,
        factorVerificationAge: [0, 0],
        expiresAt: "2026-01-01T00:10:00Z",
    });

    it("asks for the level the server names, verifies the session, then retries the request", async () => {
        let verified = false;
        const calls = stubApi((sent) => {
            const path = sent.url.pathname;
            if (path === "/v1/me/api_keys" && sent.method === "POST")
                return verified ? { data: { apiKey: { id: KEY }, secret: "ak_secret" } } : required;
            if (path === `/v1/client/sessions/${SESSION}/verify`)
                return { data: verification(sent.method === "GET" && verified ? "complete" : "needs_first_factor") };
            if (path.endsWith("/verify/attempt_first_factor")) return { data: verification("needs_second_factor") };
            if (path.endsWith("/verify/attempt_second_factor")) {
                verified = true;
                return { data: verification("complete") };
            }
            return undefined;
        });
        const client = await signedIn();
        const asked: unknown[] = [];
        client.subscribeReverification(() => {
            const requirement = client.getReverificationSnapshot();
            if (!requirement) return;
            asked.push(requirement);
            void (async () => {
                const started = await client.sessionVerification.create(requirement.level);
                expect(started.supportedFirstFactors.map((factor) => factor.strategy)).toEqual(["password", "email_code", "passkey"]);
                await client.sessionVerification.attemptFirstFactor({ strategy: "password", password: "correct horse" });
                await client.sessionVerification.attemptSecondFactor({ strategy: "totp", code: "123456" });
                await client.completeReverification();
            })();
        });

        const created = await client.me.createApiKey({ name: "Deploy" });

        expect(created.secret).toBe("ak_secret");
        expect(asked).toEqual([{ level: "multi_factor", afterMinutes: 10 }]);
        const steps = calls.filter((call) => (call.url.pathname.includes("/verify") && call.method === "POST") || call.url.pathname === "/v1/me/api_keys");
        expect(steps.map((call) => [call.url.pathname, call.body])).toEqual([
            ["/v1/me/api_keys", { name: "Deploy" }],
            [`/v1/client/sessions/${SESSION}/verify`, { level: "multi_factor" }],
            [`/v1/client/sessions/${SESSION}/verify/attempt_first_factor`, { strategy: "password", password: "correct horse" }],
            [`/v1/client/sessions/${SESSION}/verify/attempt_second_factor`, { strategy: "totp", code: "123456" }],
            ["/v1/me/api_keys", { name: "Deploy" }],
        ]);
        expect(steps.every((call) => call.headers.get("x-csrf-token") === "csrf-1")).toBe(true);
        expect(client.getReverificationSnapshot()).toBeNull();
    });

    it("rejects with the requirement when nothing can show the step", async () => {
        stubApi((sent) => (sent.url.pathname === "/v1/me" && sent.method === "DELETE" ? required : undefined));
        const client = await signedIn();
        const failure = await client.me.delete().catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(PistiClientError);
        expect(failure).toMatchObject({ code: "session_reverification_required", reverification: { level: "multi_factor", afterMinutes: 10 } });
    });

    it("fails the request when the user cancels, without retrying", async () => {
        const calls = stubApi((sent) => (sent.url.pathname === "/v1/me/totp" ? required : undefined));
        const client = await signedIn();
        client.subscribeReverification(() => {
            if (client.getReverificationSnapshot()) queueMicrotask(() => client.cancelReverification());
        });

        await expect(client.me.createTOTP()).rejects.toMatchObject({ code: "reverification_cancelled" });
        expect(calls.filter((call) => call.url.pathname === "/v1/me/totp")).toHaveLength(1);
    });

    it("wraps the app's own calls with withReverification", async () => {
        stubApi((sent) => (sent.url.pathname.endsWith("/verify") ? { data: verification("complete") } : undefined));
        const client = await signedIn();
        client.subscribeReverification(() => {
            if (client.getReverificationSnapshot()) queueMicrotask(() => void client.completeReverification());
        });
        let attempts = 0;
        const result = await client.withReverification(async () => {
            if (++attempts === 1) throw { code: "session_reverification_required", reverification: { level: "first_factor", afterMinutes: 10 } };
            return "done";
        });

        expect(result).toBe("done");
        expect(attempts).toBe(2);
    });

    it("re-reads the verification instead of trusting the caller, and refuses an incomplete one", async () => {
        stubApi((sent) => {
            if (sent.url.pathname === "/v1/me/totp") return required;
            if (sent.url.pathname.endsWith("/verify")) return { data: verification("needs_second_factor") };
            return undefined;
        });
        const client = await signedIn();
        let refusal: unknown;
        client.subscribeReverification(() => {
            if (client.getReverificationSnapshot() && !refusal)
                void client.completeReverification().catch((error: unknown) => {
                    refusal = error;
                    client.cancelReverification();
                });
        });

        await expect(client.me.createTOTP()).rejects.toMatchObject({ code: "reverification_cancelled" });
        expect(refusal).toMatchObject({ code: "verification_incomplete" });
    });

    it("escalates one step for parallel first_factor and multi_factor requests, replaying each once", async () => {
        let verifiedLevel: string | null = null;
        const need = (level: string) => ({
            status: 403,
            problem: { code: "session_reverification_required", reverification: { level, afterMinutes: 10 } },
        });
        const calls = stubApi((sent) => {
            const path = sent.url.pathname;
            if (path === "/v1/me" && sent.method === "PATCH") return verifiedLevel ? { data: {} } : need("first_factor");
            if (path === "/v1/me/backup_codes") return verifiedLevel === "multi_factor" ? { data: { object: "backup_code", codes: ["a"] } } : need("multi_factor");
            if (path === `/v1/client/sessions/${SESSION}/verify` && sent.method === "POST") {
                const level = (sent.body as { level: string }).level;
                return { data: { ...verification("needs_first_factor"), level } };
            }
            if (path === `/v1/client/sessions/${SESSION}/verify` && sent.method === "GET")
                return { data: { ...verification(verifiedLevel ? "complete" : "needs_first_factor"), level: verifiedLevel ?? "first_factor" } };
            return undefined;
        });
        const client = await signedIn();
        const levels: string[] = [];
        let finishing = false;
        client.subscribeReverification(() => {
            const requirement = client.getReverificationSnapshot();
            if (!requirement) return;
            levels.push(requirement.level);
            // Wait until both requests have joined, then verify at the level the step asks for now.
            if (requirement.level !== "multi_factor" || finishing) return;
            finishing = true;
            void (async () => {
                await client.sessionVerification.create(requirement.level);
                verifiedLevel = requirement.level;
                await client.completeReverification();
            })();
        });

        const [updated, codes] = await Promise.all([client.me.update({ username: "ada" }), client.me.createBackupCode()]);

        expect(updated).toEqual({});
        expect(codes.codes).toEqual(["a"]);
        expect(levels).toEqual(["first_factor", "multi_factor"]);
        expect(calls.filter((call) => call.url.pathname === "/v1/me" && call.method === "PATCH")).toHaveLength(2);
        expect(calls.filter((call) => call.url.pathname === "/v1/me/backup_codes")).toHaveLength(2);
        expect(calls.filter((call) => call.url.pathname.endsWith("/verify") && call.method === "POST").map((call) => call.body)).toEqual([
            { level: "multi_factor" },
        ]);
    });

    it("reports a dismissed passkey prompt as passkey_cancelled", async () => {
        stubApi((sent) =>
            sent.url.pathname.endsWith("/verify/prepare_first_factor")
                ? { data: { ...verification("needs_first_factor"), firstFactorVerification: { strategy: "passkey", status: "unverified", externalVerificationRedirectUrl: null, passkeyOptions: { challenge: "AAAA" }, error: null } } }
                : undefined,
        );
        const client = await signedIn();
        vi.stubGlobal("navigator", { credentials: { get: async () => { throw new DOMException("The operation was aborted.", "NotAllowedError"); } } });

        await expect(client.sessionVerification.passkey()).rejects.toMatchObject({ code: "passkey_cancelled", message: expect.stringMatching(/closed or timed out/) });
    });

    it("ignores a reverification code without its requirement", () => {
        expect(reverificationOf({ code: "session_reverification_required" })).toBeNull();
        expect(reverificationOf({ code: "session_reverification_required", reverification: { level: "first_factor" } })).toBeNull();
        expect(reverificationOf({ code: "session_reverification_required", reverification: { level: "first_factor", afterMinutes: 5 } })).toEqual({ level: "first_factor", afterMinutes: 5 });
    });

    it("keeps the session's factor verification age", async () => {
        stubApi();
        const client = await signedIn();
        expect(client.getSnapshot().factorVerificationAge).toEqual([5, -1]);
    });
});

describe("organization errors", () => {
    it("tells a missing membership (404) from a missing permission (403)", async () => {
        stubApi((sent) => {
            if (sent.url.pathname === `/v1/organizations/${ORG}`) return { status: 404, problem: { code: "not_found" } };
            if (sent.url.pathname === `/v1/organizations/${ORG}/memberships/${USER}`) return { status: 403, problem: { code: "forbidden" } };
            return undefined;
        });
        const client = await signedIn();

        const missing = await client.organizations.get(ORG).catch((error: unknown) => error);
        const denied = await client.organizations.removeMember(ORG, USER).catch((error: unknown) => error);

        expect(missing).toMatchObject({ status: 404 });
        expect(denied).toMatchObject({ status: 403 });
        expect(describeOrganizationError(missing).message).toMatch(/no longer a member/);
        expect(describeOrganizationError(denied).message).toMatch(/role .* doesn’t allow/);
    });

    it("keeps specific 403s, such as outranked or organizations_disabled", () => {
        const outranked = new PistiClientError("They outrank you.", 403, "outranked");
        expect(describeOrganizationError(outranked)).toBe(outranked);
        expect(describeOrganizationError(new PistiClientError("Off.", 403, "organizations_disabled")).message).toBe("Off.");
    });
});
