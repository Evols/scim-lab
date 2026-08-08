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

Copy `.env.example` to `.env` and set a random `APP_SECRET` of at least 32 bytes. The included database URL assumes the local username and password are both `postgres`:

```dotenv
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/scim_lab
APP_ORIGIN=http://localhost:4321
APP_SECRET=replace-with-at-least-32-random-bytes
OIDC_ISSUER_URL=http://localhost:8080/realms/scim-lab
OIDC_CLIENT_ID=scim-lab
OIDC_CLIENT_SECRET=replace-with-your-oidc-client-secret
```

Register `${APP_ORIGIN}/auth/callback` as the OIDC redirect URI, then install, migrate, and start:

```sh
pnpm install
pnpm db:migrate
pnpm astro dev --background
```

Use `pnpm astro dev status`, `pnpm astro dev logs`, and `pnpm astro dev stop` to manage the background server.

## Production

Build and run the standalone Astro Node server behind an HTTPS reverse proxy:

```sh
pnpm build
HOST=0.0.0.0 PORT=4321 pnpm start
```

Run `pnpm db:migrate` before starting a new release. Keep `APP_SECRET`, `OIDC_CLIENT_SECRET`, and `DATABASE_URL` out of source control.

## Supported SCIM surface

- Users and Groups: GET, POST, PUT, PATCH, DELETE
- Filtering, one-based pagination, and Group membership
- ServiceProviderConfig, Schemas, and ResourceTypes discovery
- Bearer token or HTTP Basic authentication, one active mode per server
- 100 users and 1,000 retained events per server; events expire after 30 days

Bulk, sorting, ETags, enterprise extensions, and custom schemas are intentionally deferred.
