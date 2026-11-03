-- Run after setup.sql against a migrated test database. All fixtures roll back.
\set ON_ERROR_STOP on
BEGIN;

INSERT INTO public.console_users (id, is_anonymous, upgraded_at)
VALUES ('ff89df53-7e88-463c-a762-4921bbd71101', false, '2026-01-15T12:00:00Z'),
       ('ff89df53-7e88-463c-a762-4921bbd71102', true, NULL);

CREATE TEMP TABLE expected_counts AS
SELECT count(*) FILTER (WHERE NOT is_anonymous) AS registered,
       count(*) FILTER (WHERE is_anonymous) AS anonymous
FROM public.console_users;
GRANT SELECT ON expected_counts TO grafana_metrics;

SET LOCAL ROLE grafana_metrics;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT FROM metrics.overview, expected_counts
    WHERE registered_accounts = registered AND anonymous_accounts = anonymous
  ) THEN
    RAISE EXCEPTION 'Account aggregates do not match';
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
     OR has_table_privilege(current_user, 'metrics.registrations_daily', 'INSERT,UPDATE,DELETE') THEN
    RAISE EXCEPTION 'Grafana has write privileges on metrics views';
  END IF;
END;
$$;

RESET ROLE;
ROLLBACK;
