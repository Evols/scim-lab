import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { desc, eq } from "drizzle-orm";
import { console_users, scim_events, scim_servers, scim_users } from "../../src/db/schema.ts";
import { db } from "../../src/lib/database.ts";
import { hash_secret, safe_scim_password_equal } from "../../src/lib/crypto.ts";
import { handle_scim_request } from "../../src/lib/scim/api/router.ts";
import {
  BULK_REQUEST_SCHEMA_URI,
  BULK_RESPONSE_SCHEMA_URI,
  ENTERPRISE_USER_SCHEMA_URI,
  GROUP_SCHEMA_URI,
  LIST_RESPONSE_SCHEMA_URI,
  PATCH_REQUEST_SCHEMA_URI,
  SEARCH_REQUEST_SCHEMA_URI,
  SERVICE_PROVIDER_CONFIG_SCHEMA_URI,
  USER_SCHEMA_URI,
} from "../../src/lib/scim/server/constants.ts";

describe("SCIM protocol through the HTTP router", { sequential: true }, () => {
  const token = "scim-integration-token";
  let owner_id = "";
  let server_id = "";
  let user_id = "";
  let user_etag = "";

  function request(path: string, init: RequestInit = {}) {
    const method = init.method ?? "GET";
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${token}`);
    if (["POST", "PUT", "PATCH"].includes(method)) headers.set("content-type", "application/scim+json");
    const request = new Request(`https://scim.example.test/scim/${server_id}/v2${path}`, { ...init, method, headers });
    const route_path = path.slice(1).split("?", 1)[0];
    return handle_scim_request(request, server_id, route_path || undefined);
  }

  beforeAll(async () => {
    const [owner] = await db.insert(console_users).values({ is_anonymous: false }).returning();
    owner_id = owner!.id;
    const [server] = await db
      .insert(scim_servers)
      .values({ name: "SCIM RFC integration", created_by_user_id: owner_id, bearer_token_hash: hash_secret(token) })
      .returning();
    server_id = server!.id;
  });

  afterAll(async () => {
    if (server_id) await db.delete(scim_servers).where(eq(scim_servers.id, server_id));
    if (owner_id) await db.delete(console_users).where(eq(console_users.id, owner_id));
  });

  it("returns a SCIM 401 with a Bearer challenge", async () => {
    const raw = new Request(`https://scim.example.test/scim/${server_id}/v2/Users`);
    const response = await handle_scim_request(raw, server_id, "Users");
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe('Bearer realm="SCIM Lab"');
    expect(await response.json()).toMatchObject({
      status: "401",
      schemas: ["urn:ietf:params:scim:api:messages:2.0:Error"],
    });
  });

  it("returns RFC error documents for media type, syntax, uniqueness, and missing-resource errors", async () => {
    const wrong_media_type = new Request(`https://scim.example.test/scim/${server_id}/v2/Users`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "text/plain" },
      body: "{}",
    });
    expect((await handle_scim_request(wrong_media_type, server_id, "Users")).status).toBe(415);

    const malformed = await request("/Users", { method: "POST", body: "{" });
    expect(await malformed.json()).toMatchObject({ status: "400", scimType: "invalidSyntax" });

    const first = await request("/Users", {
      method: "POST",
      body: JSON.stringify({ schemas: [USER_SCHEMA_URI], userName: "unique@example.com" }),
    });
    expect(first.status).toBe(201);
    const duplicate = await request("/Users", {
      method: "POST",
      body: JSON.stringify({ schemas: [USER_SCHEMA_URI], userName: "UNIQUE@example.com" }),
    });
    expect(await duplicate.json()).toMatchObject({ status: "409", scimType: "uniqueness" });
    expect((await request("/Users/00000000-0000-0000-0000-000000000000")).status).toBe(404);
  });

  it("serves capability and schema discovery", async () => {
    const config_response = await request("/ServiceProviderConfig");
    expect(config_response.status).toBe(200);
    expect(config_response.headers.get("content-location")).toBe(
      `https://scim.example.test/scim/${server_id}/v2/ServiceProviderConfig`,
    );
    expect(await config_response.json()).toMatchObject({
      schemas: [SERVICE_PROVIDER_CONFIG_SCHEMA_URI],
      bulk: { supported: true },
      sort: { supported: true },
      etag: { supported: true },
      meta: {
        resourceType: "ServiceProviderConfig",
        location: `https://scim.example.test/scim/${server_id}/v2/ServiceProviderConfig`,
      },
    });

    const schemas = await (await request("/Schemas")).json();
    expect(schemas.schemas).toEqual([LIST_RESPONSE_SCHEMA_URI]);
    expect(schemas.Resources.map((schema: { id: string }) => schema.id)).toEqual(
      expect.arrayContaining([USER_SCHEMA_URI, GROUP_SCHEMA_URI]),
    );
    expect(schemas.Resources[0].meta).toMatchObject({ resourceType: "Schema", location: expect.any(String) });
    expect((await request(`/Schemas/${encodeURIComponent(USER_SCHEMA_URI)}`)).status).toBe(200);
    expect((await request("/Schemas?filter=name%20eq%20%22User%22")).status).toBe(403);
  });

  it("creates a User with SCIM headers and ignores supplied readOnly values", async () => {
    const response = await request("/Users", {
      method: "POST",
      body: JSON.stringify({
        schemas: [USER_SCHEMA_URI, ENTERPRISE_USER_SCHEMA_URI],
        id: "client-id-must-be-ignored",
        userName: "ada@example.com",
        displayName: "Ada Lovelace",
        active: null,
        password: "initial-password",
        meta: { created: "1900-01-01T00:00:00Z" },
        [ENTERPRISE_USER_SCHEMA_URI]: { employeeNumber: "100" },
      }),
    });
    expect(response.status).toBe(201);
    expect(response.headers.get("content-type")).toContain("application/scim+json");
    expect(response.headers.get("location")).toContain("/Users/");
    expect(response.headers.get("content-location")).toBe(response.headers.get("location"));
    user_etag = response.headers.get("etag")!;
    const resource = await response.json();
    user_id = resource.id;
    expect(resource).toMatchObject({
      schemas: [USER_SCHEMA_URI, ENTERPRISE_USER_SCHEMA_URI],
      userName: "ada@example.com",
      active: true,
      meta: { version: user_etag },
      [ENTERPRISE_USER_SCHEMA_URI]: { employeeNumber: "100" },
    });
    expect(resource.id).not.toBe("client-id-must-be-ignored");
    expect(resource.meta.created).not.toBe("1900-01-01T00:00:00Z");
    expect(resource).not.toHaveProperty("password");
    const [stored] = await db.select().from(scim_users).where(eq(scim_users.id, user_id)).limit(1);
    expect(stored?.password_hash).not.toContain("initial-password");
    expect(safe_scim_password_equal(stored?.password_hash ?? null, "initial-password")).toBe(true);
    const [event] = await db
      .select()
      .from(scim_events)
      .where(eq(scim_events.server_id, server_id))
      .orderBy(desc(scim_events.id))
      .limit(1);
    expect(JSON.parse(event!.request_body!).password).toBe("[REDACTED]");
  });

  it("retains, replaces, and removes write-only passwords without returning them", async () => {
    const created = await request("/Users", {
      method: "POST",
      body: JSON.stringify({ schemas: [USER_SCHEMA_URI], userName: "password@example.com", password: "first" }),
    });
    const resource = await created.json();
    expect(created.status).toBe(201);
    expect(resource).not.toHaveProperty("password");
    let [stored] = await db.select().from(scim_users).where(eq(scim_users.id, resource.id)).limit(1);
    const original_hash = stored!.password_hash;

    const replaced = await request(`/Users/${resource.id}`, {
      method: "PUT",
      headers: { "if-match": created.headers.get("etag")! },
      body: JSON.stringify({ schemas: [USER_SCHEMA_URI], userName: "password@example.com", displayName: "XYZ" }),
    });
    expect(replaced.status).toBe(200);
    [stored] = await db.select().from(scim_users).where(eq(scim_users.id, resource.id)).limit(1);
    expect(stored!.password_hash).toBe(original_hash);

    const patched = await request(`/Users/${resource.id}?attributes=password,userName`, {
      method: "PATCH",
      headers: { "if-match": replaced.headers.get("etag")! },
      body: JSON.stringify({
        schemas: [PATCH_REQUEST_SCHEMA_URI],
        Operations: [{ op: "replace", path: "password", value: "second" }],
      }),
    });
    expect(patched.status).toBe(200);
    expect(await patched.clone().json()).not.toHaveProperty("password");
    [stored] = await db.select().from(scim_users).where(eq(scim_users.id, resource.id)).limit(1);
    expect(stored!.password_hash).not.toBe(original_hash);
    expect(safe_scim_password_equal(stored!.password_hash, "second")).toBe(true);

    const removed = await request(`/Users/${resource.id}`, {
      method: "PATCH",
      headers: { "if-match": patched.headers.get("etag")! },
      body: JSON.stringify({
        schemas: [PATCH_REQUEST_SCHEMA_URI],
        Operations: [{ op: "remove", path: "password" }],
      }),
    });
    expect(removed.status).toBe(200);
    [stored] = await db.select().from(scim_users).where(eq(scim_users.id, resource.id)).limit(1);
    expect(stored!.password_hash).toBeNull();
  });

  it("filters, sorts, paginates, and projects list responses", async () => {
    await request("/Users", {
      method: "POST",
      body: JSON.stringify({ schemas: [USER_SCHEMA_URI], userName: "grace@example.com", displayName: "Grace Hopper" }),
    });
    const response = await request(
      "/Users?filter=displayName%20co%20%22a%22&sortBy=userName&sortOrder=descending&attributes=userName&startIndex=1&count=10",
    );
    expect(response.status).toBe(200);
    const list = await response.json();
    expect(list).toMatchObject({
      schemas: [LIST_RESPONSE_SCHEMA_URI],
      totalResults: 2,
      startIndex: 1,
      itemsPerPage: 2,
    });
    expect(list.Resources.map((resource: { userName: string }) => resource.userName)).toEqual([
      "grace@example.com",
      "ada@example.com",
    ]);
    expect(list.Resources[0]).toEqual({
      schemas: [USER_SCHEMA_URI],
      id: expect.any(String),
      userName: "grace@example.com",
    });
  });

  it("supports conditional retrieval and update", async () => {
    expect((await request(`/Users/${user_id}`, { headers: { "if-none-match": user_etag } })).status).toBe(304);
    const stale = await request(`/Users/${user_id}`, {
      method: "PATCH",
      headers: { "if-match": 'W/"stale"' },
      body: JSON.stringify({
        schemas: [PATCH_REQUEST_SCHEMA_URI],
        Operations: [{ op: "replace", path: "title", value: "Programmer" }],
      }),
    });
    expect(stale.status).toBe(412);

    const updated = await request(`/Users/${user_id}?attributes=userName,title`, {
      method: "PATCH",
      headers: { "if-match": user_etag },
      body: JSON.stringify({
        schemas: [PATCH_REQUEST_SCHEMA_URI],
        Operations: [{ op: "replace", path: "title", value: "Programmer" }],
      }),
    });
    expect(updated.status).toBe(200);
    expect(updated.headers.get("etag")).not.toBe(user_etag);
    expect(await updated.json()).toEqual({
      schemas: [USER_SCHEMA_URI, ENTERPRISE_USER_SCHEMA_URI],
      id: user_id,
      userName: "ada@example.com",
      title: "Programmer",
    });

    const invalid = await request(`/Users/${user_id}`, {
      method: "PATCH",
      body: JSON.stringify({
        schemas: [PATCH_REQUEST_SCHEMA_URI],
        Operations: [{ op: "replace", path: "active", value: "yes" }],
      }),
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ scimType: "invalidValue", status: "400" });
  });

  it("implements replacing and deleting a User with conditional versions", async () => {
    const created = await request("/Users", {
      method: "POST",
      body: JSON.stringify({
        schemas: [USER_SCHEMA_URI],
        userName: "replace-me@example.com",
        title: "This must be removed by PUT",
      }),
    });
    const created_resource = await created.json();
    const replaced = await request(`/Users/${created_resource.id}`, {
      method: "PUT",
      headers: { "if-match": created.headers.get("etag")! },
      body: JSON.stringify({
        schemas: [USER_SCHEMA_URI],
        userName: "replaced@example.com",
        displayName: "Replacement",
      }),
    });
    expect(replaced.status).toBe(200);
    expect(await replaced.clone().json()).not.toHaveProperty("title");
    expect(
      (
        await request(`/Users/${created_resource.id}`, {
          method: "DELETE",
          headers: { "if-match": 'W/"stale"' },
        })
      ).status,
    ).toBe(412);
    expect(
      (
        await request(`/Users/${created_resource.id}`, {
          method: "DELETE",
          headers: { "if-match": replaced.headers.get("etag")! },
        })
      ).status,
    ).toBe(204);
    expect((await request(`/Users/${created_resource.id}`)).status).toBe(404);
  });

  it("supports POST search at resource and service-provider roots", async () => {
    const body = JSON.stringify({
      schemas: [SEARCH_REQUEST_SCHEMA_URI],
      filter: 'userName sw "ada"',
      attributes: ["userName"],
      count: 10,
    });
    const users = await request("/Users/.search", { method: "POST", body });
    expect(users.status).toBe(200);
    expect((await users.json()).totalResults).toBe(1);
    const root = await request("/.search", { method: "POST", body });
    expect(root.status).toBe(200);
    expect((await root.json()).Resources[0]).toMatchObject({ userName: "ada@example.com" });
  });

  it("creates Groups with User and nested Group memberships", async () => {
    const child = await request("/Groups", {
      method: "POST",
      body: JSON.stringify({
        schemas: [GROUP_SCHEMA_URI],
        displayName: "Child",
        members: [{ value: user_id, type: "User" }],
      }),
    });
    const child_resource = await child.json();
    const parent = await request("/Groups", {
      method: "POST",
      body: JSON.stringify({
        schemas: [GROUP_SCHEMA_URI],
        displayName: "Parent",
        members: [{ value: child_resource.id, type: "Group" }],
      }),
    });
    expect(parent.status).toBe(201);
    const parent_resource = await parent.json();
    expect(parent_resource.members[0]).toMatchObject({
      value: child_resource.id,
      type: "Group",
      $ref: expect.stringContaining(`/Groups/${child_resource.id}`),
    });
    const user = await (await request(`/Users/${user_id}`)).json();
    expect(user.groups).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ value: child_resource.id, type: "direct" }),
        expect.objectContaining({ display: "Parent", type: "indirect" }),
      ]),
    );

    const patched = await request(`/Groups/${child_resource.id}`, {
      method: "PATCH",
      headers: { "if-match": child.headers.get("etag")! },
      body: JSON.stringify({
        schemas: [PATCH_REQUEST_SCHEMA_URI],
        Operations: [{ op: "remove", path: `members[value eq "${user_id}"]` }],
      }),
    });
    expect(patched.status).toBe(200);
    expect(await patched.clone().json()).not.toHaveProperty("members");
    expect((await (await request(`/Users/${user_id}`)).json()).groups).toBeUndefined();

    const replaced_parent = await request(`/Groups/${parent_resource.id}`, {
      method: "PUT",
      headers: { "if-match": parent.headers.get("etag")! },
      body: JSON.stringify({ schemas: [GROUP_SCHEMA_URI], displayName: "Renamed Parent" }),
    });
    expect(replaced_parent.status).toBe(200);
    expect(await replaced_parent.clone().json()).toMatchObject({ displayName: "Renamed Parent" });
    expect(
      (
        await request(`/Groups/${parent_resource.id}`, {
          method: "DELETE",
          headers: { "if-match": replaced_parent.headers.get("etag")! },
        })
      ).status,
    ).toBe(204);
  });

  it("executes Bulk operations and resolves bulkId references", async () => {
    const response = await request("/Bulk", {
      method: "POST",
      body: JSON.stringify({
        schemas: [BULK_REQUEST_SCHEMA_URI],
        Operations: [
          {
            method: "POST",
            path: "/Groups",
            bulkId: "bulk-group",
            data: {
              schemas: [GROUP_SCHEMA_URI],
              displayName: "Bulk Group",
              members: [{ value: "bulkId:bulk-user", type: "User" }],
            },
          },
          {
            method: "POST",
            path: "/Users",
            bulkId: "bulk-user",
            data: { schemas: [USER_SCHEMA_URI], userName: "bulk@example.com" },
          },
        ],
      }),
    });
    expect(response.status).toBe(200);
    const bulk = await response.json();
    expect(bulk.schemas).toEqual([BULK_RESPONSE_SCHEMA_URI]);
    expect(bulk.Operations).toEqual([
      expect.objectContaining({ method: "POST", bulkId: "bulk-group", status: "201", version: expect.any(String) }),
      expect.objectContaining({ method: "POST", bulkId: "bulk-user", status: "201", version: expect.any(String) }),
    ]);
  });
});
