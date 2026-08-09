import { afterEach, describe, expect, it, vi } from "vitest";

describe("OIDC configuration", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("rejects discovery when OpenID Connect is not configured", async () => {
    vi.stubEnv("OIDC_ISSUER_URL", "");
    vi.stubEnv("OIDC_CLIENT_ID", "");
    vi.stubEnv("OIDC_CLIENT_SECRET", "");
    vi.resetModules();
    const { get_oidc_configuration } = await import("./oidc");

    await expect(get_oidc_configuration()).rejects.toThrow("OpenID Connect is not configured for this deployment.");
  });
});
