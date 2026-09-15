import { describe, expect, it } from "vitest";
import { MAX_PIECES_PER_PROFILE, MAX_PROFILES, ProfileSchema, WorkspaceSchema, packNameFor, profileIdFromName } from "../src/index.js";

describe("profiles", () => {
  it("derives namespace-safe ids from names and avoids taken ones", () => {
    const none = new Set<string>();
    expect(profileIdFromName("Chloë-Mae", none)).toBe("chloe_mae");
    expect(profileIdFromName("Dad", none)).toBe("dad");
    expect(profileIdFromName("  Jules  ", none)).toBe("jules");
    expect(profileIdFromName("123", none)).toBe("p_123");
    expect(profileIdFromName("!!!", none)).toBe("p");
    expect(profileIdFromName("Christopher Robinson", none)).toBe("christopher_robi");
    expect(profileIdFromName("Jules", new Set(["jules"]))).toBe("jules2");
    expect(profileIdFromName("Jules", new Set(["jules", "jules2"]))).toBe("jules3");
    expect(profileIdFromName("Christopher Robinson", new Set(["christopher_robi"]))).toBe("christopher_rob2");
  });

  it("names packs after the person", () => {
    expect(packNameFor("Robin")).toBe("Robin's Furniture");
    expect(packNameFor("Jules")).toBe("Jules' Furniture");
  });

  it("limits and defaults", () => {
    expect(MAX_PROFILES).toBe(3);
    expect(MAX_PIECES_PER_PROFILE).toBe(11);
    expect(3 * MAX_PIECES_PER_PROFILE * 4).toBeLessThanOrEqual(143);
    const ws = WorkspaceSchema.parse({});
    expect(ws).toEqual({ profiles: [], retired: [], admin: null, serverVersion: [1, 0, 0] });
    expect(() => ProfileSchema.parse({ id: "Robin", name: "Robin", icon: "🦄", role: "kid", createdAt: new Date().toISOString() })).toThrow();
    expect(() => WorkspaceSchema.parse({ profiles: Array.from({ length: 4 }, (_, i) => ({ id: `p${i}`, name: "x", icon: "x", role: "kid", createdAt: new Date().toISOString() })) })).toThrow();
  });
});
