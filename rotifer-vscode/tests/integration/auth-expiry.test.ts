import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("vscode", () => import("../__mocks__/vscode"));

describe("Integration: auth expiry handling", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("RotiferCloudClient defaults to unauthenticated", async () => {
    const { RotiferCloudClient } = await import("../../src/cloud-client");
    const client = new RotiferCloudClient();
    expect(client.isAuthenticated).toBe(false);
  });

  it("RotiferCloudClient can set and check token", async () => {
    const { RotiferCloudClient } = await import("../../src/cloud-client");
    const client = new RotiferCloudClient();
    client.setAccessToken("test-token-123");
    expect(client.isAuthenticated).toBe(true);
  });

  it("RotiferCloudClient clearing token returns to unauthenticated", async () => {
    const { RotiferCloudClient } = await import("../../src/cloud-client");
    const client = new RotiferCloudClient();
    client.setAccessToken("test-token-123");
    client.setAccessToken(null);
    expect(client.isAuthenticated).toBe(false);
  });
});
