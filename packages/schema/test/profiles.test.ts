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
    expect(MAX_PROFILES).toBe(5);
    expect(MAX_PIECES_PER_PROFILE).toBe(11);
    // What the family server can hold is a shared budget (four carrier states per piece), not this cap;
    // one profile alone must never be able to exhaust it.
    expect(MAX_PIECES_PER_PROFILE * 4).toBeLessThanOrEqual(143);
    const ws = WorkspaceSchema.parse({});
    expect(ws).toEqual({ profiles: [], retired: [], admin: null, serverVersion: [1, 0, 0] });
    expect(() => ProfileSchema.parse({ id: "Robin", name: "Robin", icon: "🦄", role: "kid", createdAt: new Date().toISOString() })).toThrow();
    expect(() => WorkspaceSchema.parse({ profiles: Array.from({ length: MAX_PROFILES + 1 }, (_, i) => ({ id: `p${i}`, name: "x", icon: "x", role: "kid", createdAt: new Date().toISOString() })) })).toThrow();
    // Everyone is on the family server unless it is turned off; a guest starts off it (see createProfile).
    const profile = { id: "robin", name: "Robin", icon: "🦄", role: "kid", createdAt: new Date().toISOString() };
    expect(ProfileSchema.parse(profile).onFamilyServer).toBe(true);
    expect(ProfileSchema.parse({ ...profile, role: "guest", onFamilyServer: false }).onFamilyServer).toBe(false);
  });
});
