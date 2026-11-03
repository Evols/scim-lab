// Fixed identifiers/predicates. Parameters are a batch size and a UUID cursor.
export const maintenance_queries = [
  { name: "console_sessions", key: "token_hash", predicate: "expires_at < now()" },
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
      ) + CASE WHEN u.is_anonymous THEN interval '30 days' ELSE interval '90 days' END < now()
    )`,
  },
  {
    name: "console_users",
    key: "id",
    predicate: `is_anonymous AND created_at < now() - interval '37 days' AND updated_at < now() - interval '37 days'
      AND NOT EXISTS (SELECT 1 FROM scim_servers s WHERE s.created_by_user_id = console_users.id)
      AND NOT EXISTS (SELECT 1 FROM server_members m WHERE m.user_id = console_users.id)
      AND NOT EXISTS (SELECT 1 FROM console_sessions s WHERE s.user_id = console_users.id AND s.expires_at >= now())
      AND NOT EXISTS (SELECT 1 FROM oidc_transactions o WHERE o.user_id = console_users.id AND o.expires_at >= now())
      AND NOT EXISTS (SELECT 1 FROM console_flashes f WHERE f.user_id = console_users.id AND f.expires_at >= now())
      AND NOT EXISTS (SELECT 1 FROM share_invites i WHERE i.created_by_user_id = console_users.id AND i.expires_at >= now() AND i.revoked_at IS NULL)`,
  },
  { name: "anonymous_bootstraps", key: "server_id", predicate: "expires_at < now()" },
].map(({ name, key, predicate }) => {
  // Walk large parent tables by their existing primary keys. Each batch checks
  // at most $1 rows, even when almost all remaining records must be retained.
  // The worker carries the cursor across cycles; no extra production index or
  // durable queue is needed to get through the historical backlog.
  const scan = name === "scim_servers" || name === "console_users";
  const scanned = `scanned AS MATERIALIZED (
    SELECT ${key} FROM public.${name}
    WHERE ${key} >= COALESCE($2::uuid, '00000000-0000-0000-0000-000000000000'::uuid)
      AND ($2::uuid IS NULL OR ${key} > $2::uuid)
    ORDER BY ${key} LIMIT $1
  )`;
  const statistics = `(SELECT count(*)::integer FROM scanned) AS scanned,
    (SELECT ${key}::text FROM scanned ORDER BY ${key} DESC LIMIT 1) AS cursor`;
  if (scan)
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
  return {
    name,
    scan,
    preview: `SELECT count(*)::integer AS count FROM (SELECT ${key} FROM public.${name} WHERE ${predicate} LIMIT $1) candidates`,
    remove: `WITH candidates AS (
    SELECT ${key} FROM public.${name} WHERE ${predicate} LIMIT $1 FOR UPDATE SKIP LOCKED
  ), removed AS (
    DELETE FROM public.${name} WHERE ${key} IN (SELECT ${key} FROM candidates) RETURNING 1
  ) SELECT count(*)::integer AS count FROM removed`,
  };
});
