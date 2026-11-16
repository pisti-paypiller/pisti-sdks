import { afterEach, describe, expect, it, vi } from "vitest";
import { createPistiClient, PistiAPIResponseError, type PistiClient } from "../src/client.js";
import { API_ORIGIN, publishableKey } from "./support.js";

const SECRET_KEY = `sk_test_${"a".repeat(16)}.${"b".repeat(64)}`;
const USER = "user_0Hk3pQ9xZb2";
const ORG = "org_0Hk3pQ9xZb2";
const ROLE = "role_0Hk3pQ9xZb2";
const EMAIL = "idn_0Hk3pQ9xZb2";
const EXTERNAL = "eac_0Hk3pQ9xZb2";
const INVITATION = "orginv_0Hk3pQ9xZb2";
const SESSION = "sess_0Hk3pQ9xZb2";
const KEY = "ak_0Hk3pQ9xZb2";
const PROVIDER = "idp_0Hk3pQ9xZb2";
const ENDPOINT = "ep_0Hk3pQ9xZb2";
const DELIVERY = "msg_0Hk3pQ9xZb2";
const AT = "2026-01-01T00:00:00Z";

interface Call {
    method: string;
    url: URL;
    body: unknown;
    authorization: string | null;
}

/** Records every request and answers it with an envelope around `data` (or 204 when it is undefined). */
function stubApi(data: unknown = {}, status = 200, body?: unknown) {
    const calls: Call[] = [];
    vi.stubGlobal("fetch", async (input: URL | string, init: RequestInit) => {
        calls.push({
            method: String(init.method),
            url: new URL(String(input)),
            body: init.body === undefined ? undefined : JSON.parse(String(init.body)),
            authorization: new Headers(init.headers).get("authorization"),
        });
        if (status === 204) return new Response(null, { status });
        return new Response(JSON.stringify(body ?? { data, meta: { requestId: "req_1" } }), {
            status,
            headers: { "Content-Type": "application/json" },
        });
    });
    return calls;
}

const client = () => createPistiClient({ secretKey: SECRET_KEY, publishableKey: publishableKey(), apiUrl: API_ORIGIN });

afterEach(() => {
    vi.unstubAllGlobals();
});

type Route = [name: string, call: (pisti: PistiClient) => Promise<unknown>, method: string, path: string, body?: unknown];

// Every Backend API call the client makes: method, path with query, and JSON body.
const routes: Route[] = [
    ["getInstance", (p) => p.getInstance(), "GET", "/v1/instance"],
    ["redeemHandshake", (p) => p.redeemHandshake("n1", "http://localhost:5173"), "POST", "/v1/handshake/redeem", { nonce: "n1", origin: "http://localhost:5173" }],

    ["users.getUserList", (p) => p.users.getUserList({ limit: 10, cursor: "c1", orderBy: "-lastActiveAt", search: "alex", status: "active" }), "GET", "/v1/users?limit=10&cursor=c1&orderBy=-lastActiveAt&search=alex&status=active"],
    ["users.list", (p) => p.users.list({ orderBy: "lastSignInAt", status: "locked" }).next(), "GET", "/v1/users?orderBy=lastSignInAt&status=locked"],
    ["users.getCount", (p) => p.users.getCount({ search: "alex", status: "disabled" }), "GET", "/v1/users/count?search=alex&status=disabled"],
    ["users.getUser", (p) => p.users.getUser(USER), "GET", `/v1/users/${USER}`],
    ["users.createUser", (p) => p.users.createUser({ email: "a@example.com" }), "POST", "/v1/users", { email: "a@example.com" }],
    [
        "users.updateUser",
        (p) => p.users.updateUser(USER, { expectedUpdatedAt: AT, firstName: "A", lastName: "B", publicMetadata: {}, privateMetadata: {}, unsafeMetadata: {} }),
        "PUT",
        `/v1/users/${USER}`,
        { expectedUpdatedAt: AT, firstName: "A", lastName: "B", publicMetadata: {}, privateMetadata: {}, unsafeMetadata: {} },
    ],
    ["users.updateUsername", (p) => p.users.updateUsername(USER, null), "PUT", `/v1/users/${USER}/username`, { username: null }],
    ["users.banUser", (p) => p.users.banUser(USER), "PUT", `/v1/users/${USER}/status`, { status: "disabled" }],
    ["users.unbanUser", (p) => p.users.unbanUser(USER), "PUT", `/v1/users/${USER}/status`, { status: "active" }],
    ["users.lockUser", (p) => p.users.lockUser(USER), "PUT", `/v1/users/${USER}/status`, { status: "locked" }],
    ["users.unlockUser", (p) => p.users.unlockUser(USER), "PUT", `/v1/users/${USER}/status`, { status: "active" }],
    ["users.getUserDeletionPlan", (p) => p.users.getUserDeletionPlan(USER), "GET", `/v1/users/${USER}/deletion`],
    ["users.deleteUser", (p) => p.users.deleteUser(USER), "DELETE", `/v1/users/${USER}`],
    ["users.getUserOrganizationList", (p) => p.users.getUserOrganizationList(USER, { limit: 5 }), "GET", `/v1/users/${USER}/organizations?limit=5`],
    ["users.listOrganizations", (p) => p.users.listOrganizations(USER).next(), "GET", `/v1/users/${USER}/organizations`],
    ["users.getUserEmailAddressList", (p) => p.users.getUserEmailAddressList(USER), "GET", `/v1/users/${USER}/email-addresses`],
    [
        "users.addEmailAddress",
        (p) => p.users.addEmailAddress(USER, { email: "b@example.com", status: "unverified" }),
        "POST",
        `/v1/users/${USER}/email-addresses`,
        { email: "b@example.com", status: "unverified" },
    ],
    [
        "users.setEmailVerification",
        (p) => p.users.setEmailVerification(USER, EMAIL, "verified", { verificationReason: "Checked by HR system" }),
        "PUT",
        `/v1/users/${USER}/email-addresses/${EMAIL}`,
        { status: "verified", verificationReason: "Checked by HR system" },
    ],
    ["users.setPrimaryEmail", (p) => p.users.setPrimaryEmail(USER, EMAIL), "PUT", `/v1/users/${USER}/email-addresses/${EMAIL}/primary`],
    ["users.removeEmailAddress", (p) => p.users.removeEmailAddress(USER, EMAIL), "DELETE", `/v1/users/${USER}/email-addresses/${EMAIL}`],
    ["users.getUserExternalAccountList", (p) => p.users.getUserExternalAccountList(USER), "GET", `/v1/users/${USER}/external-accounts`],
    [
        "users.createUserExternalAccount",
        (p) => p.users.createUserExternalAccount(USER, { provider: "okta", providerAccountId: "00u1" }),
        "POST",
        `/v1/users/${USER}/external-accounts`,
        { provider: "okta", providerAccountId: "00u1" },
    ],
    ["users.deleteUserExternalAccount", (p) => p.users.deleteUserExternalAccount(USER, EXTERNAL), "DELETE", `/v1/users/${USER}/external-accounts/${EXTERNAL}`],

    ["sessions.getSessionList", (p) => p.sessions.getSessionList({ userId: USER, status: "active", limit: 20 }), "GET", `/v1/sessions?limit=20&userId=${USER}&status=active`],
    ["sessions.list", (p) => p.sessions.list({ status: "revoked" }).next(), "GET", "/v1/sessions?status=revoked"],
    ["sessions.getSession", (p) => p.sessions.getSession(SESSION), "GET", `/v1/sessions/${SESSION}`],
    ["sessions.revokeSession", (p) => p.sessions.revokeSession(SESSION), "DELETE", `/v1/sessions/${SESSION}`],

    ["apiKeys.getApiKeyList", (p) => p.apiKeys.getApiKeyList({ userId: USER, includeRevoked: true, cursor: "c2" }), "GET", `/v1/api_keys?cursor=c2&userId=${USER}&includeRevoked=true`],
    ["apiKeys.list", (p) => p.apiKeys.list({ userId: USER }).next(), "GET", `/v1/api_keys?userId=${USER}`],
    ["apiKeys.getApiKey", (p) => p.apiKeys.getApiKey(KEY), "GET", `/v1/api_keys/${KEY}`],
    ["apiKeys.updateApiKey", (p) => p.apiKeys.updateApiKey(KEY, { scopes: ["read"] }), "PUT", `/v1/api_keys/${KEY}`, { scopes: ["read"], claims: null }],
    ["apiKeys.revokeApiKey", (p) => p.apiKeys.revokeApiKey(KEY, { revocationReason: "Leaked" }), "POST", `/v1/api_keys/${KEY}/revoke`, { revocationReason: "Leaked" }],
    ["apiKeys.verifySecret", (p) => p.apiKeys.verifySecret("ak_secret"), "POST", "/v1/api_keys/verify", { secret: "ak_secret" }],

    ["organizations.getOrganizationList", (p) => p.organizations.getOrganizationList({ orderBy: "-name", search: "acme" }), "GET", "/v1/organizations?orderBy=-name&search=acme"],
    ["organizations.list", (p) => p.organizations.list({ limit: 20 }).next(), "GET", "/v1/organizations?limit=20"],
    ["organizations.getCount", (p) => p.organizations.getCount({ search: "acme" }), "GET", "/v1/organizations/count?search=acme"],
    ["organizations.getOrganization", (p) => p.organizations.getOrganization(ORG), "GET", `/v1/organizations/${ORG}`],
    ["organizations.createOrganization", (p) => p.organizations.createOrganization({ name: "Acme", slug: "acme" }), "POST", "/v1/organizations", { name: "Acme", slug: "acme" }],
    [
        "organizations.updateOrganization",
        (p) => p.organizations.updateOrganization(ORG, { name: "Acme", slug: "acme", expectedUpdatedAt: AT }),
        "PUT",
        `/v1/organizations/${ORG}`,
        { name: "Acme", slug: "acme", expectedUpdatedAt: AT },
    ],
    ["organizations.getOrganizationDeletionPlan", (p) => p.organizations.getOrganizationDeletionPlan(ORG), "GET", `/v1/organizations/${ORG}/deletion`],
    ["organizations.deleteOrganization", (p) => p.organizations.deleteOrganization(ORG), "DELETE", `/v1/organizations/${ORG}`],
    ["organizations.getOrganizationMembershipList", (p) => p.organizations.getOrganizationMembershipList(ORG, { search: "a" }), "GET", `/v1/organizations/${ORG}/memberships?search=a`],
    ["organizations.listMemberships", (p) => p.organizations.listMemberships(ORG).next(), "GET", `/v1/organizations/${ORG}/memberships`],
    [
        "organizations.updateOrganizationMembership",
        (p) => p.organizations.updateOrganizationMembership(ORG, USER, ROLE),
        "PUT",
        `/v1/organizations/${ORG}/memberships/${USER}`,
        { roleId: ROLE },
    ],
    ["organizations.deleteOrganizationMembership", (p) => p.organizations.deleteOrganizationMembership(ORG, USER), "DELETE", `/v1/organizations/${ORG}/memberships/${USER}`],
    ["organizations.getOrganizationInvitationList", (p) => p.organizations.getOrganizationInvitationList(ORG), "GET", `/v1/organizations/${ORG}/invitations`],
    ["organizations.listInvitations", (p) => p.organizations.listInvitations(ORG).next(), "GET", `/v1/organizations/${ORG}/invitations`],
    [
        "organizations.createOrganizationInvitation",
        (p) => p.organizations.createOrganizationInvitation(ORG, { email: "c@example.com", roleId: ROLE, lifetimeDays: 7 }),
        "POST",
        `/v1/organizations/${ORG}/invitations`,
        { email: "c@example.com", roleId: ROLE, lifetimeDays: 7 },
    ],
    [
        "organizations.resendOrganizationInvitation",
        (p) => p.organizations.resendOrganizationInvitation(ORG, INVITATION, { expectedExpiresAt: AT }),
        "POST",
        `/v1/organizations/${ORG}/invitations/${INVITATION}/resend`,
        { expectedExpiresAt: AT },
    ],
    ["organizations.revokeOrganizationInvitation", (p) => p.organizations.revokeOrganizationInvitation(ORG, INVITATION), "DELETE", `/v1/organizations/${ORG}/invitations/${INVITATION}`],
    ["organizations.getRoleList", (p) => p.organizations.getRoleList(ORG), "GET", `/v1/organizations/${ORG}/roles`],
    [
        "organizations.createRole",
        (p) => p.organizations.createRole(ORG, { key: "editor", name: "Editor", permissionIds: [] }),
        "POST",
        `/v1/organizations/${ORG}/roles`,
        { key: "editor", name: "Editor", permissionIds: [] },
    ],
    [
        "organizations.updateRole",
        (p) => p.organizations.updateRole(ORG, ROLE, { key: "editor", name: "Editor", permissionIds: [] }),
        "PUT",
        `/v1/organizations/${ORG}/roles/${ROLE}`,
        { key: "editor", name: "Editor", permissionIds: [] },
    ],
    ["organizations.deleteRole", (p) => p.organizations.deleteRole(ORG, ROLE), "DELETE", `/v1/organizations/${ORG}/roles/${ROLE}`],
    ["organizations.getPermissionList", (p) => p.organizations.getPermissionList(), "GET", "/v1/permissions"],

    ["externalProviders.getExternalProviderList", (p) => p.externalProviders.getExternalProviderList(), "GET", "/v1/external_providers"],
    [
        "externalProviders.create",
        (p) => p.externalProviders.create({ name: "okta", displayName: "Okta", issuerUrl: "https://okta.example.com", clientId: "c", clientSecret: "s", enabled: true, allowSignup: false }),
        "POST",
        "/v1/external_providers",
        { name: "okta", displayName: "Okta", issuerUrl: "https://okta.example.com", clientId: "c", clientSecret: "s", enabled: true, allowSignup: false },
    ],
    [
        "externalProviders.update",
        (p) => p.externalProviders.update(PROVIDER, { name: "okta", displayName: "Okta", issuerUrl: "https://okta.example.com", clientId: "c", enabled: true, allowSignup: false, expectedUpdatedAt: AT }),
        "PUT",
        `/v1/external_providers/${PROVIDER}`,
        { name: "okta", displayName: "Okta", issuerUrl: "https://okta.example.com", clientId: "c", enabled: true, allowSignup: false, expectedUpdatedAt: AT },
    ],
    ["externalProviders.delete", (p) => p.externalProviders.delete(PROVIDER), "DELETE", `/v1/external_providers/${PROVIDER}`],

    ["webhooks.catalog", (p) => p.webhooks.catalog(), "GET", "/v1/webhooks/catalog"],
    ["webhooks.endpoints", (p) => p.webhooks.endpoints(), "GET", "/v1/webhooks/endpoints"],
    [
        "webhooks.updateEndpoint",
        (p) => p.webhooks.updateEndpoint(ENDPOINT, { name: "Main", url: "https://app.example.com/hooks", eventTypes: ["user.created"], enabled: false, expectedUpdatedAt: AT }),
        "PUT",
        `/v1/webhooks/endpoints/${ENDPOINT}`,
        { name: "Main", url: "https://app.example.com/hooks", eventTypes: ["user.created"], enabled: false, expectedUpdatedAt: AT },
    ],
    ["webhooks.archiveEndpoint", (p) => p.webhooks.archiveEndpoint(ENDPOINT, AT), "POST", `/v1/webhooks/endpoints/${ENDPOINT}/archive`, { expectedUpdatedAt: AT }],
    ["webhooks.sendTest", (p) => p.webhooks.sendTest(ENDPOINT), "POST", `/v1/webhooks/endpoints/${ENDPOINT}/test`],
    ["webhooks.replayEndpoint", (p) => p.webhooks.replayEndpoint(ENDPOINT, AT), "POST", `/v1/webhooks/endpoints/${ENDPOINT}/replay`, { since: AT }],
    ["webhooks.events", (p) => p.webhooks.events({ limit: 25, type: "user.created" }), "GET", "/v1/webhooks/events?limit=25&type=user.created"],
    ["webhooks.listEvents", (p) => p.webhooks.listEvents({ type: "user.deleted" }).next(), "GET", "/v1/webhooks/events?type=user.deleted"],
    ["webhooks.listDeliveries", (p) => p.webhooks.listDeliveries({ status: "pending" }).next(), "GET", "/v1/webhooks/deliveries?status=pending"],
    [
        "webhooks.deliveries",
        (p) => p.webhooks.deliveries({ endpointId: ENDPOINT, status: "failed" }),
        "GET",
        `/v1/webhooks/deliveries?endpointId=${ENDPOINT}&status=failed`,
    ],
    ["webhooks.delivery", (p) => p.webhooks.delivery(DELIVERY), "GET", `/v1/webhooks/deliveries/${DELIVERY}`],
    ["webhooks.replay", (p) => p.webhooks.replay(DELIVERY), "POST", `/v1/webhooks/deliveries/${DELIVERY}/replay`],
];

describe("Backend API routes", () => {
    it.each(routes)("%s calls the flat route with the secret key", async (_, call, method, path, body) => {
        const calls = stubApi({ items: [], nextCursor: null, hasMore: false });
        await call(client());

        expect(calls).toHaveLength(1);
        const [sent] = calls;
        expect(sent!.method).toBe(method);
        expect(sent!.url.origin).toBe(API_ORIGIN);
        expect(sent!.url.pathname + sent!.url.search).toBe(path);
        expect(sent!.body).toEqual(body);
        expect(sent!.authorization).toBe(`Bearer ${SECRET_KEY}`);
    });

    it("lists every client method in the route table", () => {
        const pisti = client();
        const resources = ["users", "sessions", "apiKeys", "organizations", "externalProviders", "webhooks"] as const;
        const methods = resources.flatMap((resource) =>
            Object.entries(pisti[resource])
                .filter(([name, value]) => typeof value === "function" && name !== "request" && name !== "setStatus")
                .map(([name]) => `${resource}.${name}`),
        );
        const tested = new Set(routes.map(([name]) => name));
        expect(methods.filter((name) => !tested.has(name))).toEqual([]);
    });
});

describe("Backend API client", () => {
    it("returns the envelope's data", async () => {
        stubApi({ totalCount: 7 });
        await expect(client().users.getCount()).resolves.toBe(7);
    });

    it("returns nothing for 204 responses", async () => {
        stubApi(undefined, 204);
        await expect(client().users.deleteUser(USER)).resolves.toBeUndefined();
    });

    it("pages through every user", async () => {
        const pages = [
            { items: [{ id: "user_1" }], nextCursor: "c1", hasMore: true },
            { items: [{ id: "user_2" }], nextCursor: null, hasMore: false },
        ];
        const urls: string[] = [];
        vi.stubGlobal("fetch", async (input: URL | string) => {
            urls.push(String(input));
            return Response.json({ data: pages[urls.length - 1], meta: { requestId: "req_1" } });
        });
        const ids: string[] = [];
        for await (const user of client().users.list({ limit: 1 })) ids.push(user.id);

        expect(ids).toEqual(["user_1", "user_2"]);
        expect(new URL(urls[1]!).searchParams.get("cursor")).toBe("c1");
    });

    it("stops when a page says hasMore is false", async () => {
        const calls = stubApi({ items: [{ id: "org_1" }, { id: "org_2" }], nextCursor: "ignored", hasMore: false });
        const ids: string[] = [];
        for await (const organization of client().organizations.list({ orderBy: "name" })) ids.push(organization.id);

        expect(ids).toEqual(["org_1", "org_2"]);
        expect(calls).toHaveLength(1);
        expect(calls[0]!.url.searchParams.get("orderBy")).toBe("name");
    });

    it("keeps orderBy and filters on every page", async () => {
        const pages = [
            { items: [{ id: "user_1" }], nextCursor: "c1", hasMore: true },
            { items: [], nextCursor: null, hasMore: false },
        ];
        const urls: URL[] = [];
        vi.stubGlobal("fetch", async (input: URL | string) => {
            urls.push(new URL(String(input)));
            return Response.json({ data: pages[urls.length - 1], meta: { requestId: "req_1" } });
        });
        for await (const _ of client().users.list({ orderBy: "-lastActiveAt", status: "active" })) void _;

        expect(urls.map((url) => url.search)).toEqual([
            "?orderBy=-lastActiveAt&status=active",
            "?cursor=c1&orderBy=-lastActiveAt&status=active",
        ]);
    });

    it("refuses a repeated cursor", async () => {
        stubApi({ items: [], nextCursor: "c1", hasMore: true });
        const iterate = async () => {
            for await (const _ of client().sessions.list()) void _;
        };
        await expect(iterate()).rejects.toMatchObject({ status: 502 });
    });

    it("turns Problem Details into PistiAPIResponseError", async () => {
        stubApi(undefined, 409, {
            title: "Conflict",
            detail: "Remove the organizations first.",
            status: 409,
            code: "deletion_blocked",
            requestId: "req_9",
            blockers: [{ resource: "organizations", count: 2, resolution: "Delete them." }],
        });
        const error = await client().users.deleteUser(USER).catch((reason: unknown) => reason);

        expect(error).toBeInstanceOf(PistiAPIResponseError);
        expect(error).toMatchObject({
            message: "Remove the organizations first.",
            status: 409,
            code: "deletion_blocked",
            requestId: "req_9",
            blockers: [{ resource: "organizations", count: 2, resolution: "Delete them." }],
        });
    });

    it("rejects a response without the envelope", async () => {
        stubApi(undefined, 200, { totalCount: 7 });
        await expect(client().users.getCount()).rejects.toMatchObject({ status: 502 });
    });

    it("validates IDs before calling the API", async () => {
        const calls = stubApi();
        expect(() => client().users.getUser("../instances")).toThrow(/valid ID/);
        expect(calls).toHaveLength(0);
    });

    it("needs a secret key for Backend API calls", async () => {
        stubApi();
        const pisti = createPistiClient({ publishableKey: publishableKey(), apiUrl: API_ORIGIN });
        await expect(pisti.users.getUser(USER)).rejects.toThrow(/secret key/);
    });

    it("calls the Backend API with only a secret key", async () => {
        vi.stubEnv("PISTI_PUBLISHABLE_KEY", "");
        const calls = stubApi({ id: USER });
        const pisti = createPistiClient({ secretKey: SECRET_KEY, apiUrl: API_ORIGIN });
        await pisti.users.getUser(USER);
        expect(calls[0]?.url.pathname).toBe(`/v1/users/${USER}`);
        await expect(pisti.verifyToken("token")).rejects.toThrow(/publishable key/);
        vi.unstubAllEnvs();
    });

    it("needs a secret key or a publishable key", () => {
        vi.stubEnv("PISTI_PUBLISHABLE_KEY", "");
        vi.stubEnv("PISTI_SECRET_KEY", "");
        expect(() => createPistiClient({ apiUrl: API_ORIGIN })).toThrow(/Missing Pisti keys/);
        vi.unstubAllEnvs();
    });
});
