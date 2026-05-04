import { describe, expect, it } from "vitest";
import { detectMojibake } from "../lib/mojibake.js";

describe("detectMojibake", () => {
  describe("clean Cyrillic — no false positives", () => {
    it("accepts Ukrainian electrical terms", () => {
      expect(detectMojibake("УЗО, Нульова шина, ДБН")).toEqual([]);
    });

    it("accepts clean Ukrainian sentence", () => {
      expect(detectMojibake("Захисний провідник з'єднаний з шиною PE")).toEqual([]);
    });

    it("accepts clean Russian text", () => {
      expect(detectMojibake("Нулевой провод подключён к шине N")).toEqual([]);
    });

    it("accepts ASCII-only text", () => {
      expect(detectMojibake("Hello world: POST /api/issues")).toEqual([]);
    });

    it("returns empty array for empty string", () => {
      expect(detectMojibake("")).toEqual([]);
    });
  });

  describe("mojibake patterns — detected", () => {
    it("detects Р— (was Cyrillic З)", () => {
      const hits = detectMojibake("РезультатР— invalid");
      expect(hits).toContain("Р—");
    });

    it("detects Р– (was Cyrillic Ж)", () => {
      const hits = detectMojibake("textР–more");
      expect(hits).toContain("Р–");
    });

    it("detects РЈ (was Cyrillic У)", () => {
      const hits = detectMojibake("РЈзо");
      expect(hits).toContain("РЈ");
    });

    it("detects вЂ (was em-dash prefix)", () => {
      const hits = detectMojibake("DescriptionвЂ something");
      expect(hits).toContain("вЂ");
    });

    it("detects Сѓ (was Cyrillic у)", () => {
      const hits = detectMojibake("Сѓзор");
      expect(hits).toContain("Сѓ");
    });
  });

  describe("double-encoded mock bodies", () => {
    it("detects mojibake from a typical PowerShell-corrupted Cyrillic description", () => {
      const corrupted = "РЈСЃС‚Р°Р½РѕРІРёС‚Рё Р·Р°С…РёСЃС‚ РЅСѓР»СЊРѕРІРѕС— С€РёРЅРё";
      const hits = detectMojibake(corrupted);
      expect(hits.length).toBeGreaterThan(0);
    });

    it("detects mojibake in a mixed title+description string", () => {
      const combined = "Clean title\nРЈзо is a protection device вЂ see spec";
      const hits = detectMojibake(combined);
      expect(hits).toContain("РЈ");
      expect(hits).toContain("вЂ");
    });
  });

  describe("multiple signatures", () => {
    it("reports all matched signatures", () => {
      const text = "Р— prefix and вЂ em-dash and Сѓ more";
      const hits = detectMojibake(text);
      expect(hits).toContain("Р—");
      expect(hits).toContain("вЂ");
      expect(hits).toContain("Сѓ");
    });

    it("does not duplicate signatures when pattern appears multiple times", () => {
      const text = "Р— first Р— second";
      const hits = detectMojibake(text);
      const rHits = hits.filter((h) => h === "Р—");
      expect(rHits).toHaveLength(1);
    });
  });
});
