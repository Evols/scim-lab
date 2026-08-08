import { and, asc, count, eq, inArray, sql } from "drizzle-orm";
import { db, get_server_lifecycle, prune_events } from "../../db";
import {
  scim_events,
  scim_group_members,
  scim_groups,
  scim_servers,
  scim_users,
  console_users,
  type scim_group_record,
  type scim_server_record,
  type scim_user_record,
} from "../../db/schema.ts";
import { safe_hash_equal } from "../crypto.ts";
import { json_response } from "./response.ts";
import { scim_error } from "./error.ts";

const USER_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:User";
const GROUP_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:Group";
const LIST_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:ListResponse";
const MAX_BODY_BYTES = 65_536;

type JsonObject = Record<string, unknown>;

function date_string(value: Date): string {
  return value.toISOString();
}

function base_url(origin: string, server_id: string): string {
  return `${origin}/scim/${server_id}/v2`;
}

function clean_user_payload(input: JsonObject): JsonObject {
  const allowed = [
    "name",
    "nickName",
    "profileUrl",
    "title",
    "userType",
    "preferredLanguage",
    "locale",
    "timezone",
    "emails",
    "phoneNumbers",
    "ims",
    "photos",
    "addresses",
    "entitlements",
    "roles",
    "x509Certificates",
  ];
  return Object.fromEntries(
    allowed
      .filter((key) => input[key] !== undefined)
      .map((key) => [key, input[key]]),
  );
}

async function user_resource(
  row: scim_user_record,
  origin: string,
): Promise<JsonObject> {
  const membership_rows = await db
    .select({ group: scim_groups })
    .from(scim_group_members)
    .innerJoin(scim_groups, eq(scim_group_members.group_id, scim_groups.id))
    .where(eq(scim_group_members.user_id, row.id));
  return {
    schemas: [USER_SCHEMA],
    id: row.id,
    ...(row.external_id ? { externalId: row.external_id } : {}),
    userName: row.user_name,
    ...(row.display_name ? { displayName: row.display_name } : {}),
    active: row.active,
    ...row.data,
    groups: membership_rows.map(({ group }) => ({
      value: group.id,
      display: group.display_name,
      $ref: `${base_url(origin, row.server_id)}/Groups/${group.id}`,
    })),
    meta: {
      resourceType: "User",
      created: date_string(row.created_at),
      lastModified: date_string(row.updated_at),
      version: `W/\"${row.version}\"`,
      location: `${base_url(origin, row.server_id)}/Users/${row.id}`,
    },
  };
}

async function group_resource(
  row: scim_group_record,
  origin: string,
): Promise<JsonObject> {
  const members = await db
    .select({ user: scim_users })
    .from(scim_group_members)
    .innerJoin(scim_users, eq(scim_group_members.user_id, scim_users.id))
    .where(eq(scim_group_members.group_id, row.id));
  return {
    schemas: [GROUP_SCHEMA],
    id: row.id,
    ...(row.external_id ? { externalId: row.external_id } : {}),
    displayName: row.display_name,
    members: members.map(({ user }) => ({
      value: user.id,
      display: user.display_name ?? user.user_name,
      $ref: `${base_url(origin, row.server_id)}/Users/${user.id}`,
    })),
    meta: {
      resourceType: "Group",
      created: date_string(row.created_at),
      lastModified: date_string(row.updated_at),
      version: `W/\"${row.version}\"`,
      location: `${base_url(origin, row.server_id)}/Groups/${row.id}`,
    },
  };
}

function read_attribute(resource: JsonObject, attribute: string): unknown {
  const parts = attribute.split(".");
  const visit = (current: unknown, remaining: string[]): unknown => {
    if (Array.isArray(current))
      return current
        .flatMap((entry) => {
          const value = visit(entry, remaining);
          return Array.isArray(value) ? value : [value];
        })
        .filter((value) => value !== undefined);
    if (!remaining.length) return current;
    if (!current || typeof current !== "object") return undefined;
    const record = current as JsonObject;
    const part = remaining[0]!;
    const key = Object.keys(record).find(
      (candidate) => candidate.toLowerCase() === part.toLowerCase(),
    );
    return key ? visit(record[key], remaining.slice(1)) : undefined;
  };
  return visit(resource, parts);
}

function split_logical(
  filter: string,
  operator: "and" | "or",
): string[] | null {
  let quoted = false;
  let depth = 0;
  for (
    let index = 0;
    index <= filter.length - operator.length - 2;
    index += 1
  ) {
    const character = filter[index];
    if (character === '"' && filter[index - 1] !== "\\") quoted = !quoted;
    if (quoted) continue;
    if (character === "(") depth += 1;
    if (character === ")") depth -= 1;
    const fragment = filter
      .slice(index, index + operator.length + 2)
      .toLowerCase();
    if (depth === 0 && fragment === ` ${operator} `)
      return [
        filter.slice(0, index),
        filter.slice(index + operator.length + 2),
      ];
  }
  return null;
}

function compare_filter(
  actual: unknown,
  operator: string,
  expected?: string,
): boolean {
  if (operator === "pr")
    return actual !== undefined && actual !== null && actual !== "";
  const values = Array.isArray(actual) ? actual : [actual];
  return values.some((value) => {
    const normalized =
      typeof value === "object" && value && "value" in value
        ? String((value as { value: unknown }).value)
        : String(value ?? "");
    const left = normalized.toLocaleLowerCase();
    const right = String(expected ?? "").toLocaleLowerCase();
    if (operator === "eq") return left === right;
    if (operator === "ne") return left !== right;
    if (operator === "co") return left.includes(right);
    if (operator === "sw") return left.startsWith(right);
    if (operator === "ew") return left.endsWith(right);
    return false;
  });
}

export function matches_filter(
  resource: JsonObject,
  raw_filter: string,
): boolean {
  let filter = raw_filter.trim();
  if (filter.startsWith("(") && filter.endsWith(")"))
    filter = filter.slice(1, -1).trim();
  const or_parts = split_logical(filter, "or");
  if (or_parts) return or_parts.some((part) => matches_filter(resource, part));
  const and_parts = split_logical(filter, "and");
  if (and_parts)
    return and_parts.every((part) => matches_filter(resource, part));
  if (/^not\s+/i.test(filter))
    return !matches_filter(resource, filter.replace(/^not\s+/i, ""));
  const comparison = filter.match(
    /^([\w.$:-]+)\s+(eq|ne|co|sw|ew|pr)(?:\s+(?:"((?:\\"|[^"])*)"|(true|false|null|-?\d+(?:\.\d+)?)))?$/i,
  );
  if (!comparison) throw new Error("Unsupported or invalid SCIM filter.");
  const [, attribute, operator, quoted, literal] = comparison;
  return compare_filter(
    read_attribute(resource, attribute!),
    operator!.toLowerCase(),
    quoted ?? literal,
  );
}

export function paginate(resources: JsonObject[], url: URL): JsonObject {
  const parsed_start = Number.parseInt(
    url.searchParams.get("startIndex") ?? "1",
    10,
  );
  const parsed_count = Number.parseInt(
    url.searchParams.get("count") ?? "100",
    10,
  );
  const start_index = Number.isFinite(parsed_start)
    ? Math.max(1, parsed_start)
    : 1;
  const requested_count = Number.isFinite(parsed_count)
    ? Math.max(0, parsed_count)
    : 100;
  const page_count = Math.min(100, requested_count);
  return {
    schemas: [LIST_SCHEMA],
    totalResults: resources.length,
    startIndex: start_index,
    itemsPerPage: Math.min(
      page_count,
      Math.max(0, resources.length - start_index + 1),
    ),
    Resources: resources.slice(start_index - 1, start_index - 1 + page_count),
  };
}

function parse_json_body(body: string): JsonObject {
  if (!body) throw new Error("A JSON request body is required.");
  const parsed = JSON.parse(body) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("The request body must be a JSON object.");
  return parsed as JsonObject;
}

async function replace_group_members(
  server_id: string,
  group_id: string,
  members: unknown,
): Promise<void> {
  if (!Array.isArray(members))
    throw new Error("Group members must be an array.");
  const user_ids = [
    ...new Set(
      members
        .map((member) => String((member as JsonObject)?.value ?? ""))
        .filter(Boolean),
    ),
  ];
  if (user_ids.length) {
    const valid_users = await db
      .select({ id: scim_users.id })
      .from(scim_users)
      .where(
        and(
          eq(scim_users.server_id, server_id),
          inArray(scim_users.id, user_ids),
        ),
      );
    if (valid_users.length !== user_ids.length)
      throw new Error("One or more group members do not exist on this server.");
  }
  await db.transaction(async (transaction) => {
    await transaction
      .delete(scim_group_members)
      .where(eq(scim_group_members.group_id, group_id));
    if (user_ids.length)
      await transaction
        .insert(scim_group_members)
        .values(user_ids.map((user_id) => ({ group_id, user_id })));
  });
}

function merge_patch_value(
  target: JsonObject,
  path: string | undefined,
  value: unknown,
  operation: string,
): JsonObject {
  if (!path && value && typeof value === "object" && !Array.isArray(value))
    return operation === "remove"
      ? target
      : { ...target, ...(value as JsonObject) };
  if (!path)
    throw new Error("PATCH operation requires a path or object value.");
  const parts = path.split(".");
  let current = target;
  for (const part of parts.slice(0, -1)) {
    const key =
      Object.keys(current).find(
        (candidate) => candidate.toLowerCase() === part.toLowerCase(),
      ) ?? part;
    if (
      !current[key] ||
      typeof current[key] !== "object" ||
      Array.isArray(current[key])
    )
      current[key] = {};
    current = current[key] as JsonObject;
  }
  const last_part = parts.at(-1)!;
  const key =
    Object.keys(current).find(
      (candidate) => candidate.toLowerCase() === last_part.toLowerCase(),
    ) ?? last_part;
  if (operation === "remove") delete current[key];
  else current[key] = value;
  return target;
}

async function handle_users(
  method: string,
  resource_id: string | undefined,
  server: scim_server_record,
  origin: string,
  url: URL,
  body: string,
): Promise<Response> {
  if (method === "GET" && resource_id) {
    const rows = await db
      .select()
      .from(scim_users)
      .where(
        and(
          eq(scim_users.server_id, server.id),
          eq(scim_users.id, resource_id),
        ),
      )
      .limit(1);
    return rows[0]
      ? json_response(await user_resource(rows[0], origin))
      : scim_error(404, "User not found.");
  }
  if (method === "GET") {
    const rows = await db
      .select()
      .from(scim_users)
      .where(eq(scim_users.server_id, server.id))
      .orderBy(asc(scim_users.created_at));
    let resources = await Promise.all(
      rows.map((row) => user_resource(row, origin)),
    );
    const filter = url.searchParams.get("filter");
    if (filter) {
      try {
        resources = resources.filter((resource) =>
          matches_filter(resource, filter),
        );
      } catch {
        return scim_error(
          400,
          "The supplied filter is invalid or unsupported.",
          "invalidFilter",
        );
      }
    }
    return json_response(paginate(resources, url));
  }
  if (method === "POST" && !resource_id) {
    let input: JsonObject;
    try {
      input = parse_json_body(body);
    } catch {
      return scim_error(
        400,
        "A valid JSON object is required.",
        "invalidSyntax",
      );
    }
    const user_name = String(input.userName ?? "").trim();
    if (!user_name)
      return scim_error(400, "userName is required.", "invalidValue");
    return db.transaction(async (transaction) => {
      await transaction.execute(
        sql`select pg_advisory_xact_lock(hashtext(${server.id}))`,
      );
      const [{ value }] = await transaction
        .select({ value: count() })
        .from(scim_users)
        .where(eq(scim_users.server_id, server.id));
      if (Number(value) >= 100)
        return scim_error(
          409,
          "This server has reached its 100-user limit.",
          "uniqueness",
        );
      try {
        const [created] = await transaction
          .insert(scim_users)
          .values({
            server_id: server.id,
            external_id: input.externalId ? String(input.externalId) : null,
            user_name,
            display_name: input.displayName ? String(input.displayName) : null,
            active: input.active === undefined ? true : Boolean(input.active),
            data: clean_user_payload(input),
          })
          .returning();
        return json_response(await user_resource(created!, origin), 201, {
          location: `${base_url(origin, server.id)}/Users/${created!.id}`,
        });
      } catch (error) {
        if ((error as { code?: string }).code === "23505")
          return scim_error(409, "userName must be unique.", "uniqueness");
        throw error;
      }
    });
  }
  if (!resource_id)
    return scim_error(405, "This method requires a user resource ID.");
  const rows = await db
    .select()
    .from(scim_users)
    .where(
      and(eq(scim_users.server_id, server.id), eq(scim_users.id, resource_id)),
    )
    .limit(1);
  const existing = rows[0];
  if (!existing) return scim_error(404, "User not found.");
  if (method === "DELETE") {
    await db.delete(scim_users).where(eq(scim_users.id, existing.id));
    return new Response(null, { status: 204 });
  }
  if (method === "PUT") {
    let input: JsonObject;
    try {
      input = parse_json_body(body);
    } catch {
      return scim_error(
        400,
        "A valid JSON object is required.",
        "invalidSyntax",
      );
    }
    const user_name = String(input.userName ?? "").trim();
    if (!user_name)
      return scim_error(400, "userName is required.", "invalidValue");
    try {
      const [updated] = await db
        .update(scim_users)
        .set({
          external_id: input.externalId ? String(input.externalId) : null,
          user_name,
          display_name: input.displayName ? String(input.displayName) : null,
          active: input.active === undefined ? true : Boolean(input.active),
          data: clean_user_payload(input),
          version: existing.version + 1,
          updated_at: new Date(),
        })
        .where(eq(scim_users.id, existing.id))
        .returning();
      return json_response(await user_resource(updated!, origin));
    } catch (error) {
      if ((error as { code?: string }).code === "23505")
        return scim_error(409, "userName must be unique.", "uniqueness");
      throw error;
    }
  }
  if (method === "PATCH") {
    let input: JsonObject;
    try {
      input = parse_json_body(body);
    } catch {
      return scim_error(
        400,
        "A valid JSON object is required.",
        "invalidSyntax",
      );
    }
    if (!Array.isArray(input.Operations))
      return scim_error(
        400,
        "PATCH Operations must be an array.",
        "invalidValue",
      );
    let resource = await user_resource(existing, origin);
    for (const raw_operation of input.Operations) {
      const operation = raw_operation as JsonObject;
      const op = String(operation.op ?? "").toLowerCase();
      if (!["add", "replace", "remove"].includes(op))
        return scim_error(400, "Unsupported PATCH operation.", "invalidValue");
      resource = merge_patch_value(
        resource,
        operation.path ? String(operation.path) : undefined,
        operation.value,
        op,
      );
    }
    const user_name = String(resource.userName ?? "").trim();
    if (!user_name)
      return scim_error(400, "PATCH cannot remove userName.", "mutability");
    const [updated] = await db
      .update(scim_users)
      .set({
        external_id: resource.externalId ? String(resource.externalId) : null,
        user_name,
        display_name: resource.displayName
          ? String(resource.displayName)
          : null,
        active: resource.active === undefined ? true : Boolean(resource.active),
        data: clean_user_payload(resource),
        version: existing.version + 1,
        updated_at: new Date(),
      })
      .where(eq(scim_users.id, existing.id))
      .returning();
    return json_response(await user_resource(updated!, origin));
  }
  return scim_error(405, "Method not allowed.");
}

async function handle_groups(
  method: string,
  resource_id: string | undefined,
  server: scim_server_record,
  origin: string,
  url: URL,
  body: string,
): Promise<Response> {
  if (method === "GET" && resource_id) {
    const rows = await db
      .select()
      .from(scim_groups)
      .where(
        and(
          eq(scim_groups.server_id, server.id),
          eq(scim_groups.id, resource_id),
        ),
      )
      .limit(1);
    return rows[0]
      ? json_response(await group_resource(rows[0], origin))
      : scim_error(404, "Group not found.");
  }
  if (method === "GET") {
    const rows = await db
      .select()
      .from(scim_groups)
      .where(eq(scim_groups.server_id, server.id))
      .orderBy(asc(scim_groups.created_at));
    let resources = await Promise.all(
      rows.map((row) => group_resource(row, origin)),
    );
    const filter = url.searchParams.get("filter");
    if (filter) {
      try {
        resources = resources.filter((resource) =>
          matches_filter(resource, filter),
        );
      } catch {
        return scim_error(
          400,
          "The supplied filter is invalid or unsupported.",
          "invalidFilter",
        );
      }
    }
    return json_response(paginate(resources, url));
  }
  if (method === "POST" && !resource_id) {
    let input: JsonObject;
    try {
      input = parse_json_body(body);
    } catch {
      return scim_error(
        400,
        "A valid JSON object is required.",
        "invalidSyntax",
      );
    }
    const display_name = String(input.displayName ?? "").trim();
    if (!display_name)
      return scim_error(400, "displayName is required.", "invalidValue");
    const [created] = await db
      .insert(scim_groups)
      .values({
        server_id: server.id,
        external_id: input.externalId ? String(input.externalId) : null,
        display_name,
      })
      .returning();
    try {
      await replace_group_members(server.id, created!.id, input.members ?? []);
    } catch (error) {
      await db.delete(scim_groups).where(eq(scim_groups.id, created!.id));
      return scim_error(
        400,
        error instanceof Error ? error.message : "Invalid group members.",
        "invalidValue",
      );
    }
    return json_response(await group_resource(created!, origin), 201, {
      location: `${base_url(origin, server.id)}/Groups/${created!.id}`,
    });
  }
  if (!resource_id)
    return scim_error(405, "This method requires a group resource ID.");
  const rows = await db
    .select()
    .from(scim_groups)
    .where(
      and(
        eq(scim_groups.server_id, server.id),
        eq(scim_groups.id, resource_id),
      ),
    )
    .limit(1);
  const existing = rows[0];
  if (!existing) return scim_error(404, "Group not found.");
  if (method === "DELETE") {
    await db.delete(scim_groups).where(eq(scim_groups.id, existing.id));
    return new Response(null, { status: 204 });
  }
  if (method === "PUT") {
    let input: JsonObject;
    try {
      input = parse_json_body(body);
    } catch {
      return scim_error(
        400,
        "A valid JSON object is required.",
        "invalidSyntax",
      );
    }
    const display_name = String(input.displayName ?? "").trim();
    if (!display_name)
      return scim_error(400, "displayName is required.", "invalidValue");
    try {
      await replace_group_members(server.id, existing.id, input.members ?? []);
    } catch (error) {
      return scim_error(
        400,
        error instanceof Error ? error.message : "Invalid group members.",
        "invalidValue",
      );
    }
    const [updated] = await db
      .update(scim_groups)
      .set({
        external_id: input.externalId ? String(input.externalId) : null,
        display_name,
        version: existing.version + 1,
        updated_at: new Date(),
      })
      .where(eq(scim_groups.id, existing.id))
      .returning();
    return json_response(await group_resource(updated!, origin));
  }
  if (method === "PATCH") {
    let input: JsonObject;
    try {
      input = parse_json_body(body);
    } catch {
      return scim_error(
        400,
        "A valid JSON object is required.",
        "invalidSyntax",
      );
    }
    if (!Array.isArray(input.Operations))
      return scim_error(
        400,
        "PATCH Operations must be an array.",
        "invalidValue",
      );
    let display_name = existing.display_name;
    let external_id = existing.external_id;
    let members = (await group_resource(existing, origin)).members as unknown[];
    for (const raw_operation of input.Operations) {
      const operation = raw_operation as JsonObject;
      const op = String(operation.op ?? "").toLowerCase();
      const path = operation.path ? String(operation.path) : "";
      if (!["add", "replace", "remove"].includes(op))
        return scim_error(400, "Unsupported PATCH operation.", "invalidValue");
      if (!path && operation.value && typeof operation.value === "object") {
        const value = operation.value as JsonObject;
        if (value.displayName !== undefined)
          display_name = String(value.displayName);
        if (value.externalId !== undefined)
          external_id = value.externalId ? String(value.externalId) : null;
        if (value.members !== undefined) members = value.members as unknown[];
      } else if (/^displayname$/i.test(path))
        display_name = op === "remove" ? "" : String(operation.value ?? "");
      else if (/^externalid$/i.test(path))
        external_id = op === "remove" ? null : String(operation.value ?? "");
      else if (/^members$/i.test(path)) {
        const values = Array.isArray(operation.value)
          ? operation.value
          : [operation.value];
        if (op === "replace") members = values;
        if (op === "add") members = [...members, ...values];
        if (op === "remove") members = [];
      } else {
        const member_filter = path.match(
          /^members\[value\s+eq\s+"([^"]+)"\]$/i,
        );
        if (member_filter && op === "remove")
          members = members.filter(
            (member) =>
              String((member as JsonObject).value) !== member_filter[1],
          );
        else
          return scim_error(
            400,
            "Unsupported Group PATCH path.",
            "invalidPath",
          );
      }
    }
    if (!display_name.trim())
      return scim_error(400, "PATCH cannot remove displayName.", "mutability");
    try {
      await replace_group_members(server.id, existing.id, members);
    } catch (error) {
      return scim_error(
        400,
        error instanceof Error ? error.message : "Invalid group members.",
        "invalidValue",
      );
    }
    const [updated] = await db
      .update(scim_groups)
      .set({
        display_name,
        external_id,
        version: existing.version + 1,
        updated_at: new Date(),
      })
      .where(eq(scim_groups.id, existing.id))
      .returning();
    return json_response(await group_resource(updated!, origin));
  }
  return scim_error(405, "Method not allowed.");
}

function service_provider_config(server: scim_server_record): JsonObject {
  return {
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig"],
    documentationUri: "https://www.rfc-editor.org/rfc/rfc7644",
    patch: { supported: true },
    bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
    filter: { supported: true, maxResults: 100 },
    changePassword: { supported: false },
    sort: { supported: false },
    etag: { supported: false },
    authenticationSchemes: [
      server.auth_mode === "bearer"
        ? {
            type: "oauthbearertoken",
            name: "Bearer token",
            description: "Server-generated bearer token",
            specUri: "https://www.rfc-editor.org/rfc/rfc6750",
            primary: true,
          }
        : {
            type: "httpbasic",
            name: "HTTP Basic",
            description: "Server-generated username and password",
            specUri: "https://www.rfc-editor.org/rfc/rfc7617",
            primary: true,
          },
    ],
  };
}

const schema_documents: JsonObject[] = [
  {
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:Schema"],
    id: USER_SCHEMA,
    name: "User",
    description: "SCIM core User",
    attributes: [
      {
        name: "userName",
        type: "string",
        multiValued: false,
        required: true,
        caseExact: false,
        mutability: "readWrite",
        returned: "default",
        uniqueness: "server",
      },
      {
        name: "name",
        type: "complex",
        multiValued: false,
        required: false,
        mutability: "readWrite",
        returned: "default",
        subAttributes: [
          "formatted",
          "familyName",
          "givenName",
          "middleName",
          "honorificPrefix",
          "honorificSuffix",
        ].map((name) => ({
          name,
          type: "string",
          multiValued: false,
          required: false,
          caseExact: false,
          mutability: "readWrite",
          returned: "default",
          uniqueness: "none",
        })),
      },
      {
        name: "displayName",
        type: "string",
        multiValued: false,
        required: false,
        caseExact: false,
        mutability: "readWrite",
        returned: "default",
        uniqueness: "none",
      },
      ...[
        "nickName",
        "profileUrl",
        "title",
        "userType",
        "preferredLanguage",
        "locale",
        "timezone",
      ].map((name) => ({
        name,
        type: "string",
        multiValued: false,
        required: false,
        caseExact: false,
        mutability: "readWrite",
        returned: "default",
        uniqueness: "none",
      })),
      {
        name: "active",
        type: "boolean",
        multiValued: false,
        required: false,
        mutability: "readWrite",
        returned: "default",
      },
      {
        name: "password",
        type: "string",
        multiValued: false,
        required: false,
        caseExact: false,
        mutability: "writeOnly",
        returned: "never",
        uniqueness: "none",
      },
      ...["emails", "phoneNumbers", "ims", "photos", "addresses"].map(
        (name) => ({
          name,
          type: "complex",
          multiValued: true,
          required: false,
          mutability: "readWrite",
          returned: "default",
        }),
      ),
      ...["entitlements", "roles", "x509Certificates"].map((name) => ({
        name,
        type: "complex",
        multiValued: true,
        required: false,
        mutability: "readWrite",
        returned: "default",
      })),
      {
        name: "groups",
        type: "complex",
        multiValued: true,
        required: false,
        mutability: "readOnly",
        returned: "default",
      },
    ],
  },
  {
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:Schema"],
    id: GROUP_SCHEMA,
    name: "Group",
    description: "SCIM core Group",
    attributes: [
      {
        name: "displayName",
        type: "string",
        multiValued: false,
        required: true,
        caseExact: false,
        mutability: "readWrite",
        returned: "default",
        uniqueness: "none",
      },
      {
        name: "members",
        type: "complex",
        multiValued: true,
        required: false,
        mutability: "readWrite",
        returned: "default",
      },
    ],
  },
];

const resource_types: JsonObject[] = [
  {
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:ResourceType"],
    id: "User",
    name: "User",
    endpoint: "/Users",
    schema: USER_SCHEMA,
  },
  {
    schemas: ["urn:ietf:params:scim:schemas:core:2.0:ResourceType"],
    id: "Group",
    name: "Group",
    endpoint: "/Groups",
    schema: GROUP_SCHEMA,
  },
];

function authenticate(
  server: scim_server_record,
  authorization: string | null,
): { success: boolean; mode: string | null } {
  if (server.auth_mode === "bearer") {
    const match = authorization?.match(/^Bearer\s+(.+)$/i);
    return {
      success: Boolean(
        match && safe_hash_equal(server.bearer_token_hash, match[1]!),
      ),
      mode: match ? "bearer" : null,
    };
  }
  const match = authorization?.match(/^Basic\s+(.+)$/i);
  if (!match) return { success: false, mode: null };
  try {
    const decoded = Buffer.from(match[1]!, "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    const username = separator >= 0 ? decoded.slice(0, separator) : "";
    const password = separator >= 0 ? decoded.slice(separator + 1) : "";
    return {
      success:
        username === server.basic_username &&
        safe_hash_equal(server.basic_password_hash, password),
      mode: "basic",
    };
  } catch {
    return { success: false, mode: "basic" };
  }
}

function sanitized_headers(headers: Headers): Record<string, string> {
  const sensitive = new Set([
    "authorization",
    "cookie",
    "proxy-authorization",
    "x-api-key",
  ]);
  return Object.fromEntries(
    [...headers.entries()].map(([name, value]) => [
      name,
      sensitive.has(name.toLowerCase()) ? "[REDACTED]" : value,
    ]),
  );
}

function truncate(value: string): { value: string; truncated: boolean } {
  const bytes = Buffer.byteLength(value);
  if (bytes <= MAX_BODY_BYTES) return { value, truncated: false };
  return {
    value: Buffer.from(value).subarray(0, MAX_BODY_BYTES).toString("utf8"),
    truncated: true,
  };
}

function redact_body(value: string): string {
  if (!value) return value;
  try {
    const visit = (input: unknown): unknown => {
      if (Array.isArray(input)) return input.map(visit);
      if (!input || typeof input !== "object") return input;
      return Object.fromEntries(
        Object.entries(input as JsonObject).map(([key, entry]) => [
          key,
          /(password|token|secret|authorization)/i.test(key)
            ? "[REDACTED]"
            : visit(entry),
        ]),
      );
    };
    return JSON.stringify(visit(JSON.parse(value)));
  } catch {
    return value;
  }
}

async function record_event(
  server_id: string,
  request: Request,
  response: Response,
  request_body: string,
  started_at: number,
  auth_mode: string | null,
  auth_success: boolean,
): Promise<void> {
  const request_value = truncate(redact_body(request_body));
  const response_value = truncate(
    response.status === 204 ? "" : await response.clone().text(),
  );
  await db.insert(scim_events).values({
    server_id,
    method: request.method,
    path: `${new URL(request.url).pathname}${new URL(request.url).search}`,
    status: response.status,
    duration_ms: Math.max(0, Date.now() - started_at),
    auth_mode,
    auth_success,
    request_headers: sanitized_headers(request.headers),
    request_body: request_value.value || null,
    response_body: response_value.value || null,
    request_truncated: request_value.truncated,
    response_truncated: response_value.truncated,
  });
  await prune_events(server_id);
}

export async function handle_scim_request(
  request: Request,
  server_id: string,
  path: string | undefined,
): Promise<Response> {
  const started_at = Date.now();
  const body = ["POST", "PUT", "PATCH"].includes(request.method)
    ? await request.text()
    : "";
  const rows = await db
    .select({ server: scim_servers, creator: console_users })
    .from(scim_servers)
    .innerJoin(
      console_users,
      eq(scim_servers.created_by_user_id, console_users.id),
    )
    .where(eq(scim_servers.id, server_id))
    .limit(1);
  if (!rows[0]) return scim_error(404, "SCIM server not found.");
  const { server, creator } = rows[0];
  const auth = authenticate(server, request.headers.get("authorization"));
  let response: Response;
  if (!auth.success) {
    response = scim_error(401, "Invalid or missing SCIM credentials.");
    response.headers.set(
      "www-authenticate",
      server.auth_mode === "bearer"
        ? 'Bearer realm="SCIM Lab"'
        : 'Basic realm="SCIM Lab", charset="UTF-8"',
    );
  } else if (get_server_lifecycle(server, creator.is_anonymous) === "expired") {
    await db.delete(scim_servers).where(eq(scim_servers.id, server.id));
    return scim_error(404, "SCIM server not found.");
  } else if (get_server_lifecycle(server, creator.is_anonymous) !== "active")
    response = scim_error(
      503,
      "This SCIM server is deactivated. Open its console to reactivate it.",
    );
  else if (
    ["POST", "PUT", "PATCH"].includes(request.method) &&
    !/^(application\/scim\+json|application\/json)(?:;|$)/i.test(
      request.headers.get("content-type") ?? "",
    )
  ) {
    response = scim_error(
      415,
      "SCIM writes require application/scim+json.",
      "invalidSyntax",
    );
  } else {
    const segments = (path ?? "").split("/").filter(Boolean);
    const [resource, resource_id] = segments;
    const url = new URL(request.url);
    try {
      if (resource === "Users")
        response = await handle_users(
          request.method,
          resource_id,
          server,
          url.origin,
          url,
          body,
        );
      else if (resource === "Groups")
        response = await handle_groups(
          request.method,
          resource_id,
          server,
          url.origin,
          url,
          body,
        );
      else if (request.method !== "GET")
        response = scim_error(405, "Method not allowed.");
      else if (resource === "ServiceProviderConfig")
        response = json_response(service_provider_config(server));
      else if (resource === "Schemas") {
        const match = resource_id
          ? schema_documents.find(
              (schema) => schema.id === decodeURIComponent(resource_id),
            )
          : null;
        response = resource_id
          ? match
            ? json_response(match)
            : scim_error(404, "Schema not found.")
          : json_response(paginate(schema_documents, url));
      } else if (resource === "ResourceTypes") {
        const match = resource_id
          ? resource_types.find(
              (resource_type) => resource_type.id === resource_id,
            )
          : null;
        response = resource_id
          ? match
            ? json_response(match)
            : scim_error(404, "Resource type not found.")
          : json_response(paginate(resource_types, url));
      } else response = scim_error(404, "SCIM resource not found.");
    } catch (error) {
      console.error("SCIM request failed", error);
      response = scim_error(
        500,
        "The SCIM server could not complete this request.",
      );
    }
  }
  await record_event(
    server.id,
    request,
    response,
    body,
    started_at,
    auth.mode,
    auth.success,
  );
  return response;
}
