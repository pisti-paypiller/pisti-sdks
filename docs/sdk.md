# Customer SDKs

Three packages integrate customer applications. Their APIs follow Clerk's so that the same
patterns work: `@pisti-paypiller/react` mirrors `@clerk/react`, `@pisti-paypiller/express` mirrors
`@clerk/express` and `@pisti-paypiller/backend` mirrors `@clerk/backend`. All share one version and are released
together from the pisti-sdks repository (an npm workspace with one lock file) and published
publicly on npm under the `@pisti-paypiller` scope, with npm provenance. `pisti-examples/pisti-demo` uses React and Express end to end.

| Package | Use | Details |
| --- | --- | --- |
| `@pisti-paypiller/react` | `<PistiProvider>`, `<Show>`, hooks, prebuilt `<SignIn />`, `<SignUp />`, `<UserButton />`, account and organization components | `pisti-sdks/react/README.md` |
| `@pisti-paypiller/express` | `pistiMiddleware()`, `getAuth(req)`, `requireAuth()`, `pistiClient` and `verifyWebhook(req)` for Express 5 | `pisti-sdks/express/README.md` |
| `@pisti-paypiller/backend` | Framework-free core: `createPistiClient()`, `authenticateRequest(request)`, `verifyToken()`, the backend API and webhook verification | `pisti-sdks/backend/README.md` |

## Keys

An application environment has two kinds of key:

- **Publishable key** (`pk_test_…` / `pk_live_…`): base64url of the environment's own host
  followed by `$`, for example `https://auth.acme.com$` in production or
  `https://quiet-fox-12.<dev-domain>$` for a development environment. Safe for browsers. The
  host serves the environment's Frontend API and account API (`/v1/…`), and with a trailing
  slash it is the environment's issuer (`https://auth.acme.com/`).
- **Secret key** (`sk_test_…` / `sk_live_…`): an environment API key created under API keys
  in the console. It authenticates the management API (`/v1/instance`, `/v1/management/…`) at
  `https://pisti-api.paypiller.com`, or wherever `apiUrl`/`PISTI_API_URL` points. Never ship it
  to browsers.

## How a sign-in works

1. `<PistiProvider>` (key from `VITE_PISTI_PUBLISHABLE_KEY`) loads `GET {host}/v1/environment` (sign-in
   methods and providers, signup policy, multi-session, paths) and `GET {host}/v1/client`, the
   browser client's sessions.
2. `<SignIn />` and `<SignUp />` work through sign-in and sign-up attempts, like Clerk's
   resources: `client.signIn.create()`, `prepareFirstFactor()`, `attemptFirstFactor()`,
   `attemptSecondFactor()`, and `client.signUp.create()`, `update()`, `prepareVerification()`,
   `attemptVerification()` (`POST {host}/v1/client/sign_ins` and `sign_ups`). The first attempt
   creates the browser client and its `pisti_client` cookie. Passkeys (`client.signIn.passkey()`)
   and upstream providers (`client.signIn.withProvider("oauth_{id}")`, which returns to the page,
   where `client.handleRedirectCallback()` finishes) are offered when the environment enables
   them. A completed attempt creates a session in the browser client; with multi-session on, a
   browser holds several (`client.sessions`, `client.setActive(id)`).
3. The SDK requests a session token (`POST {host}/v1/client/sessions/{id}/tokens`, about 60 seconds),
   writes it to the `__session` cookie on the app's origin and refreshes it in the
   background. `useAuthenticatedFetch()` also sends it as a bearer header.
4. `pistiMiddleware()` from `@pisti-paypiller/express` (configured from `PISTI_PUBLISHABLE_KEY`)
   verifies the token offline against the environment's issuer and its published signing keys
   (discovery and JWKS under the issuer), checks the `session+jwt` type, the `pisti:session` audience, and `ptyp`,
   and optional authorized parties, and exposes a Clerk-shaped auth object through
   `getAuth(req)`: `isAuthenticated`, `userId`, `sessionId`, `orgId`, `orgRole`,
   `sessionClaims`, `factorVerificationAge` and `has({ permission, role, reverification })`.
   `authenticateRequest(request)` from `@pisti-paypiller/backend` does the same for Fetch API runtimes.
   A page request whose cookie expired gets the handshake (`pisti-backend/docs/authentication.md#handshake`): a
   redirect through the Frontend API that refreshes `__session` and returns to the page.
5. Account and organization components call `/v1/account/*` on the environment's host with
   the session token as a bearer credential, including adding passkeys
   (`useAccount().addPasskey(name)`), connecting providers (`useAccount().connect(id)`), and
   managing email addresses and the username (`useAccount().identifiers()`, `addEmailAddress`,
   `verifyEmailAddress`, `makePrimaryEmailAddress`, `removeEmailAddress`, `setUsername`).
   Where the environment uses usernames, `<SignIn />` accepts one and `<SignUp />` asks for it.

See authentication (`pisti-backend/docs/authentication.md#frontend-api`) for the endpoint list and token claims.

## Machine access

Besides session tokens, backends can accept three bearer tokens with `acceptsToken`:

- **API keys** (`ak_…`): end users create them in `<APIKeys />` to call your API as
  themselves (creating one may ask them to confirm their identity). Keys start with no scopes
  or claims; your backend grants them with `apiKeys.updateApiKey`. A key stops working when its
  owner's credentials change. Backends verify keys with the secret key. Each process reuses a
  successful verification for up to 10 seconds, so a revoked key can keep working that long.
- **M2M tokens**: confidential OAuth applications with machine access turned on use the client-credentials grant to call
  your API as a machine.
- **OAuth access tokens**: issued to OAuth applications on a user's behalf.

M2M and OAuth tokens are JWTs verified offline like session tokens. They must be typed `at+jwt`
and are told apart by `ptyp`.
With `jwtKey` (`PISTI_JWT_KEY`, the console's JWT public key) no JWT verification needs the
network. Signing keys rotate on a schedule and the next key is published before it signs: while
`client.getInstance()` returns a `nextJwtKey`, set `PISTI_JWT_KEY` to both PEM blocks, one after
the other, and drop the old one after the switch. Without it, the SDKs cache
the environment's JWKS and refetch it when a token carries a new `kid`.

## Development and production

Development environments run on a generated host that is never the app's own site, so
they accept any `localhost` origin and also take the browser client token in an
`X-Pisti-Client` header that the SDK keeps in `localStorage`. The SDK also copies the token
into a `__pisti_client` cookie on the app's origin; the server SDK forwards it on the
handshake redirect, which cannot carry a header. Production environments run on the
customer's own subdomain, accept only origins listed under Domains & paths and rely on the
first-party `pisti_client` cookie (`SameSite=Lax`) alone.

## Backend API client

`createPistiClient({ secretKey, publishableKey })` from `@pisti-paypiller/backend` returns a
`PistiClient`; `pistiClient` from `@pisti-paypiller/express` is one created from `PISTI_SECRET_KEY` and
`PISTI_PUBLISHABLE_KEY` on first use. It wraps `/v1/management` with Clerk-style method names
(`users.getUser`, `users.getUserList`, `users.getCount`, `users.banUser`,
`sessions.getSessionList`, `apiKeys.verifySecret`, `organizations.getOrganizationList`,
`organizations.createOrganizationInvitation`) and also offers `authenticateRequest()` and
`verifyToken()`. Webhook events are a typed union keyed by `type`. `verifyWebhook(req)` from
`@pisti-paypiller/express/webhooks` (or `@pisti-paypiller/backend/webhooks` for a Fetch `Request`) reads
`PISTI_WEBHOOK_SIGNING_SECRET`.

## Redirects in React

`<PistiProvider>` accepts `signInUrl`, `signUpUrl`, `signInFallbackRedirectUrl`,
`signUpFallbackRedirectUrl`, `signInForceRedirectUrl`, `signUpForceRedirectUrl`,
`afterSignOutUrl` and `allowedRedirectOrigins`, each also read from a `VITE_PISTI_…`
environment variable, plus `routerPush`/`routerReplace` so redirects stay inside a single-page
app. After sign-in the order is: force redirect, `redirect_url`, fallback redirect, the
environment's Domains & paths setting (`afterSignInUrl`, `afterSignUpUrl`), then `/`.
`<RedirectToSignIn />` and `requireAuth({ signInUrl })` add the `redirect_url`. Without a
sign-in page, buttons and redirects open the provider's sign-in modal.

## Standard OpenID Connect

Apps that use their own OIDC library, and third-party apps, register an **OAuth
application** (an OpenIddict client) instead. See authentication (`pisti-backend/docs/authentication.md#hosted-openid-connect`).
