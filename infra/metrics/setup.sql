-- Runs on every deployment after application migrations, including existing DBs.
-- psql quotes the password as a SQL literal; do not interpolate it in the shell.
\set ON_ERROR_STOP on
\getenv metrics_password GRAFANA_DATABASE_PASSWORD

BEGIN;

-- An empty password makes ALTER ROLE clear the existing password. Reject it
-- before creating or changing anything, even when invoked outside Compose.
SELECT length(:'metrics_password') > 0 AS metrics_password_present
\gset
\if :metrics_password_present
\else
DO $$ BEGIN
  RAISE EXCEPTION 'GRAFANA_DATABASE_PASSWORD must not be empty; set SERVICE_PASSWORD_64_GRAFANA_DB in Coolify';
END $$;
\endif

SELECT 'CREATE ROLE grafana_metrics'
WHERE NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'grafana_metrics')
\gexec

ALTER ROLE grafana_metrics WITH LOGIN PASSWORD :'metrics_password'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
ALTER ROLE grafana_metrics SET default_transaction_read_only = on;
ALTER ROLE grafana_metrics SET statement_timeout = '15s';
ALTER ROLE grafana_metrics SET search_path = metrics, pg_catalog;
GRANT CONNECT ON DATABASE scim_lab TO grafana_metrics;

CREATE SCHEMA IF NOT EXISTS metrics;
REVOKE ALL ON SCHEMA metrics FROM PUBLIC;

-- Owner-executed views expose aggregate numbers only. Do not grant the Grafana
-- role SELECT on application tables (which contain credentials and personal data).
CREATE OR REPLACE VIEW metrics.overview AS
SELECT
  (SELECT count(*) FROM public.console_users WHERE NOT is_anonymous) AS registered_accounts,
  (SELECT count(*) FROM public.console_users WHERE is_anonymous) AS anonymous_accounts,
  (SELECT count(*) FROM public.scim_servers) AS servers,
  (SELECT count(*) FROM public.scim_users) AS provisioned_users,
  (SELECT count(*) FROM public.scim_groups) AS provisioned_groups;

-- Upgrades count at sign-up time, rather than first anonymous workspace creation.
-- Rows reflect retained registered accounts, not an immutable analytics ledger.
CREATE OR REPLACE VIEW metrics.registrations_daily AS
SELECT date_trunc('day', coalesce(upgraded_at, created_at) AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS time,
       count(*) AS registrations
FROM public.console_users
WHERE NOT is_anonymous
GROUP BY 1;

-- Anonymous "last login" means latest known console activity. New stateless
-- sessions update console_users.updated_at; older database sessions record it
-- in last_seen_at. Initial anonymous sessions share the account's creation
-- timestamp, so only refreshed sessions add information. Filter before grouping
-- to avoid aggregating millions of untouched crawler sessions by user ID.
CREATE OR REPLACE VIEW metrics.anonymous_last_login_daily AS
WITH refreshed_sessions AS (
  SELECT user_id, max(last_seen_at) AS last_seen_at
  FROM public.console_sessions
  WHERE last_seen_at > created_at
  GROUP BY user_id
)
SELECT date_trunc('day', greatest(u.created_at, u.updated_at, s.last_seen_at) AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS time,
       count(*) AS anonymous_accounts
FROM public.console_users u
LEFT JOIN refreshed_sessions s ON s.user_id = u.id
WHERE u.is_anonymous
GROUP BY 1;

REVOKE ALL ON ALL TABLES IN SCHEMA metrics FROM PUBLIC;
GRANT USAGE ON SCHEMA metrics TO grafana_metrics;
GRANT SELECT ON metrics.overview, metrics.registrations_daily, metrics.anonymous_last_login_daily TO grafana_metrics;

COMMIT;
