-- Run after setup.sql against a migrated test database. All fixtures roll back.
\set ON_ERROR_STOP on
-- Build a baseline snapshot before the rollback-only fixtures.
\ir refresh.sql
BEGIN;
SET LOCAL TIME ZONE 'Pacific/Auckland';

CREATE TEMP TABLE previous_anonymous_activity AS
SELECT * FROM metrics.anonymous_last_login_daily;

INSERT INTO public.console_users (id, is_anonymous, upgraded_at)
VALUES ('ff89df53-7e88-463c-a762-4921bbd71101', false, '2026-01-15T12:00:00Z'),
       ('ff89df53-7e88-463c-a762-4921bbd71102', true, NULL);

-- Stateless activity, multiple legacy sessions, a first visit, and account
-- activity newer than a legacy session. UTC boundaries must survive a non-UTC
-- database session, and each retained account must appear on exactly one day.
INSERT INTO public.console_users (id, is_anonymous, created_at, updated_at)
VALUES ('ff89df53-7e88-463c-a762-4921bbd71103', true, '2026-01-10T00:00:00Z', '2026-01-15T23:30:00Z'),
       ('ff89df53-7e88-463c-a762-4921bbd71104', true, '2026-01-10T00:00:00Z', '2026-01-10T00:00:00Z'),
       ('ff89df53-7e88-463c-a762-4921bbd71105', true, '2026-01-18T23:45:00Z', '2026-01-18T23:45:00Z'),
       ('ff89df53-7e88-463c-a762-4921bbd71106', true, '2026-01-10T00:00:00Z', '2026-01-20T00:15:00Z');

INSERT INTO public.console_sessions (token_hash, user_id, created_at, last_seen_at, expires_at)
VALUES ('metrics-verify-legacy-1', 'ff89df53-7e88-463c-a762-4921bbd71104', '2026-01-10T00:00:00Z', '2026-01-16T23:50:00Z', '2026-01-30T00:00:00Z'),
       ('metrics-verify-legacy-2', 'ff89df53-7e88-463c-a762-4921bbd71104', '2026-01-10T00:00:00Z', '2026-01-17T00:30:00Z', '2026-01-30T00:00:00Z'),
       ('metrics-verify-first-visit', 'ff89df53-7e88-463c-a762-4921bbd71105', '2026-01-18T23:45:00Z', '2026-01-18T23:45:00Z', '2026-01-30T00:00:00Z'),
       ('metrics-verify-newer-account', 'ff89df53-7e88-463c-a762-4921bbd71106', '2026-01-10T00:00:00Z', '2026-01-19T23:50:00Z', '2026-01-30T00:00:00Z'),
       ('metrics-verify-registered', 'ff89df53-7e88-463c-a762-4921bbd71101', '2026-01-10T00:00:00Z', '2026-01-23T23:50:00Z', '2026-01-30T00:00:00Z');

CREATE TEMP TABLE expected_activity_deltas (time timestamptz PRIMARY KEY, accounts bigint);
INSERT INTO expected_activity_deltas VALUES
  ('2026-01-10T00:00:00Z', 0), ('2026-01-15T00:00:00Z', 1),
  ('2026-01-16T00:00:00Z', 0), ('2026-01-17T00:00:00Z', 1),
  ('2026-01-18T00:00:00Z', 1), ('2026-01-19T00:00:00Z', 0),
  ('2026-01-20T00:00:00Z', 1), ('2026-01-23T00:00:00Z', 0);

-- Cached metrics must change only when the owner refreshes them. Run the same
-- transaction body as the worker; the final ROLLBACK restores the baseline.
DO $$ BEGIN
  IF (SELECT coalesce(sum(anonymous_accounts), 0) FROM metrics.anonymous_last_login_daily)
     <> (SELECT coalesce(sum(anonymous_accounts), 0) FROM previous_anonymous_activity) THEN
    RAISE EXCEPTION 'Panel reads must use the cached snapshot, not scan changed application rows';
  END IF;
END $$;
\ir refresh-data.sql

CREATE TEMP TABLE expected_counts AS
SELECT count(*) FILTER (WHERE NOT is_anonymous) AS registered,
       count(*) FILTER (WHERE is_anonymous) AS anonymous
FROM public.console_users;
GRANT SELECT ON expected_counts TO grafana_metrics;
GRANT SELECT ON previous_anonymous_activity, expected_activity_deltas TO grafana_metrics;

SET LOCAL ROLE grafana_metrics;

DO $$
DECLARE
  relation_name text;
  query_plan jsonb;
BEGIN
  -- The view contract must never hide a full application-table scan from an
  -- otherwise innocent SELECT by Grafana. Check all panel-facing query plans.
  FOREACH relation_name IN ARRAY ARRAY['overview', 'registrations_daily', 'anonymous_last_login_daily', 'refresh_status'] LOOP
    EXECUTE format('EXPLAIN (VERBOSE, FORMAT JSON) SELECT * FROM metrics.%I', relation_name) INTO query_plan;
    IF query_plan::text ~ '"Schema"\s*:\s*"public"' THEN
      RAISE EXCEPTION 'Metrics view % still scans application tables', relation_name;
    END IF;
  END LOOP;
  IF NOT EXISTS (
    SELECT FROM metrics.overview, expected_counts
    WHERE registered_accounts = registered AND anonymous_accounts = anonymous
  ) THEN
    RAISE EXCEPTION 'Account aggregates do not match';
  END IF;

  IF (SELECT coalesce(sum(anonymous_accounts), 0) FROM metrics.anonymous_last_login_daily)
     <> (SELECT anonymous FROM expected_counts) THEN
    RAISE EXCEPTION 'Last-login buckets must count each anonymous account exactly once';
  END IF;
  IF EXISTS (
    SELECT FROM expected_activity_deltas e
    LEFT JOIN metrics.anonymous_last_login_daily a ON a.time = e.time
    LEFT JOIN previous_anonymous_activity p ON p.time = e.time
    WHERE coalesce(a.anonymous_accounts, 0) - coalesce(p.anonymous_accounts, 0) <> e.accounts
  ) THEN
    RAISE EXCEPTION 'Last-login dates must use latest activity in UTC and exclude registered accounts';
  END IF;
  IF NOT EXISTS (
    SELECT FROM metrics.registrations_daily
    WHERE time = '2026-01-15T00:00:00Z'::timestamptz AND registrations >= 1
  ) THEN
    RAISE EXCEPTION 'Signup date must use upgrade time';
  END IF;

  BEGIN
    PERFORM email FROM public.console_users;
    RAISE EXCEPTION 'Grafana can read personal data';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM token_hash, last_seen_at FROM public.console_sessions;
    RAISE EXCEPTION 'Grafana can read private session data';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM bearer_token_encrypted FROM public.scim_servers;
    RAISE EXCEPTION 'Grafana can read credentials';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM request_body FROM public.scim_events;
    RAISE EXCEPTION 'Grafana can read request payloads';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    UPDATE public.console_users SET display_name = 'forbidden' WHERE false;
    RAISE EXCEPTION 'Grafana can write application data';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  IF has_table_privilege(current_user, 'metrics.overview', 'INSERT,UPDATE,DELETE')
     OR has_table_privilege(current_user, 'metrics.registrations_daily', 'INSERT,UPDATE,DELETE')
     OR has_table_privilege(current_user, 'metrics.anonymous_last_login_daily', 'INSERT,UPDATE,DELETE') THEN
    RAISE EXCEPTION 'Grafana has write privileges on metrics views';
  END IF;
  BEGIN
    PERFORM * FROM metrics.overview_cache;
    RAISE EXCEPTION 'Grafana can directly read private cache tables';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    UPDATE metrics.refresh_state SET refreshed_at = now();
    RAISE EXCEPTION 'Grafana can change cached metrics freshness';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END;
$$;

RESET ROLE;
ROLLBACK;
