# SCIM Lab

[![SCIM 2.0](https://img.shields.io/badge/SCIM-2.0-2563eb)](https://www.rfc-editor.org/rfc/rfc7644)
[![Node.js 22](https://img.shields.io/badge/Node.js-22-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

> Try it at [scimlab.dev](https://scimlab.dev).

SCIM Lab is a [SCIM 2.0](https://www.rfc-editor.org/rfc/rfc7644) sandbox for developing and debugging identity-provisioning integrations. Open the console, copy the generated endpoint and credentials, then point a SCIM client at a real PostgreSQL-backed server while inspecting sanitized requests and responses in the browser.

The first visit works anonymously and creates a disposable SCIM server automatically. OpenID Connect can be added for persistent accounts, multiple servers, credential rotation, and sharing.

Anonymous setup uses an automatic browser POST with a cookie challenge; a plain page fetch allocates no database rows. The endpoint and credential initially live in an encrypted, HTTP-only cookie. The workspace is persisted on its first authenticated SCIM request (including discovery), a console mutation, sign-in, or a console visit after the first 15 minutes. The latter preserves sliding inactivity windows without changing a previously copied credential. New anonymous visitors do not create `console_sessions` rows. Existing database sessions and credentials remain supported.

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
WORKSPACE_CREATIONS_PER_MINUTE=2

# Optional: all three values enable OpenID Connect.
OIDC_ISSUER_URL=https://identity.example.com/oidc
OIDC_CLIENT_ID=scim-lab
OIDC_CLIENT_SECRET=replace-with-your-client-secret
OIDC_SCOPES=openid profile email
```

Register `${APP_ORIGIN}/auth/callback` as an allowed OIDC redirect URI. `OIDC_SCOPES` must include `openid`.

`WORKSPACE_CREATIONS_PER_MINUTE` defaults to **2 per client IP in a rolling 60-second window**, shared across all application processes using this database. It applies to first-time anonymous workspace persistence; requests to existing servers do not consume slots. Separate IPs have independent quotas. The activation request's `Astro.clientAddress` supplies the IP, and only a keyed hash of its normalized value is stored. IPv4-mapped IPv6 addresses share the corresponding IPv4 quota. When exceeded, activation returns HTTP 429 with `Retry-After: 60`.

In production, keep the application behind the trusted reverse proxy and configure that proxy to replace untrusted forwarded headers. Astro uses the forwarded client address for the configured `security.allowedDomains`; direct deployments use the socket address. Keep `APP_SECRET` stable: it protects credentials, provisional browser state, and IP hashes. Browsers without JavaScript can use the initial page's create button; cookies are required.

## Database retention and backlog cleanup

Apply migrations before deploying the new application and worker (`pnpm db:migrate`). Migration `0004` adds a small activation/revocation table; the subsequent per-IP quota migration adds an IP-hash column and a composite index to that table. Neither rebuilds indexes on existing large tables. These markers prevent an old provisional credential from recreating a deleted server, and prevent a logged-out or upgraded anonymous cookie from restoring console access.

The Compose stack starts a `maintenance` service automatically, with a one-hour pause between bounded cleanup cycles and automatic restart unless stopped. Cleanup runs independently of page traffic. Anonymous servers normally expire after **14 days of console inactivity**: 7 active days plus a 7-day recovery window. Registered-owner servers expire after 30 + 90 days. Explicit deactivation timestamps are respected. Deleting an expired server also removes its provisioned users, groups, memberships, and request events. Anonymous console users are removed only after 37 days without console activity, with no owned servers, memberships, valid sessions, or other live temporary records. Registered users are retained. Session/server activity timestamps are updated at most every 15 minutes, introducing up to 15 minutes of inactivity-window rounding.

Database-backed console sessions expire after 14 days of inactivity and are removed by maintenance. The inactivity limit also applies to existing sessions issued with longer expiry dates. New sign-in cookies last 14 days; anonymous cookie-based workspaces retain their 37-day lifetime. Session cleanup does not delete accounts or SCIM servers.

Deploy the updated application and maintenance worker together so both enforce the same server lifetime. For an existing Compose deployment, rebuild and restart both services:

```sh
docker compose up -d --build application maintenance
docker compose logs --tail=50 maintenance
```

The worker runs immediately on startup, then pauses between cycles. Large backlogs may require multiple cycles before every eligible row has been visited.

For other deployments, schedule the command or run its worker mode. Set `DATABASE_URL` explicitly in the command environment; the standalone script does not load `.env` automatically.

```sh
# Read-only preview; shows eligibility within one bounded batch, not total rows.
pnpm db:maintenance

# Apply a bounded cleanup pass.
pnpm db:maintenance --apply

# Continuously clean in small batches, pausing one hour between cycles.
pnpm db:maintenance --apply --watch

# Larger one-off backlog pass; tune to database load and available WAL space.
pnpm db:maintenance --apply --batch-size=1000 --max-batches=100000
```

The defaults are 100 rows per batch and at most 10 batches per table per cycle. `--interval-seconds=3600` controls the worker pause. Parent tables are scanned using their existing UUID primary keys; cursors carry across worker cycles, including batches with no eligible rows. A worker restart starts a new scan. `counts` reports deleted parent rows (or eligible sampled rows in preview), while `scanned` reports examined server/user rows. Foreign-key cascades can remove additional child rows. Each batch commits separately, with a 30-second statement timeout and a 2-second lock timeout. Worker errors are logged and retried on the next cycle.

Deletion makes storage reusable; it does not guarantee smaller database files. After stopping excess allocations and removing the backlog, plan physical compaction separately. `VACUUM FULL` rebuilds a table and its indexes, requires an exclusive lock and additional disk space, and should be scheduled in a maintenance window. No compaction runs automatically.

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
- Grafana with a versioned metrics dashboard and a restricted database role;
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

### Private metrics dashboard

Grafana runs in the same Compose stack at `https://metrics.scimlab.dev` by default. Its image includes the configuration, PostgreSQL data source, and dashboard from `infra/grafana/`; no manual dashboard imports or repository bind mounts are needed. Set up the Logto client and Coolify domain before using it:

1. In the existing Logto admin console, create a separate **Traditional web** application named **SCIM Lab Grafana**. Keep the existing SCIM Lab application's client unchanged.
2. Add the exact redirect URI `https://metrics.scimlab.dev/login/generic_oauth` (or `${GRAFANA_ORIGIN}/login/generic_oauth` for a different origin). Ensure your Logto account has the verified primary email `hutteau.b@gmail.com`.
3. Set `GRAFANA_OIDC_CLIENT_ID` and `GRAFANA_OIDC_CLIENT_SECRET` in Coolify to the new Logto application's credentials. Set `SERVICE_PASSWORD_64_GRAFANA_DB` to a nonempty random secret if it has not been generated; make it available at runtime. This single stack variable supplies both Grafana and `metrics-setup` through their `GRAFANA_DATABASE_PASSWORD` environment variable. Set `GRAFANA_ORIGIN` if using another HTTPS origin. Grafana uses the existing `OIDC_ISSUER_URL`, defaulting to `https://auth.scimlab.dev/oidc`; omit a trailing slash.
4. Point the metrics domain's DNS at the deployment server and assign that HTTPS domain to the **grafana** service's internal port **3000** in Coolify. Do not publish a host port. Redeploy the stack, then open the metrics domain.

Logto handles sign-in, including its existing SSO session. Grafana accepts only the exact email `hutteau.b@gmail.com` with the boolean claim `email_verified=true`, granting it Grafana administrator access. Missing claims and every other email are denied using strict role mapping. The `email` scope supplies these claims; a `gmail.com` domain restriction alone would not restrict access to one person. Password login, anonymous access, public user registration, and default admin creation are disabled. OAuth user creation is enabled so the allowed owner can sign in for the first time. Missing client credentials leave Logto login unusable; there is no password fallback. Existing Grafana sessions last at most one day and expire after one idle hour.

The dashboard shows registered console accounts, persisted anonymous accounts, SCIM servers, provisioned users and groups, daily account signups, and **anonymous accounts by last login**, grouped into UTC days. For anonymous accounts, last login means latest known console activity: the newest account creation/update timestamp or refreshed legacy session's `last_seen_at`. Each account is counted once on its latest day; zero-filled bars follow the dashboard time range. Activity timestamps have up to 15 minutes of rounding, and deleting old sessions can remove older activity evidence. Provisional anonymous workspaces exist only in browser cookies and are excluded until persisted. Signup dates use `upgraded_at`, falling back to `created_at`. Queries reflect current retained data: deleting accounts removes their counts, and totals are live rather than historical snapshots. The dashboard refreshes every five minutes.

The one-shot `metrics-setup` service runs **after migrations** on each deployment. It creates or updates aggregate-only views in the `metrics` schema and the `grafana_metrics` login, including on an existing database volume. Grafana receives its own password through `SERVICE_PASSWORD_64_GRAFANA_DB` and can select only those views, with no grants on underlying account, credential, session, or request tables. Queries have a 15-second timeout. PostgreSQL stays on the internal Docker network; its connection to Grafana uses that network without TLS.

If panels show **No data**, inspect a panel's Query response. PostgreSQL error `28P01` for `grafana_metrics` means database authentication failed. A `metrics-setup` log saying `empty string is not a valid password, clearing password` means the service received an empty secret. Set `SERVICE_PASSWORD_64_GRAFANA_DB` in the stack's Coolify environment variables, save, and **redeploy** so `metrics-setup` reapplies the role password and Grafana reloads its data source credentials. A Grafana-only restart does not repair the database role. Compose now requires a nonempty secret, and the SQL script independently rejects a missing or empty password before altering the role. No database volume reset is needed.

Coolify generates `SERVICE_HEX_64_GRAFANA_SECRET` for Grafana's encryption key. Keep it stable and back up the `grafana_data` volume and deployment secrets alongside the database volumes. Keep secrets in Coolify, never in Git. To add metrics, update `infra/metrics/setup.sql` and the dashboard JSON, then redeploy; edit the repository as the source of truth for provisioned dashboards.

Validation includes `tests/grafana.test.ts` for the access policy and provisioning. CI also runs `infra/metrics/setup.sql` twice against its migrated test database and `infra/metrics/verify.sql` to check aggregate results and denial of private reads and writes. After deploying, verify that your Logto account can open the dashboard and another account cannot.

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
