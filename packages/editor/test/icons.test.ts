import { describe, expect, it } from "vitest";
import { IconSchema } from "@blockshop/schema";
import { PROFILE_ICONS } from "../src/i18n.js";
import { CUSTOM_ICONS, customIconUrl } from "../src/icons.js";

describe("profile icons", () => {
  it("are unique and valid profile icons", () => {
    expect(new Set(PROFILE_ICONS).size).toBe(PROFILE_ICONS.length);
    for (const icon of PROFILE_ICONS) expect(IconSchema.safeParse(icon).success, icon).toBe(true);
  });

  it("offer the lion and the capybara next to each other", () => {
    const lion = PROFILE_ICONS.indexOf("🦁");
    expect(lion).toBeGreaterThanOrEqual(0);
    expect(PROFILE_ICONS[lion + 1]).toBe("icon:capybara");
  });

  it("have a drawing for every icon: entry, and nothing else uses the prefix", () => {
    for (const icon of PROFILE_ICONS.filter((i) => i.startsWith("icon:"))) {
      const custom = CUSTOM_ICONS[icon];
      expect(custom, icon).toBeDefined();
      expect(custom!.svg).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 64 64">[\s\S]*<\/svg>$/);
      expect(customIconUrl(custom!)).toMatch(/^data:image\/svg\+xml,%3Csvg/);
    }
    for (const key of Object.keys(CUSTOM_ICONS)) expect(PROFILE_ICONS).toContain(key);
  });
});
