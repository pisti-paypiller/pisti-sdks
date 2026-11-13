# pisti-sdks

The Pisti customer SDKs: `@pisti-paypiller/backend`, `@pisti-paypiller/express` and `@pisti-paypiller/react`.

For structural exploration use the installed codebase-memory skill. Check exact
path coverage and read current source when the graph is stale.

## Repositories

Pisti is four independent repositories: pisti-backend, pisti-apps, pisti-sdks and
pisti-examples. Each one builds and runs on its own. They connect
only over HTTP, through the API described by pisti-backend `openapi/v1.json`, and
through the published `@pisti-paypiller/*` npm packages.

- Never reference another repository's files by relative path, mount, include or
  `file:` dependency, and never assume a sibling checkout exists.
- Refer to another repository's files in prose as `<repository>/<path>`, for example
  `pisti-apps/docs/portals.md`.

## Project stage: development (pre-production)

Nothing is deployed and there is no customer data. Until the first production
release, choose the correct design over compatibility:

- Breaking changes to APIs, SDKs, DTOs, routes, flows and the database schema are
  allowed. Do not add compatibility shims, deprecated aliases, dual code paths or
  legacy fallbacks unless asked.
- A breaking API change starts in pisti-backend and regenerates `openapi/v1.json`.
  Then pisti-sdks, pisti-apps and pisti-examples are updated, each in
  its own repository. Use the same branch name in every affected repository and
  link the changes to each other.
- Remove dead code and obsolete scripts instead of keeping them "for history".
- Fix root causes and redesign weak flows when needed; record anything deferred in
  `pisti-backend/docs/roadmap.md`.

When the first production release is cut, replace this section with production
rules: a versioned public API (a new `/v2` instead of breaking `/v1`), semantically
versioned SDKs, and additive or reviewed data-preserving migrations.

## Documentation

- The guides in pisti-backend/docs, pisti-apps/docs and pisti-sdks/docs describe the system as it is now; pisti-backend/docs/README.md is the index. When a
  change alters behavior, the API, configuration or the schema, update the relevant
  guide as well. Do not add changelogs, history, review logs or
  implementation diaries.
- `pisti-backend/docs/roadmap.md` is the single list of known gaps and pre-production work.
- READMEs in this repository cover only its own components and point to the shared
  guides by name for shared topics.

## API contract

- The backend API is described by pisti-backend `openapi/v1.json`. Build against it,
  not against backend source.
- Application JSON routes under `/api` and `/v1` return `{ data, meta: { requestId } }`
  on success and RFC 9457 Problem Details on failure. 204 responses have no body.

## Packages

- `backend` (`@pisti-paypiller/backend`) is the framework-free server core. `express`
  (`@pisti-paypiller/express`) builds on it. `react` (`@pisti-paypiller/react`) is the browser SDK and
  talks only to the environment's own host (its Frontend API and account API, `/v1/…`).
- The three packages share one version and are released together. `@pisti-paypiller/express`
  depends on `@pisti-paypiller/backend` by exact version; npm workspaces link it locally.
- The root `package.json` is a private workspace manifest with the single lock file.
  Each package keeps its own build scripts and `tsconfig.json`.
- Never send the secret key to a browser, and keep session verification offline
  (signed JWTs) in the server packages.
- Keep each package README in step with its exported API.
- This repository is public. The packages are MIT licensed and public on npm under `@pisti-paypiller`. Each package
  directory keeps a copy of the root LICENSE because npm packs only that directory.
- Releases are published only by `.github/workflows/release.yml` when a `v<version>`
  tag is pushed, through npm trusted publishing. Never add an npm token.

## Build

- `npm ci && npm run build` at the repository root builds every package in
  dependency order; `npm run pack` writes installable tarballs. Files use LF line
  endings.
- `npm test` runs the Vitest suites in each package's `test/` directory. They run
  offline: tokens are signed with keys generated per run and verified through
  `jwtKey`. Every check that rejects a token, handshake or webhook has a test;
  keep it that way when changing verification.
