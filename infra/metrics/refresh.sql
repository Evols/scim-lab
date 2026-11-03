-- Run as the database owner, independently of Grafana's 15-second read timeout.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL statement_timeout = '10min';
SET LOCAL lock_timeout = '2s';
SET LOCAL work_mem = '32MB';

SELECT pg_try_advisory_xact_lock(hashtextextended('scim-lab:metrics-refresh', 0)) AS metrics_refresh_acquired
\gset
\if :metrics_refresh_acquired
\ir refresh-data.sql
SELECT refreshed_at AS metrics_refreshed_at FROM metrics.refresh_state;
\else
\echo 'Metrics refresh skipped: another worker is already refreshing.'
\endif
COMMIT;
