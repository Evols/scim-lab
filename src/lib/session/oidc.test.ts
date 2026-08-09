import { afterEach, describe, expect, it, vi } from "vitest";

describe("OIDC configuration", () => {
  afterEach(() => {
    vi.doUnmock("openid-client");
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

  it("requires the openid scope", async () => {
    vi.stubEnv("OIDC_SCOPES", "profile email");
    vi.resetModules();

    await expect(import("../config")).rejects.toThrow("OIDC_SCOPES must include the openid scope.");
  });

  it("discovers Logto as a confidential authorization-code client", async () => {
    const configuration = { provider: "logto" };
    const client_authentication = vi.fn();
    const discovery = vi.fn().mockResolvedValue(configuration);
    const client_secret_basic = vi.fn().mockReturnValue(client_authentication);
    vi.doMock("openid-client", () => ({
      ClientSecretBasic: client_secret_basic,
      discovery,
    }));
    vi.stubEnv("APP_ORIGIN", "https://scimlab.dev");
    vi.stubEnv("OIDC_ISSUER_URL", "https://auth.scimlab.dev/oidc");
    vi.stubEnv("OIDC_CLIENT_ID", "z3kp8emdt0f9pvugrds1i");
    vi.stubEnv("OIDC_CLIENT_SECRET", "test-secret");
    vi.resetModules();

    const { get_oidc_configuration } = await import("./oidc");

    await expect(get_oidc_configuration()).resolves.toBe(configuration);
    expect(client_secret_basic).toHaveBeenCalledWith("test-secret");
    expect(discovery).toHaveBeenCalledWith(
      new URL("https://auth.scimlab.dev/oidc"),
      "z3kp8emdt0f9pvugrds1i",
      {
        client_secret: "test-secret",
        redirect_uris: ["https://scimlab.dev/auth/callback"],
        response_types: ["code"],
        token_endpoint_auth_method: "client_secret_basic",
      },
      client_authentication,
    );
  });
});
