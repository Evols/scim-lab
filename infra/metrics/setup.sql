-- Runs on every deployment after application migrations, including existing DBs.
-- psql quotes the password as a SQL literal; do not interpolate it in the shell.
\getenv metrics_password GRAFANA_DATABASE_PASSWORD

BEGIN;

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

REVOKE ALL ON ALL TABLES IN SCHEMA metrics FROM PUBLIC;
GRANT USAGE ON SCHEMA metrics TO grafana_metrics;
GRANT SELECT ON metrics.overview, metrics.registrations_daily TO grafana_metrics;

COMMIT;
