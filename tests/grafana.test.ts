import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import jmespath from "jmespath";
import { parse } from "yaml";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const config = read("infra/grafana/grafana.ini");
const sections: Record<string, Record<string, string>> = {};
let section = "";
for (const line of config.split(/\r?\n/)) {
  if (line.startsWith("[")) {
    section = line.slice(1, -1);
    sections[section] = {};
  } else if (line.trim() && !line.startsWith(";")) {
    const separator = line.indexOf("=");
    if (separator >= 0) sections[section]![line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
}

describe("Grafana access policy", () => {
  const oauth = sections["auth.generic_oauth"]!;

  it("grants administration only to the exact verified owner email", () => {
    expect(
      jmespath.search({ sub: "owner", email: "hutteau.b@gmail.com", email_verified: true }, oauth.role_attribute_path!),
    ).toBe("GrafanaAdmin");
    expect(oauth.role_attribute_strict).toBe("true");
    expect(oauth.skip_org_role_sync).toBe("false");
    expect(oauth.allow_assign_grafana_admin).toBe("true");
  });

  it.each([
    {},
    { email: "hutteau.b@gmail.com" },
    { email: "hutteau.b@gmail.com", email_verified: false },
    { email: "hutteau.b@gmail.com", email_verified: "true" },
    { email: "another@gmail.com", email_verified: true },
    { email: "hutteau.b@gmail.com.attacker.example", email_verified: true },
    { email: "HUTTEAU.B@gmail.com", email_verified: true },
    { email: ["hutteau.b@gmail.com"], email_verified: true },
    { email: null, email_verified: true },
  ])("denies unmatched or unverified claims: %j", (claims) => {
    expect(["Viewer", "Editor", "Admin", "GrafanaAdmin"]).not.toContain(
      jmespath.search(claims, oauth.role_attribute_path!),
    );
  });

  it("disables alternative login methods and validates signed tokens", () => {
    expect(sections["auth.basic"]!.enabled).toBe("false");
    expect(sections["auth.anonymous"]!.enabled).toBe("false");
    expect(sections.auth!.disable_login_form).toBe("true");
    expect(sections.auth!.oauth_allow_insecure_email_lookup).toBe("false");
    expect(sections.security!.disable_initial_admin_creation).toBe("true");
    expect(sections.security!.cookie_secure).toBe("true");
    expect(sections.users!.allow_sign_up).toBe("false");
    // OAuth account creation stays enabled so the owner can log in the first time.
    expect(oauth.allow_sign_up).toBe("true");
    expect(oauth.use_pkce).toBe("true");
    expect(oauth.validate_id_token).toBe("true");
    expect(oauth.jwk_set_url).toBe("$__env{GRAFANA_OIDC_ISSUER_URL}/jwks");
    expect(oauth.scopes).toBe("openid profile email");
  });
});

describe("Grafana deployment", () => {
  const compose = parse(read("compose.yaml"));
  const datasource = parse(read("infra/grafana/provisioning/datasources/scim-lab.yaml")).datasources[0];
  const dashboard = JSON.parse(read("infra/grafana/dashboards/scim-lab.json"));

  it("waits for migrated metrics permissions and keeps databases off host ports", () => {
    expect(compose.services.grafana.depends_on["metrics-setup"].condition).toBe("service_completed_successfully");
    expect(compose.services["metrics-setup"].depends_on.migrate.condition).toBe("service_completed_successfully");
    for (const service of ["grafana", "database", "logto-database"]) {
      expect(compose.services[service].ports).toBeUndefined();
    }
    expect(compose.services.grafana.environment.GRAFANA_DATABASE_PASSWORD).toBe(
      compose.services["metrics-setup"].environment.GRAFANA_DATABASE_PASSWORD,
    );
    expect(compose.services.grafana.environment.GRAFANA_DATABASE_PASSWORD).toMatch(
      /^\$\{SERVICE_PASSWORD_64_GRAFANA_DB:\?[^}]+\}$/,
    );
    expect(datasource.user).toBe("grafana_metrics");
    expect(datasource.editable).toBe(false);
    expect(datasource.secureJsonData.password).toBe("$GRAFANA_DATABASE_PASSWORD");
  });

  it("uses the provisioned datasource for every dashboard query", () => {
    const provider = parse(read("infra/grafana/provisioning/dashboards/scim-lab.yaml")).providers[0];
    expect(provider.allowUiUpdates).toBe(false);
    for (const panel of dashboard.panels) {
      expect(panel.datasource.uid).toBe(datasource.uid);
      for (const target of panel.targets) {
        expect(target.datasource.uid).toBe(datasource.uid);
        expect(target.rawSql).toMatch(/metrics\.(overview|registrations_daily|anonymous_last_login_daily)/);
        expect(target.rawSql).not.toMatch(/public\./);
      }
    }
  });
});
