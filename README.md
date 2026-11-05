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

The packages are MIT licensed and published publicly to npm under the `@pisti` scope,
which belongs to the npm organization `pisti`. Releases are published only by the
[release workflow](.github/workflows/release.yml), which runs when a `v<version>` tag is
pushed, checks that the tag matches every package version, builds, and publishes all three.

**First release.** npm can only trust a workflow for a package that already exists, so the
first release authenticates with a token:

1. On npmjs.com, create a granular access token with read and write access to the
   `@pisti` scope (organization `pisti`), "Bypass two-factor authentication" enabled, and
   a short expiry.
2. In this repository, add it as the Actions secret `NPM_TOKEN`:
   `gh secret set NPM_TOKEN --repo pisti-paypiller/pisti-sdks` (paste the token when asked).
3. Push the tag for the current version: `git tag v0.7.0 && git push origin v0.7.0`.

**Trusted publishing.** After the first release, open each package on npmjs.com, go to
Settings → Trusted publishing, and add GitHub Actions with organization
`pisti-paypiller`, repository `pisti-sdks` and workflow `release.yml`. Set publishing access
to "Require two-factor authentication and disallow tokens", then delete the `NPM_TOKEN`
secret and revoke the token.

**Every later release.**

1. Set the same new `version` in `backend`, `express` and `react`, and set `@pisti/express`'s
   dependency on `@pisti/backend` to that exact version.
2. Run `npm install` so `package-lock.json` matches, then commit and push.
3. Tag and push: `git tag v0.7.1 && git push origin v0.7.1`.

A published version can never be reused; fix a bad release with a new version. npm adds
provenance only for packages built from a public repository. The packages stay below
`1.0.0` until the first production release.

## License

[MIT](LICENSE)
