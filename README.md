# pisti-sdks

The Pisti customer SDKs.

| Package | Purpose |
| --- | --- |
| [`@pisti-paypiller/react`](react/README.md) | `<PistiProvider>`, `<Show>`, hooks, prebuilt sign-in, sign-up, user and organization components |
| [`@pisti-paypiller/express`](express/README.md) | `pistiMiddleware()`, `getAuth(req)`, `requireAuth()`, `pistiClient` and webhook verification for Express 5 |
| [`@pisti-paypiller/backend`](backend/README.md) | Framework-free core: `createPistiClient()`, `authenticateRequest()`, `verifyToken()`, backend API and webhooks |

The packages talk to the Pisti API (pisti-backend) only over HTTP; its contract is
pisti-backend `openapi/v1.json`. They share one version and are released together.
See pisti-docs `sdk.md` for how they fit together.

## Build

This repository is an npm workspace with one lock file:

```bash
npm ci
npm run build
```

`npm run pack` writes `pisti-paypiller-backend-<version>.tgz`, `pisti-paypiller-express-<version>.tgz`
and `pisti-paypiller-react-<version>.tgz` to this directory. Install those tarballs in an app
to try changes before they are published.

## Publish

The packages are MIT licensed and published publicly to npm under the `@pisti-paypiller` scope,
which belongs to the npm organization `pisti-paypiller`. Releases are published only by the
[release workflow](.github/workflows/release.yml), which runs when a `v<version>` tag is
pushed, checks that the tag matches every package version, builds, and publishes all three.

**Trusted publishing.** npm trusts only GitHub Actions runs of `release.yml` in
`pisti-paypiller/pisti-sdks` to publish these packages, so no npm token exists. This is set
per package on npmjs.com under Settings → Trusted publishing, with publishing access set to
"Require two-factor authentication and disallow tokens".

**Releasing.**

1. Set the same new `version` in `backend`, `express` and `react`, and set `@pisti-paypiller/express`'s
   dependency on `@pisti-paypiller/backend` to that exact version.
2. Run `npm install` so `package-lock.json` matches, then commit and push.
3. Tag and push: `git tag v0.7.2 && git push origin v0.7.2`.

Each release carries npm provenance, which links every published version to the commit and
workflow run that built it. A published version can never be reused; fix a bad release
with a new version. The packages stay below `1.0.0` until the first production release.

## License

[MIT](LICENSE)
