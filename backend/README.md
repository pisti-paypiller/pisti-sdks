# @pisti-paypiller/backend

The framework-free Pisti server SDK, shaped like `@clerk/backend`: authenticate any Fetch API
`Request` (session cookies with the handshake, session tokens, API keys, M2M and OAuth tokens),
call the backend API and verify webhooks. Express apps should use
[`@pisti-paypiller/express`](../express/README.md), which is built on this package.

```ts
import { createPistiClient } from "@pisti-paypiller/backend";

const pisti = createPistiClient({
    secretKey: process.env.PISTI_SECRET_KEY,
    publishableKey: process.env.PISTI_PUBLISHABLE_KEY,
});

// Next.js route handler, Hono, Bun.serve, Deno, Cloudflare Workers…
export async function GET(request: Request) {
    const state = await pisti.authenticateRequest(request, {
        authorizedParties: ["https://app.example.com"],
    });
    if (state.status === "handshake") return new Response(null, { status: 307, headers: state.headers });
    if (!state.isAuthenticated) return new Response("Unauthorized", { status: 401 });
    const { userId } = state.toAuth();
    return Response.json(await pisti.users.getUser(userId));
}
```

| Export | What it does | Clerk equivalent |
| --- | --- | --- |
| `createPistiClient(options?)` | A `PistiClient` with `authenticateRequest()`, `verifyToken()` and the backend API resources | `createClerkClient()` |
| `authenticateRequest(request, options?)` | Returns a `RequestState`: `status` (`signed-in`, `signed-out`, `handshake`), `isAuthenticated`, `reason`, `headers`, `toAuth()`. Never throws for a bad token. | `authenticateRequest()` |
| `verifyToken(token, options?)` | Verifies a session token and returns its claims, or throws `PistiError` (401, `token_expired` or `invalid_token`) | `verifyToken()` |
| `verifyWebhook(request, options?)` | Verifies a webhook from a Fetch `Request` (or `{ body, headers }`) and returns a typed event | `verifyWebhook()` |
| `parsePublishableKey(key)` | Decodes the Frontend API URL from a publishable key | — |

Requires Node.js 22.12 or later, or any runtime with `fetch` and Web Crypto.

## Configuration

Every option falls back to an environment variable:

| Option | Variable | Used for |
| --- | --- | --- |
| `publishableKey` | `PISTI_PUBLISHABLE_KEY` | Finding the environment's issuer (`{api}/i/{frontendApiId}`) and checking the token's environment. Required. |
| `secretKey` | `PISTI_SECRET_KEY` | The backend API and verifying API keys |
| `jwtKey` | `PISTI_JWT_KEY` | Networkless verification with the PEM public key from the console (API keys → JWT public key). Replace it after rotating the environment's signing keys. Without it, the environment's signing keys are fetched from its issuer, cached, and refetched when a rotated key appears. |
| `authorizedParties` | `PISTI_AUTHORIZED_PARTIES` (comma-separated) | Origins allowed to have requested session tokens. Recommended in production. |
| `signingSecret` (webhooks) | `PISTI_WEBHOOK_SIGNING_SECRET` | Webhook signatures |

## Authenticating requests

`authenticateRequest` reads `Authorization: Bearer` first, then the `__session` cookie.

**Session cookies and the handshake.** `@pisti-paypiller/react` keeps `__session` (a 60-second session
token) and `__client_uat` (the last sign-in time) on your origin. When a page request arrives
with an expired or missing session cookie but `__client_uat` says the visitor is signed in, the
state is `status: "handshake"`: respond with a `307` and `state.headers`. The browser goes through
your environment's Frontend API and returns to the same URL with an opaque, one-minute nonce,
which `authenticateRequest` redeems with your secret key for a fresh session cookie, so
server-rendered pages never show a signed-in visitor as signed out and no token ever appears in
a URL. The handshake needs `PISTI_SECRET_KEY` (or `{ secretKey }`); without it, expired cookies
are treated as signed out. API requests are never redirected; they are signed out until the
browser SDK refreshes the cookie.

**Token types.** `acceptsToken` chooses what a route accepts, like Clerk:

| `acceptsToken` | Token | `toAuth()` |
| --- | --- | --- |
| `"session_token"` (default) | Session token from `@pisti-paypiller/react` | `userId`, `sessionId`, `orgId`, `orgRole`, `orgSlug`, `orgPermissions`, `sessionClaims`, `factorVerificationAge`, `has()`, `getToken()` |
| `"api_key"` | An end user's `ak_…` key, created with `<APIKeys />`; verified with the backend API, and a successful verification is reused for up to 10 seconds per process | `id`, `name`, `subject`, `userId`, `scopes`, `claims` |
| `"m2m_token"` | Client-credentials token from a confidential OAuth application | `id`, `subject`, `machineId`, `scopes`, `claims` |
| `"oauth_token"` | Access token Pisti issued to an OAuth application for a user | `id`, `userId`, `clientId`, `scopes`, `claims` |
| an array or `"any"` | Any of those | Narrow with `tokenType` |

A token of a type the route doesn't accept is signed out with `reason: "token-type-mismatch"`.

`has({ permission, role, reverification })` on session auth objects matches Clerk's, including
the reverification presets `"strict_mfa"`, `"strict"`, `"moderate"` and `"lax"` or
`{ level, afterMinutes }`.

## Backend API

```ts
import { createPistiClient, PistiManagementError } from "@pisti-paypiller/backend";

const pisti = createPistiClient();
const user = await pisti.users.getUser(userId);
const { items, nextCursor } = await pisti.users.getUserList({ limit: 50, search: "alex" });
const total = await pisti.users.getCount({ status: "active" });
const { items: sessions } = await pisti.sessions.getSessionList({ userId, status: "active" });
await pisti.apiKeys.revokeApiKey(keyId, { revocationReason: "Leaked in a log" });
```

| Resource | Methods |
| --- | --- |
| `users` | `getUserList`, `getUserListAll`, `getCount`, `getUser`, `createUser`, `updateUser`, `deleteUser`, `banUser`, `unbanUser`, `lockUser`, `unlockUser`, `getUserEmailAddressList`, `addEmailAddress`, `setEmailVerification`, `setPrimaryEmail`, `removeEmailAddress`, `getUserExternalAccountList` |
| `sessions` | `getSessionList({ userId, status })`, `getSession`, `revokeSession` |
| `apiKeys` | `getApiKeyList({ userId, includeRevoked })`, `getApiKey`, `updateApiKey(id, { scopes, claims })`, `revokeApiKey`, `verifySecret` |
| `organizations` | `getOrganizationList`, `getOrganization`, `createOrganization`, `updateOrganization`, `deleteOrganization`, `getOrganizationMembershipList`, `updateOrganizationMembership`, `deleteOrganizationMembership`, `getOrganizationInvitationList`, `createOrganizationInvitation`, `resendOrganizationInvitation`, `revokeOrganizationInvitation`, `getRoleList`, `createRole`, `updateRole`, `deleteRole`, `getPermissionList` |
| `webhooks` | `catalog`, `endpoints`, `createEndpoint`, `updateEndpoint`, `archiveEndpoint`, `rotateSecret`, `sendTest`, `deliveries`, `delivery`, `replay` |
| `externalProviders` | `list`, `create`, `update`, `delete` |

`getUser`, `getUserList` and `createUser` return the same `User`: `id`, `firstName`, `lastName`,
`fullName`, `imageUrl`, `hasImage`, `primaryEmailAddressId`, `emailAddresses`, `status`,
`banned`, `locked`, the metadata objects and timestamps. `getInstance()` returns the
environment, including its `issuerUrl` and `jwtKey`.

Pass `{ signal }` to cancel; `timeoutMs` defaults to 10 seconds; mutations are never retried
automatically. Errors are `PistiManagementError` with `status`, `requestId`, `code`,
`fieldErrors`, `blockers` and `retryAfterSeconds`. The client refuses to run in a browser.
Secret keys cannot create API keys, confidential OAuth applications or client secrets; those
need a signed-in user or console member.

## Webhooks

```ts
import { verifyWebhook } from "@pisti-paypiller/backend/webhooks";

export async function POST(request: Request) {
    try {
        const event = await verifyWebhook(request);
        if (event.type === "organizationMembership.created") await addMember(event.data.organization_id, event.data.user_id);
        return new Response(null, { status: 204 });
    } catch {
        return new Response("Invalid signature", { status: 400 });
    }
}
```

`PistiWebhookEvent` is a union keyed by `type`, so checking `event.type` narrows `event.data`.
Events are thin: `data` holds the resource's ID and references; read the current state with
the backend API. Verification checks the HMAC-SHA256 signature and timestamp (five minutes'
tolerance) on the raw body. Pass `{ signingSecret: [current, previous] }` while rotating and
`{ expectedInstanceId }` to pin events to one environment. Store `event.id` to ignore
duplicates.

See `docs/sdk.md` in pisti-sdks for how the pieces fit.
