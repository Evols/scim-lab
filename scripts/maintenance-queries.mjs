// Fixed identifiers/predicates. Parameters are a batch size and a primary-key cursor.
export const maintenance_queries = [
  {
    name: "console_sessions",
    key: "token_hash",
    predicate: "expires_at < now() OR last_seen_at < now() - interval '14 days'",
  },
  { name: "console_flashes", key: "token_hash", predicate: "expires_at < now()" },
  { name: "oidc_transactions", key: "state_hash", predicate: "expires_at < now()" },
  {
    name: "share_invites",
    key: "token_hash",
    predicate: "expires_at < now() - interval '30 days' OR revoked_at < now() - interval '30 days'",
  },
  { name: "scim_events", key: "id", predicate: "created_at < now() - interval '30 days'" },
  {
    name: "scim_servers",
    key: "id",
    predicate: `EXISTS (
      SELECT 1 FROM console_users u WHERE u.id = scim_servers.created_by_user_id
      AND COALESCE(scim_servers.deactivated_at,
        scim_servers.last_console_access_at + CASE WHEN u.is_anonymous THEN interval '7 days' ELSE interval '30 days' END
      ) + CASE WHEN u.is_anonymous THEN interval '7 days' ELSE interval '90 days' END < now()
    )`,
  },
  {
    name: "console_users",
    key: "id",
    predicate: `is_anonymous AND created_at < now() - interval '14 days' AND updated_at < now() - interval '14 days'
      AND NOT EXISTS (SELECT 1 FROM scim_servers s WHERE s.created_by_user_id = console_users.id)
      AND NOT EXISTS (SELECT 1 FROM server_members m WHERE m.user_id = console_users.id)
      AND NOT EXISTS (SELECT 1 FROM console_sessions s WHERE s.user_id = console_users.id AND s.expires_at >= now())
      AND NOT EXISTS (SELECT 1 FROM oidc_transactions o WHERE o.user_id = console_users.id AND o.expires_at >= now())
      AND NOT EXISTS (SELECT 1 FROM console_flashes f WHERE f.user_id = console_users.id AND f.expires_at >= now())
      AND NOT EXISTS (SELECT 1 FROM share_invites i WHERE i.created_by_user_id = console_users.id AND i.expires_at >= now() AND i.revoked_at IS NULL)`,
  },
  {
    name: "anonymous_bootstraps",
    key: "server_id",
    // Include legacy 37-day markers without requiring a data migration.
    predicate: "expires_at < now() OR COALESCE(revoked_at, created_at) < now() - interval '14 days'",
  },
].map(({ name, key, predicate }) => {
  // Walk every table by its existing primary key. Each batch checks
  // at most $1 rows, even when almost all remaining records must be retained.
  // The worker carries the cursor across cycles; no extra production index or
  // durable queue is needed to get through the historical backlog.
  const scan = true;
  const key_type =
    name === "scim_events"
      ? "bigint"
      : ["scim_servers", "console_users", "anonymous_bootstraps"].includes(name)
        ? "uuid"
        : "text";
  const minimum =
    key_type === "uuid"
      ? "'00000000-0000-0000-0000-000000000000'"
      : key_type === "bigint"
        ? "'-9223372036854775808'"
        : "''";
  const scanned = `scanned AS MATERIALIZED (
    SELECT ${key} FROM public.${name}
    WHERE ${key} >= COALESCE($2::${key_type}, ${minimum}::${key_type})
      AND ($2::${key_type} IS NULL OR ${key} > $2::${key_type})
    ORDER BY ${key} LIMIT $1
  )`;
  const statistics = `(SELECT count(*)::integer FROM scanned) AS scanned,
    (SELECT ${key}::text FROM scanned ORDER BY ${key} DESC LIMIT 1) AS cursor`;
  return {
    name,
    scan,
    preview: `WITH ${scanned} SELECT count(*)::integer AS count, ${statistics}
      FROM public.${name} WHERE ${key} IN (SELECT ${key} FROM scanned) AND (${predicate})`,
    remove: `WITH ${scanned}, candidates AS (
      SELECT ${key} FROM public.${name}
      WHERE ${key} IN (SELECT ${key} FROM scanned) AND (${predicate}) FOR UPDATE SKIP LOCKED
    ), removed AS (
      DELETE FROM public.${name} WHERE ${key} IN (SELECT ${key} FROM candidates) RETURNING 1
    ) SELECT count(*)::integer AS count, ${statistics} FROM removed`,
  };
});
