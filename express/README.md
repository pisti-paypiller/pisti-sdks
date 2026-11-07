# @pisti-paypiller/express

Pisti for Express 5, shaped like `@clerk/express`. It reads its configuration from environment
variables, so most apps need two lines:

```ts
import { pistiMiddleware, getAuth } from "@pisti-paypiller/express";

app.use(pistiMiddleware());
app.get("/api/me", (req, res) => {
    const { isAuthenticated, userId } = getAuth(req);
    if (!isAuthenticated) return res.status(401).end();
    res.json({ userId });
});
```

| Export | What it does | Clerk equivalent |
| --- | --- | --- |
| `pistiMiddleware(options?)` | Verifies the token on every request and sets `req.auth`. Refreshes expired session cookies on page loads with the handshake. Never blocks. | `clerkMiddleware()` |
| `getAuth(req, { acceptsToken? })` | The auth object: `isAuthenticated`, `userId`, `sessionId`, `orgId`, `orgRole`, `orgSlug`, `orgPermissions`, `sessionClaims`, `factorVerificationAge`, `has()`, `getToken()`; or an API key, M2M or OAuth token object when accepted | `getAuth(req, { acceptsToken })` |
| `requireAuth(options?)` | 401 for signed-out requests (or a redirect for pages), 403 when `permission`, `role` or `reverification` fails. Takes `acceptsToken`. | `requireAuth()` |
| `pistiClient` | Backend API client from `PISTI_SECRET_KEY`: `await pistiClient.users.getUser(userId)` | `clerkClient` |
| `verifyWebhook(req)` from `@pisti-paypiller/express/webhooks` | Checks a signed webhook delivery and returns the event | `verifyWebhook(req)` |

Requires Node.js 22.12 or later and Express 5. It is built on
[`@pisti-paypiller/backend`](../backend/README.md), which works without Express.

## 1. Install and configure

```sh
npm install @pisti-paypiller/express
```

Copy the keys from the console (your application → Home and API keys):

```sh
PISTI_PUBLISHABLE_KEY=pk_test_…                     # required: where to verify tokens
PISTI_SECRET_KEY=sk_test_…                          # for pistiClient
PISTI_WEBHOOK_SIGNING_SECRET=whsec_…                # for verifyWebhook
PISTI_AUTHORIZED_PARTIES=https://app.example.com    # recommended in production
PISTI_SIGN_IN_URL=/sign-in                          # optional: where requireAuth() sends pages
PISTI_JWT_KEY="-----BEGIN PUBLIC KEY-----\n…"       # optional: verify without fetching signing keys
```

Each value can also be passed as an option, for example
`pistiMiddleware({ publishableKey, authorizedParties })`.

## 2. Protect routes

```ts
import express from "express";
import { pistiMiddleware, requireAuth, getAuth, pistiClient } from "@pisti-paypiller/express";

const app = express();
app.use(express.json());
app.use(pistiMiddleware());

// Check inside a handler
app.get("/api/feed", (req, res) => {
    const { isAuthenticated, userId } = getAuth(req);
    res.json(isAuthenticated ? personalFeed(userId) : publicFeed());
});

// Look up the full user with the backend API
app.get("/api/profile", requireAuth(), async (req, res) => {
    res.json(await pistiClient.users.getUser(getAuth(req).userId!));
});

// Organization permissions, roles and a recent sign-in
app.post("/api/invoices", requireAuth({ permission: "invoices:write" }), createInvoice);
app.delete("/api/workspace", requireAuth({ role: "owner", reverification: "strict" }), destroy);

// Or the same checks in code
app.post("/api/payouts", (req, res) => {
    const auth = getAuth(req);
    if (!auth.has({ permission: "billing:manage" })) return res.sendStatus(403);
    if (!auth.has({ reverification: { level: "second_factor", afterMinutes: 10 } }))
        return res.status(403).json({ code: "reverification_required" });
    // …
});

// Server-rendered pages: send signed-out browsers to sign-in instead of a 401
app.get("/settings", requireAuth({ signInUrl: "/sign-in" }), renderSettings);
```

The middleware reads the token from the `__session` cookie, which `@pisti-paypiller/react` keeps fresh on
your app's origin, or from `Authorization: Bearer` for APIs on another domain
(`useAuthenticatedFetch()` in React sends it). It checks the signature against your environment's
own keys, its issuer, expiry, that the token belongs to your environment and, when configured, the
requesting origin. A token from another environment fails on both issuer and signature. An expired or
invalid cookie leaves the request signed out; an invalid bearer token answers 401.

`requireAuth()` answers with RFC 9457 problem details: `401 signed_out`, or `403 forbidden` or
`reverification_required`. With `signInUrl` (or `PISTI_SIGN_IN_URL`), browser page requests
are redirected there with `redirect_url` set, and `@pisti-paypiller/react` sends people back after
sign-in.

Reverification presets match Clerk's: `"strict_mfa"` (both factors within 10 minutes),
`"strict"` (second factor within 10 minutes, or the first factor for users without
two-step verification), `"moderate"` (60 minutes), `"lax"` (a day), or
`{ level: "first_factor" | "second_factor" | "multi_factor", afterMinutes }`.

Session tokens last about 60 seconds, so signing out or revoking a session takes effect within a
minute. No session store, Redis or sticky sessions are needed.

### Server-rendered pages: the handshake

Session tokens last 60 seconds and the browser SDK refreshes them while the page is open. When
a visitor returns to a server-rendered page after the cookie expired, `pistiMiddleware()`
answers the page request with a quick redirect through Pisti (Clerk's handshake) that sets a
fresh `__session` cookie and comes back to the same URL. Your route only runs once the cookie
is fresh. API requests are never redirected.

Behind a proxy, set `app.set("trust proxy", …)` (or keep the original `Host` header) so the
middleware builds the return URL on your public origin.

The middleware never rejects a request, so public routes work whatever credential a client
sends. `requireAuth()` reports a bad token (`401`) or a verification that could not run (`503`,
for example an API key without `PISTI_SECRET_KEY`) only for token types the route accepts.

### API keys, M2M and OAuth tokens

Routes accept only session tokens unless they ask for more, like Clerk's `acceptsToken`:

```ts
// Scripts call as a user with an API key created in <APIKeys /> (verified with PISTI_SECRET_KEY)
app.get("/api/v1/projects", requireAuth({ acceptsToken: ["session_token", "api_key"] }), (req, res) => {
    const auth = getAuth(req, { acceptsToken: ["session_token", "api_key"] });
    res.json(listProjects(auth.userId));
});

// Another service calls with client credentials from a confidential OAuth application
app.post("/internal/sync", requireAuth({ acceptsToken: "m2m_token" }), (req, res) => {
    const { machineId } = getAuth(req, { acceptsToken: "m2m_token" });
    // …
});
```

A machine service gets its M2M token from `POST /connect/token` with
`grant_type=client_credentials`, its client ID and secret.

## 3. Backend API

```ts
import { pistiClient, PistiManagementError } from "@pisti-paypiller/express";

const user = await pistiClient.users.getUser(userId);
const { items, nextCursor } = await pistiClient.users.getUserList({ limit: 50, search: "alex" });
const total = await pistiClient.users.getCount();
const { items: sessions } = await pistiClient.sessions.getSessionList({ userId, status: "active" });
for await (const each of pistiClient.users.getUserListAll()) {
    // …
}
await pistiClient.users.banUser(userId);
await pistiClient.organizations.createOrganizationInvitation(orgId, { email, roleId });
```

`pistiClient` is created from `PISTI_SECRET_KEY` and `PISTI_PUBLISHABLE_KEY` the first time you
use it. See [`@pisti-paypiller/backend`](../backend/README.md#backend-api) for every resource and its errors.

## 4. Webhooks

```ts
import express from "express";
import { verifyWebhook } from "@pisti-paypiller/express/webhooks";

// Register before app.use(express.json()) so the body stays raw.
app.post("/api/webhooks", express.raw({ type: "application/json" }), async (req, res) => {
    try {
        const event = await verifyWebhook(req);
        // Events are typed and thin: read the current user with the backend API.
        if (event.type === "user.created") await createLocalUser(await pistiClient.users.getUser(event.data.id));
        res.sendStatus(204);
    } catch {
        res.sendStatus(400);
    }
});
```

It checks the HMAC-SHA256 signature and the signed timestamp (five minutes' tolerance) before
parsing. Pass `{ signingSecret: [current, previous] }` while rotating. Store `event.id` to ignore
duplicates.

## Deploying

- Set the variables above in your host's environment. Use the production environment's
  `pk_live_` / `sk_live_` keys; they require HTTPS.
- Verification is stateless and works on servers, containers and serverless functions alike.
  Each environment's signing keys are fetched from its issuer once per process, cached, and
  refetched when a token is signed with a newly rotated key.
- Never send `PISTI_SECRET_KEY` to a browser.

See `docs/sdk.md` in pisti-sdks for how the pieces fit, and `pisti-demo`
in the pisti-examples repository for a working example.
