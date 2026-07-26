import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_LANGUAGE, LANGUAGES, format, getLanguage, setLanguage, translate } from "@/lib/i18n";
import { TRANSLATIONS, type TranslationKey } from "@/lib/i18n/translations";

afterEach(() => {
  setLanguage(DEFAULT_LANGUAGE);
});

describe("the message catalogue", () => {
  const keys = Object.keys(TRANSLATIONS) as TranslationKey[];

  it("covers every key in both languages", () => {
    const incomplete = keys.filter((key) => !TRANSLATIONS[key].en?.trim() || !TRANSLATIONS[key].de?.trim());
    expect(incomplete).toEqual([]);
  });

  it("is not merely English copied into the German column", () => {
    // A handful of terms are genuinely identical in both languages; anything
    // beyond that is an untranslated string that slipped through.
    const identical = keys.filter((key) => TRANSLATIONS[key].en === TRANSLATIONS[key].de);
    expect(identical.length).toBeLessThan(keys.length * 0.15);
  });

  it("uses the same placeholders in both languages", () => {
    const placeholders = (value: string) => (value.match(/\{(\w+)\}/g) ?? []).sort();
    const mismatched = keys.filter(
      (key) => placeholders(TRANSLATIONS[key].en).join() !== placeholders(TRANSLATIONS[key].de).join(),
    );
    expect(mismatched).toEqual([]);
  });
});

describe("format", () => {
  it("substitutes named placeholders", () => {
    expect(format("Added {name}", { name: "Box" })).toBe("Added Box");
    expect(format("{count} of {total}", { count: 2, total: 5 })).toBe("2 of 5");
  });

  it("leaves an unknown placeholder visible rather than blanking it", () => {
    expect(format("Added {name}", {})).toBe("Added {name}");
  });

  it("returns the template unchanged when there is nothing to substitute", () => {
    expect(format("Ready")).toBe("Ready");
  });
});

describe("translate", () => {
  it("returns the string for the requested language", () => {
    expect(translate("tool.copy", undefined, "en")).toBe("Copy");
    expect(translate("tool.copy", undefined, "de")).toBe("Kopieren");
  });

  it("follows the active language when none is given", () => {
    expect(translate("tool.delete")).toBe("Delete");
    setLanguage("de");
    expect(translate("tool.delete")).toBe("Löschen");
  });

  it("falls back to the key itself for an unknown message", () => {
    expect(translate("does.not.exist" as TranslationKey)).toBe("does.not.exist");
  });
});

describe("the language store", () => {
  it("starts on the default language", () => {
    expect(getLanguage()).toBe(DEFAULT_LANGUAGE);
    expect(LANGUAGES).toContain(DEFAULT_LANGUAGE);
  });

  it("switches and reports the new language", () => {
    setLanguage("de");
    expect(getLanguage()).toBe("de");
    setLanguage("en");
    expect(getLanguage()).toBe("en");
  });

  it("ignores a language it does not have", () => {
    setLanguage("fr" as "de");
    expect(getLanguage()).toBe(DEFAULT_LANGUAGE);
  });
});
