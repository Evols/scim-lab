# SCIM Lab

[![SCIM 2.0](https://img.shields.io/badge/SCIM-2.0-2563eb)](https://www.rfc-editor.org/rfc/rfc7644)
[![Node.js 22](https://img.shields.io/badge/Node.js-22-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

> Try it at [scimlab.dev](https://scimlab.dev).

SCIM Lab is a [SCIM 2.0](https://www.rfc-editor.org/rfc/rfc7644) sandbox for developing and debugging identity-provisioning integrations. Open the console, copy the generated endpoint and credentials, then point a SCIM client at a real PostgreSQL-backed server while inspecting sanitized requests and responses in the browser.

The first visit works anonymously and creates a disposable SCIM server automatically. OpenID Connect can be added for persistent accounts, multiple servers, credential rotation, and sharing.

## Why SCIM Lab?

- It's free
- It works
- Exercise Users and Groups against an actual SCIM HTTP endpoint.
- Inspect request methods, paths, authentication results, status codes, timing, and formatted JSON payloads.
- Reproduce client behavior from Okta, Microsoft Entra ID, Google Workspace, or a custom provisioner.
- Test filters, PATCH paths, memberships, discovery, ETags, bulk operations, and failure responses.
- Run locally or deploy the included multi-container stack on Coolify.

## SCIM support

SCIM Lab implements the following RFC 7643 and RFC 7644 surface:

- Users and Groups: `GET`, `POST`, `PUT`, `PATCH`, and `DELETE`.
- Service-provider root queries and `POST /.search`.
- SCIM filter expressions, sorting, one-based pagination, and attribute projection.
- PATCH `add`, `replace`, and `remove`, including value-path filters and primary-value normalization.
- Bulk operations, `bulkId` references, `failOnErrors`, and advertised limits.
- Weak ETags and conditional retrieval, replacement, patching, and deletion.
- Direct and nested Group membership with direct/indirect membership on User resources.
- The enterprise User extension and opaque vendor extension round trips.
- `ServiceProviderConfig`, `Schemas`, and `ResourceTypes` discovery endpoints.
- Bearer-token and HTTP Basic client authentication.
- Write-only User passwords on create, replace, and patch. Passwords are salted and hashed, never returned, and redacted from request logs.
- SCIM error documents using `application/scim+json`.

The sandbox currently limits each server to 100 Users. It retains the newest 1,000 request events for up to 30 days. Provisioned Users cannot sign in to the SCIM Lab console, and the optional `/Me` alias is not implemented.

## Quick start

### Requirements

- Node.js 22.12 or newer
- Corepack and the pnpm version pinned in `package.json`
- PostgreSQL 16 or newer

Create a local database:

```sh
createdb -U postgres scim_lab
```

Install dependencies, apply migrations, and start Astro in background mode:

```sh
corepack enable
pnpm install
pnpm db:migrate
pnpm astro dev --background
```

Open <http://localhost:4321>. Manage the background server with:

```sh
pnpm astro dev status
pnpm astro dev logs
pnpm astro dev stop
```

Development defaults to `postgresql://postgres:postgres@localhost:5432/scim_lab` and an intentionally insecure local application secret. Override the defaults in an ignored `.env` file when needed:

```dotenv
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/scim_lab
APP_ORIGIN=http://localhost:4321
APP_SECRET=replace-with-a-stable-random-secret

# Optional: all three values enable OpenID Connect.
OIDC_ISSUER_URL=https://identity.example.com/oidc
OIDC_CLIENT_ID=scim-lab
OIDC_CLIENT_SECRET=replace-with-your-client-secret
OIDC_SCOPES=openid profile email
```

Register `${APP_ORIGIN}/auth/callback` as an allowed OIDC redirect URI. `OIDC_SCOPES` must include `openid`.

## Try the SCIM endpoint

The console displays a base URL similar to:

```text
http://localhost:4321/scim/<server-id>/v2
```

Copy the generated bearer token, then query discovery or create a User:

```sh
export SCIM_BASE='http://localhost:4321/scim/<server-id>/v2'
export SCIM_TOKEN='<bearer-token>'

curl --fail-with-body \
  --header "Authorization: Bearer ${SCIM_TOKEN}" \
  --header 'Accept: application/scim+json' \
  "${SCIM_BASE}/ServiceProviderConfig"

curl --fail-with-body \
  --request POST \
  --header "Authorization: Bearer ${SCIM_TOKEN}" \
  --header 'Content-Type: application/scim+json' \
  --data '{
    "schemas": ["urn:ietf:params:scim:schemas:core:2.0:User"],
    "userName": "ada@example.com",
    "displayName": "Ada Lovelace",
    "active": true
  }' \
  "${SCIM_BASE}/Users"
```

Do not commit real endpoint credentials. Regenerate them from the server settings if they are exposed.

## Configuration

| Variable             | Required in production | Description                                                                                                     |
| -------------------- | ---------------------- | --------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`       | Yes                    | PostgreSQL connection URL.                                                                                      |
| `APP_ORIGIN`         | Yes                    | Public origin without a trailing slash, for example `https://scim.example.com`.                                 |
| `APP_SECRET`         | Yes                    | Stable, high-entropy secret used to protect sessions and credentials. Generate one with `openssl rand -hex 32`. |
| `OIDC_ISSUER_URL`    | No                     | OIDC issuer URL. OIDC is enabled only when issuer, client ID, and client secret are all set.                    |
| `OIDC_CLIENT_ID`     | No                     | OIDC client identifier.                                                                                         |
| `OIDC_CLIENT_SECRET` | No                     | OIDC confidential-client secret.                                                                                |
| `OIDC_SCOPES`        | No                     | Space-separated scopes. Defaults to `openid` and must include it.                                               |

Keep `APP_SECRET` stable between deployments. Rotating it invalidates protected sessions and generated SCIM credentials.

## Development

Useful commands:

| Command                                          | Purpose                                                          |
| ------------------------------------------------ | ---------------------------------------------------------------- |
| `pnpm test`                                      | Run all Vitest unit and PostgreSQL integration tests.            |
| `pnpm astro check`                               | Run Astro and TypeScript diagnostics.                            |
| `pnpm build`                                     | Create the production Node server build.                         |
| `pnpm db:generate`                               | Generate a Drizzle migration after changing the database schema. |
| `pnpm db:migrate`                                | Apply pending database migrations.                               |
| `pnpm exec prettier --check README.md src tests` | Check formatting for maintained source and test files.           |

Tests in both `tests/**/*.test.ts` and `src/**/*.test.ts` are discovered by Vitest. GitHub Actions starts PostgreSQL, applies every migration, and runs the test suite on pushes and pull requests.

### Project structure

```text
src/
├── db/                    PostgreSQL schema
├── lib/
│   ├── management/        Console servers, credentials, invites, and retention
│   ├── scim/
│   │   ├── api/           HTTP routing, validation, responses, and event capture
│   │   └── server/        SCIM resources, filters, PATCH, queries, and discovery
│   └── session/           Anonymous sessions and OIDC account upgrades
├── pages/                 Astro pages and API routes
└── presentation/          Console components and styles
drizzle/                   Ordered PostgreSQL migrations
tests/scim/                RFC-focused protocol and integration tests
```

## Docker and Coolify

The included `compose.yaml` is designed as a Coolify service stack. It contains:

- the SCIM Lab application;
- a one-shot Drizzle migration service;
- PostgreSQL for SCIM Lab;
- Logto and its one-shot seed/alteration services; and
- a separate PostgreSQL database for Logto.

On every Coolify redeployment, the `migrate` service applies pending migrations before the application starts. Existing named database volumes are preserved. If a migration fails, the application is not started.

For a fork, override the example `scimlab.dev` defaults in Coolify:

| Variable               | Example                          |
| ---------------------- | -------------------------------- |
| `APP_ORIGIN`           | `https://scim.example.com`       |
| `LOGTO_ENDPOINT`       | `https://auth.example.com`       |
| `LOGTO_ADMIN_ENDPOINT` | `https://auth-admin.example.com` |
| `OIDC_ISSUER_URL`      | `https://auth.example.com/oidc`  |
| `OIDC_CLIENT_ID`       | Client ID created in Logto       |
| `OIDC_CLIENT_SECRET`   | Client secret created in Logto   |
| `OIDC_SCOPES`          | `openid profile email`           |

Assign the public application domain to port `4321`, the Logto user endpoint to `3001`, and the Logto admin endpoint to `3002`. Configure `${APP_ORIGIN}/auth/callback` as the Logto redirect URI and `APP_ORIGIN` as the post-sign-out redirect URI.

Coolify recognizes the `SERVICE_PASSWORD_*`, `SERVICE_HEX_*`, and `SERVICE_REALBASE64_*` variables in `compose.yaml` and generates the database passwords, application secret, and Logto vault key. Back up both PostgreSQL volumes and your deployment secrets.

## Security and privacy

- Require HTTPS for every production SCIM and console endpoint.
- Use a unique production `APP_SECRET` and database credentials.
- Request authorization headers and password-like JSON fields are redacted before event storage.
- SCIM User passwords are retained only as salted scrypt hashes and are never included in resource responses.
- Request logs can still contain names, email addresses, identifiers, and other personal data.
- The application is a testing sandbox, not an identity provider or authentication system for provisioned Users.

Please report security issues privately through [GitHub Security Advisories](https://github.com/Evols/scim-lab/security/advisories/new) rather than opening a public issue.

## Contributing

Contributions and RFC-focused interoperability reports are welcome.

1. Fork the repository and create a focused branch.
2. Add or update tests for behavior changes, including error cases and relevant RFC requirements.
3. Run `pnpm test`, `pnpm astro check`, and `pnpm build`.
4. Generate and commit a Drizzle migration when `src/db/schema.ts` changes.
5. Open a pull request explaining the behavior, compatibility impact, and verification performed.

Keep pull requests focused, preserve existing migrations, and never commit `.env` files, credentials, or production identity data.

## License

SCIM Lab is available under the [MIT License](LICENSE).
