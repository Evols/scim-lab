# SCIM Lab

SCIM Lab is a self-hosted SCIM v2 sandbox. The first visit creates a working anonymous server, a bearer token, and a Postgres-backed store for Users, Groups, and verbose request logs.

## Requirements

- Node.js 22.12 or newer
- pnpm 10
- PostgreSQL 13 or newer
- An OpenID Connect provider for durable accounts and sharing (anonymous use works without it)

## Local setup

Create the database using your local Postgres instance:

```sh
createdb -U postgres scim_lab
```

Local development defaults to a PostgreSQL database named `scim_lab` with `postgres` as both the username and password. Anonymous use needs no environment file. To override the defaults or enable OIDC login and sharing, optionally create an ignored `.env` file:

```dotenv
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/scim_lab
APP_ORIGIN=http://localhost:4321
APP_SECRET=replace-with-at-least-32-random-bytes
OIDC_ISSUER_URL=http://localhost:8080/realms/scim-lab
OIDC_CLIENT_ID=scim-lab
OIDC_CLIENT_SECRET=replace-with-your-oidc-client-secret
```

If OIDC is configured, register `${APP_ORIGIN}/auth/callback` as its redirect URI. Then install, migrate, and start:

```sh
pnpm install
pnpm db:migrate
pnpm astro dev --background
```

Use `pnpm astro dev status`, `pnpm astro dev logs`, and `pnpm astro dev stop` to manage the background server.

## Production on Coolify

Create a Docker Compose resource in Coolify from this repository. The stack runs the Astro Node server and PostgreSQL, and database migrations complete before the application starts.

Use Caddy as the proxy on the Coolify server. In the resource configuration, assign the `application` service the domain `https://scimlab.dev:4321`. The port suffix tells Coolify which internal container port to proxy; public traffic still uses standard HTTPS port 443. Point the domain's `A` and/or `AAAA` records at the server.

Coolify discovers the variables referenced by `compose.yaml`. It automatically generates `SERVICE_PASSWORD_64_DATABASE` and `SERVICE_HEX_64_APPLICATION`; no production `.env` file is needed. `APP_ORIGIN` defaults to `https://scimlab.dev`. Set the optional OIDC values in Coolify's Environment Variables screen and, when enabled, register `https://scimlab.dev/auth/callback` as the redirect URI.

PostgreSQL state is retained in the `pgdata` named volume. Keep database backups and all secrets out of source control.

## Supported SCIM surface

- Users and Groups: GET, POST, PUT, PATCH, DELETE
- Filtering, one-based pagination, and Group membership
- ServiceProviderConfig, Schemas, and ResourceTypes discovery
- Bearer token or HTTP Basic authentication, one active mode per server
- 100 users and 1,000 retained events per server; events expire after 30 days

Bulk, sorting, ETags, enterprise extensions, and custom schemas are intentionally deferred.
