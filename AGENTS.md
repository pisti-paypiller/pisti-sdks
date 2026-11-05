# pisti-sdks

The Pisti customer SDKs: `@pisti-paypiller/backend`, `@pisti-paypiller/express` and `@pisti-paypiller/react`.

For structural exploration use the installed codebase-memory skill. Check exact
path coverage and read current source when the graph is stale.

## Repositories

Pisti is five independent repositories: pisti-backend, pisti-apps, pisti-sdks,
pisti-examples and pisti-docs. Each one builds and runs on its own. They connect
only over HTTP, through the API described by pisti-backend `openapi/v1.json`, and
through the published `@pisti-paypiller/*` npm packages.

- Never reference another repository's files by relative path, mount, include or
  `file:` dependency, and never assume a sibling checkout exists.
- Refer to another repository's files in prose as `<repository>/<path>`, for example
  `pisti-docs/portals.md`.

## Project stage: development (pre-production)

Nothing is deployed and there is no customer data. Until the first production
release, choose the correct design over compatibility:

- Breaking changes to APIs, SDKs, DTOs, routes, flows and the database schema are
  allowed. Do not add compatibility shims, deprecated aliases, dual code paths or
  legacy fallbacks unless asked.
- A breaking API change starts in pisti-backend and regenerates `openapi/v1.json`.
  Then pisti-sdks, pisti-apps, pisti-examples and pisti-docs are updated, each in
  its own repository. Use the same branch name in every affected repository and
  link the changes to each other.
- Remove dead code and obsolete scripts instead of keeping them "for history".
- Fix root causes and redesign weak flows when needed; record anything deferred in
  `pisti-docs/roadmap.md`.

When the first production release is cut, replace this section with production
rules: a versioned public API (a new `/v2` instead of breaking `/v1`), semantically
versioned SDKs, and additive or reviewed data-preserving migrations.

## Documentation

- pisti-docs describes the system as it is now; its README.md is the index. When a
  change alters behavior, the API, configuration or the schema, update the relevant
  guide in pisti-docs as well. Do not add changelogs, history, review logs or
  implementation diaries.
- `pisti-docs/roadmap.md` is the single list of known gaps and pre-production work.
- READMEs in this repository cover only its own components and point to pisti-docs
  guides by name for shared topics.

## API contract

- The backend API is described by pisti-backend `openapi/v1.json`. Build against it,
  not against backend source.
- Application JSON routes under `/api` and `/v1` return `{ data, meta: { requestId } }`
  on success and RFC 9457 Problem Details on failure. 204 responses have no body.

## Packages

- `backend` (`@pisti-paypiller/backend`) is the framework-free server core. `express`
  (`@pisti-paypiller/express`) builds on it. `react` (`@pisti-paypiller/react`) is the browser SDK and
  talks only to the Frontend API (`/v1/fapi/{id}`).
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
  tag is pushed, through npm trusted publishing. The `NPM_TOKEN` secret exists only
  for the first release and is deleted afterwards.

## Build

- `npm ci && npm run build` at the repository root builds every package in
  dependency order; `npm run pack` writes installable tarballs. Files use LF line
  endings. Do not add tests, test helpers, or test scripts unless explicitly
  requested.
