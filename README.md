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

Create a Docker Compose resource in Coolify from this repository. The stack runs the Astro Node server, Logto OSS, and separate PostgreSQL databases for each application. One-shot setup services initialize and migrate both databases before their applications start.

Use Caddy as the proxy on the Coolify server. Assign these domains in the resource configuration:

- `application`: `https://scimlab.dev:4321`
- `logto`: `https://auth.scimlab.dev:3001,https://auth-admin.scimlab.dev:3002`

The port suffixes tell Coolify which internal container port to proxy; public traffic still uses standard HTTPS port 443. Point all three hostnames at the Coolify server.

Coolify discovers the variables referenced by `compose.yaml` and generates the database passwords, application secret, and Logto vault key; no production `.env` file is needed. `APP_ORIGIN`, `LOGTO_ENDPOINT`, `LOGTO_ADMIN_ENDPOINT`, and `OIDC_ISSUER_URL` have production defaults for the domains above.

### Configure Logto

After the first deployment:

1. Open `https://auth-admin.scimlab.dev` and create the initial Logto administrator.
2. Under **Applications**, create a **Traditional web** application named `SCIM Lab`.
3. Add `https://scimlab.dev/auth/callback` as an allowed redirect URI.
4. Add `https://scimlab.dev` as an allowed post sign-out redirect URI.
5. Copy the Logto App ID and App Secret into Coolify as `OIDC_CLIENT_ID` and `OIDC_CLIENT_SECRET`, then redeploy the stack. The issuer defaults to `https://auth.scimlab.dev/oidc`.

The existing **Sign in** button sends users through this OIDC application. Signing out clears both the local SCIM Lab session and the centralized Logto session.

For username/password registration without an email provider, go to **Sign-in & account → Sign-up and sign-in**, choose **Username** as the sign-up identifier, and enable password creation. Enable passkey sign-in and its **Continue with passkey** option in the same sign-in experience; Logto can then prompt users to bind a passkey after registration.

For email/password registration, first add and configure an SMTP or other email connector, then choose **Email address** plus password creation. Logto requires email verification when email is the sign-up identifier. The stack installs only the Google connector by default.

For Google login:

1. Under **Connectors → Social connectors**, add Google.
2. In Google Cloud, create a Web application OAuth client. Use `https://auth.scimlab.dev` as an authorized JavaScript origin and copy the exact callback URI shown by the Logto connector into Google's authorized redirect URIs.
3. Save the Google client ID and secret in Logto.
4. Under **Sign-in & account → Sign-up and sign-in**, add Google to **Social sign-in** and save the experience.

SCIM Lab data, Logto data, and installed Logto connectors are retained in named volumes. Back up both PostgreSQL volumes and keep all secrets out of source control.

## Supported SCIM surface

- Users and Groups: GET, POST, PUT, PATCH, DELETE
- Filtering, one-based pagination, and Group membership
- ServiceProviderConfig, Schemas, and ResourceTypes discovery
- Bearer token or HTTP Basic authentication, one active mode per server
- 100 users and 1,000 retained events per server; events expire after 30 days

Bulk, sorting, ETags, enterprise extensions, and custom schemas are intentionally deferred.
