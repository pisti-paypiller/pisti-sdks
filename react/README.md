# @pisti-paypiller/react

Pisti for React, shaped like `@clerk/react`: one provider, prebuilt sign-in and account
components, and hooks. It talks to your environment's Frontend API directly from the browser;
the publishable key is the only required setting. Supports React 18.3 and 19.

```tsx
import { PistiProvider, Show, SignInButton, SignUpButton, UserButton } from "@pisti-paypiller/react";
import "@pisti-paypiller/react/styles.css";

export function App() {
    return (
        <PistiProvider>
            <header>
                <Show when="signed-out">
                    <SignInButton />
                    <SignUpButton />
                </Show>
                <Show when="signed-in">
                    <UserButton />
                </Show>
            </header>
        </PistiProvider>
    );
}
```

That's a working app. `<PistiProvider>` reads `VITE_PISTI_PUBLISHABLE_KEY` (or
`PISTI_PUBLISHABLE_KEY`) by itself, `SignInButton` opens sign-in in a modal and `UserButton`
gives the signed-in user Manage account and Sign out.

## Install

```sh
npm install @pisti-paypiller/react
```

```sh
VITE_PISTI_PUBLISHABLE_KEY=pk_test_…
```

Apps on `http://localhost` work with development environments as they are. For production, add
your app's origin under Domains & paths in the console.

## Dedicated pages and your router

```tsx
import { BrowserRouter, Routes, Route, useNavigate } from "react-router";
import { PistiProvider, SignIn, SignUp, Show, RedirectToSignIn } from "@pisti-paypiller/react";

function PistiWithRouter({ children }: { children: React.ReactNode }) {
    const navigate = useNavigate();
    return (
        <PistiProvider
            signInUrl="/sign-in"
            signUpUrl="/sign-up"
            signInFallbackRedirectUrl="/dashboard"
            afterSignOutUrl="/"
            routerPush={(to) => navigate(to)}
            routerReplace={(to) => navigate(to, { replace: true })}
        >
            {children}
        </PistiProvider>
    );
}

const Protected = ({ children }: { children: React.ReactNode }) => (
    <Show when="signed-in" fallback={<RedirectToSignIn />}>
        {children}
    </Show>
);

export const App = () => (
    <BrowserRouter>
        <PistiWithRouter>
            <Routes>
                <Route path="/sign-in" element={<SignIn />} />
                <Route path="/sign-up" element={<SignUp />} />
                <Route path="/dashboard" element={<Protected><Dashboard /></Protected>} />
            </Routes>
        </PistiWithRouter>
    </BrowserRouter>
);
```

After sign-in, visitors go to the first of: `forceRedirectUrl` (prop, then provider),
`redirect_url` in the URL (set by `RedirectToSignIn` and `requireAuth()`), `fallbackRedirectUrl`
(prop, then provider), the console's Domains & paths setting, then `/`. Sign-up works the same
way with the `signUp…` props. A signed-in visitor who opens `/sign-in` goes straight on, and with
`routerPush` none of this reloads the page. Without a `signInUrl`, buttons and redirects open the
modal.

### Provider props

Each prop falls back to an environment variable, so most apps pass none.

| Prop | Environment variable | Default |
| --- | --- | --- |
| `publishableKey` | `VITE_PISTI_PUBLISHABLE_KEY` | Required |
| `signInUrl`, `signUpUrl` | `VITE_PISTI_SIGN_IN_URL`, `VITE_PISTI_SIGN_UP_URL` | Console setting, else modals |
| `signInFallbackRedirectUrl`, `signUpFallbackRedirectUrl` | `VITE_PISTI_SIGN_IN_FALLBACK_REDIRECT_URL`, `VITE_PISTI_SIGN_UP_FALLBACK_REDIRECT_URL` | Console setting, then `/` |
| `signInForceRedirectUrl`, `signUpForceRedirectUrl` | `VITE_PISTI_SIGN_IN_FORCE_REDIRECT_URL`, `VITE_PISTI_SIGN_UP_FORCE_REDIRECT_URL` | None |
| `afterSignOutUrl` | `VITE_PISTI_AFTER_SIGN_OUT_URL` | Console setting, then `/` |
| `allowedRedirectOrigins` | — | Your app's origin |
| `routerPush`, `routerReplace` | — | Full page navigation |
| `appearance` | — | `{ variables: { colorPrimary, colorPrimaryText, colorBackground, colorText, colorTextSecondary, colorBorder, borderRadius, fontFamily } }` |
| `handleInvitations` | — | `true`: handles `#pisti_invitation=` organization invitation links |

## Components

| Component | What it does |
| --- | --- |
| `<SignIn />` | Password or email code, two-step verification (including required enrollment and recovery codes), password reset and reactivating a deactivated account. `forceRedirectUrl`, `fallbackRedirectUrl`, `signUpUrl`. |
| `<SignUp />` | Email verification by code, name and optional password. `forceRedirectUrl`, `fallbackRedirectUrl`, `signInUrl`. |
| `<Show when fallback>` | Renders for `"signed-in"`, `"signed-out"`, `{ permission }`, `{ role }` or `(has) => boolean` |
| `<SignInButton />`, `<SignUpButton />` | `mode="modal"` or `"redirect"` (the default when you have a sign-in page), `forceRedirectUrl`, `fallbackRedirectUrl`. Pass your own button as the child to style it. |
| `<SignOutButton redirectUrl? />` | Signs out, then goes to `redirectUrl` or `afterSignOutUrl`. Accepts a custom child. |
| `<UserButton />` | Avatar menu. `userProfileMode="navigation"` with `userProfileUrl` for your own page, or `"modal"` (default). `showName`. |
| `<RedirectToSignIn />`, `<RedirectToSignUp />` | Redirect on render |
| `<PistiLoaded>`, `<PistiLoading>` | Render after and before the session is known |
| `<UserProfile apiKeys? />` | Profile, email, password, two-step verification, recovery codes, devices; with `apiKeys`, an API keys page |
| `<APIKeys />` | Lets the user create, copy and revoke `ak_…` keys for your API. Your backend accepts them with `acceptsToken: "api_key"`. |
| `<OrganizationSwitcher />`, `<CreateOrganization />`, `<OrganizationProfile />`, `<AcceptOrganizationInvitation />` | Organizations, members, roles, invitations |

## Hooks

| Hook | Returns |
| --- | --- |
| `useAuth()` | `isLoaded`, `isSignedIn`, `userId`, `sessionId`, `orgId`, `orgSlug`, `orgRole`, `sessionClaims`, `has({ permission, role })`, `getToken()`, `signOut()` |
| `useUser()` | `user`: `id`, `firstName`, `lastName`, `fullName`, `primaryEmailAddress.emailAddress`, `imageUrl`, `hasImage` |
| `useSession()` | `session`: `id` and `user` |
| `usePisti()` | The client: `openSignIn()`, `openSignUp()`, `openUserProfile()`, `closeModal()`, `redirectToSignIn()`, `navigate()`, `signOut()`, `getToken()` |
| `useAuthenticatedFetch()` | `fetch` with the session token as `Authorization: Bearer`; retries once on 401 |
| `useSignIn()`, `useSignUp()` | The individual steps, for fully custom forms |
| `useOrganization()` | Active organization, role, permissions, `setActive(id \| null)` |
| `useOrganizationList()`, `useAccount()` | Organization and account resources |
| `useReverification(fn)` | Runs `fn`, asking for the password again if the server needs a recent sign-in |

## Calling your API

```tsx
const fetchWithSession = useAuthenticatedFetch();
const response = await fetchWithSession("https://api.example.com/projects");
```

The SDK keeps a session token (about 60 seconds) fresh in the `__session` cookie on your app's
origin, so same-site API routes receive it automatically. It also writes `__client_uat`, the
session's sign-in time (or `0` when signed out), which lets server-rendered pages refresh an
expired cookie with a handshake instead of treating the visitor as signed out. For APIs on another domain use
`useAuthenticatedFetch()` or `getToken()`. Verify the token on the server with
[`@pisti-paypiller/express`](../express/README.md) or [`@pisti-paypiller/backend`](../backend/README.md).
`<Show>` and `isSignedIn` only control rendering; your API must enforce access.

## Deploying

The SDK is static browser code; build and host your app anywhere. For production, use the
`pk_live_` key, serve over HTTPS, and add your app's origin under Domains & paths.

See `docs/sdk.md` in pisti-sdks for how the pieces fit, and `pisti-demo`
in the pisti-examples repository for a working example.
