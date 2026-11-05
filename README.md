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
which belongs to the npm organization `pisti`.

**First release (once, by hand).** npm only lets you set up trusted publishing for a
package that already exists, so publish `0.7.0` from a machine signed in to an npm account
that is a member of the `pisti` organization:

```bash
npm login
npm ci
npm run build
npm publish --workspaces
```

**Trusted publishing.** On npmjs.com, open each package, go to Settings → Trusted
publishing, and add GitHub Actions with organization `pisti-paypiller`, repository
`pisti-sdks`, workflow `release.yml` and environment `npm`. Then set publishing access to
"Require two-factor authentication and disallow tokens".

**Every later release.**

1. Set the same new `version` in `backend`, `express` and `react`, and set `@pisti/express`'s
   dependency on `@pisti/backend` to that exact version.
2. Run `npm install` so `package-lock.json` matches, then commit.
3. Tag and push: `git tag v0.7.1 && git push origin v0.7.1`.

The [release workflow](.github/workflows/release.yml) checks that the tag matches every
version, builds, and publishes all three packages with provenance. A published version
can never be reused; fix a bad release with a new version.

The packages stay below `1.0.0` until the first production release.

## License

[MIT](LICENSE)
