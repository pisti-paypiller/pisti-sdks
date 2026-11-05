# pisti-sdks

The Pisti customer SDKs.

| Package | Purpose |
| --- | --- |
| [`@pisti/react`](react/README.md) | `<PistiProvider>`, `<Show>`, hooks, prebuilt sign-in, sign-up, user and organization components |
| [`@pisti/express`](express/README.md) | `pistiMiddleware()`, `getAuth(req)`, `requireAuth()`, `pistiClient` and webhook verification for Express 5 |
| [`@pisti/backend`](backend/README.md) | Framework-free core: `createPistiClient()`, `authenticateRequest()`, `verifyToken()`, backend API and webhooks |

The packages talk to the Pisti API (pisti-backend) only over HTTP; its contract is
pisti-backend `openapi/v1.json`. They share one version and are released together.
See pisti-docs `sdk.md` for how they fit together.

## Build

This repository is an npm workspace with one lock file:

```bash
npm ci
npm run build
```

`npm run pack` writes `pisti-backend-<version>.tgz`, `pisti-express-<version>.tgz`
and `pisti-react-<version>.tgz` to this directory. Install those tarballs in an app
to try changes before they are published.

## Publish

```bash
npm publish --workspaces
```

Bump the `version` in all three `package.json` files, and `@pisti/express`'s
dependency on `@pisti/backend`, together before publishing.
