-- Transaction body shared by the background job and fixture verification.
-- Build both account histograms in ONE pass over console_users. Initial legacy
-- anonymous sessions share the account's creation timestamp; only refreshed
-- sessions add activity information. Reduce those sessions before joining.
CREATE TEMP TABLE metrics_account_buckets ON COMMIT DROP AS
WITH refreshed_sessions AS (
  SELECT user_id, max(last_seen_at) AS last_seen_at
  FROM public.console_sessions
  WHERE last_seen_at > created_at
  GROUP BY user_id
)
SELECT u.is_anonymous,
       CASE WHEN NOT u.is_anonymous THEN
         date_trunc('day', coalesce(u.upgraded_at, u.created_at) AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
       END AS signup_day,
       CASE WHEN u.is_anonymous THEN
         date_trunc('day', greatest(u.created_at, u.updated_at, s.last_seen_at) AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
       END AS last_login_day,
       count(*) AS accounts
FROM public.console_users u
LEFT JOIN refreshed_sessions s ON s.user_id = u.id
GROUP BY 1, 2, 3;

-- DELETE rather than TRUNCATE permits dashboard readers to keep seeing the
-- committed snapshot while the replacement is built. All changes commit together.
DELETE FROM metrics.overview_cache;
INSERT INTO metrics.overview_cache (registered_accounts, anonymous_accounts, servers, provisioned_users, provisioned_groups)
SELECT coalesce(sum(accounts) FILTER (WHERE NOT is_anonymous), 0)::bigint,
       coalesce(sum(accounts) FILTER (WHERE is_anonymous), 0)::bigint,
       (SELECT count(*) FROM public.scim_servers),
       (SELECT count(*) FROM public.scim_users),
       (SELECT count(*) FROM public.scim_groups)
FROM pg_temp.metrics_account_buckets;

DELETE FROM metrics.registrations_daily_cache;
INSERT INTO metrics.registrations_daily_cache (time, registrations)
SELECT signup_day, accounts FROM pg_temp.metrics_account_buckets WHERE NOT is_anonymous;

DELETE FROM metrics.anonymous_last_login_daily_cache;
INSERT INTO metrics.anonymous_last_login_daily_cache (time, anonymous_accounts)
SELECT last_login_day, accounts FROM pg_temp.metrics_account_buckets WHERE is_anonymous;

UPDATE metrics.refresh_state SET refreshed_at = clock_timestamp() WHERE singleton;
