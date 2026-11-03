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

-- Dashboard reads never scan application tables. The background refresh job
-- atomically replaces these small aggregates, retaining the previous snapshot
-- on error. Ordinary views keep the existing dashboard query contract stable.
CREATE TABLE IF NOT EXISTS metrics.overview_cache (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  registered_accounts bigint NOT NULL,
  anonymous_accounts bigint NOT NULL,
  servers bigint NOT NULL,
  provisioned_users bigint NOT NULL,
  provisioned_groups bigint NOT NULL
);
CREATE TABLE IF NOT EXISTS metrics.registrations_daily_cache (
  time timestamptz PRIMARY KEY,
  registrations bigint NOT NULL
);
CREATE TABLE IF NOT EXISTS metrics.anonymous_last_login_daily_cache (
  time timestamptz PRIMARY KEY,
  anonymous_accounts bigint NOT NULL
);
CREATE TABLE IF NOT EXISTS metrics.refresh_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  refreshed_at timestamptz
);
INSERT INTO metrics.refresh_state (singleton) VALUES (true) ON CONFLICT DO NOTHING;

CREATE OR REPLACE VIEW metrics.overview AS
SELECT registered_accounts, anonymous_accounts, servers, provisioned_users, provisioned_groups
FROM metrics.overview_cache;
CREATE OR REPLACE VIEW metrics.registrations_daily AS
SELECT time, registrations FROM metrics.registrations_daily_cache;
CREATE OR REPLACE VIEW metrics.anonymous_last_login_daily AS
SELECT time, anonymous_accounts FROM metrics.anonymous_last_login_daily_cache;
CREATE OR REPLACE VIEW metrics.refresh_status AS
SELECT refreshed_at FROM metrics.refresh_state;

REVOKE ALL ON ALL TABLES IN SCHEMA metrics FROM PUBLIC;
GRANT USAGE ON SCHEMA metrics TO grafana_metrics;
GRANT SELECT ON metrics.overview, metrics.registrations_daily, metrics.anonymous_last_login_daily, metrics.refresh_status TO grafana_metrics;

COMMIT;
