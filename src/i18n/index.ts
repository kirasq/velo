/**
 * Lightweight i18n for velo (fork).
 *
 * Design goals:
 * - Zero dependencies (no react-i18next) to keep the fork lean and avoid
 *   breaking changes across 250+ files.
 * - Progressive adoption: components opt in by calling `t("key")`. Any key
 *   missing from a locale falls back to English, so the app never shows blank.
 * - Language persists in settings (`app_language`) with "system" as default.
 *
 * Usage:
 *   import { t, useLang, setLanguage, type Lang } from "@/i18n";
 *   const lbl = t("accounts.title");
 *   const hello = t("greeting", { name: "Kira" });  // "Hello, {name}"
 */

export type Lang = "zh" | "en";

const LANG_KEY = "app_language"; // "zh" | "en" | "system"

/** All English strings live here. `zh.ts` overrides a subset. */
import { en } from "./en";
import { zh } from "./zh";

type Dict = Record<string, string>;

const dictionaries: Record<Lang, Dict> = { en, zh };

function systemLang(): Lang {
  if (typeof navigator !== "undefined" && navigator.language) {
    return navigator.language.toLowerCase().startsWith("zh") ? "zh" : "en";
  }
  return "en";
}

function readStored(): string {
  try {
    // Settings API is async; we also mirror to localStorage for instant reads
    // at module init (before the DB is ready).
    if (typeof localStorage !== "undefined") {
      const v = localStorage.getItem(LANG_KEY);
      if (v) return v;
    }
  } catch {
    /* ignore */
  }
  return "system";
}

let currentMode: string = readStored(); // "zh" | "en" | "system"
let currentLang: Lang = currentMode === "system" ? systemLang() : (currentMode as Lang);

const listeners = new Set<() => void>();

function resolveLang(): Lang {
  if (currentMode === "system") return systemLang();
  return currentMode === "zh" ? "zh" : "en";
}

function emit() {
  currentLang = resolveLang();
  listeners.forEach((fn) => fn());
}

export function getLanguage(): Lang {
  return currentLang;
}

export function getLanguageMode(): string {
  return currentMode;
}

/**
 * Set the language mode. "system" follows the OS language.
 * Persists to localStorage immediately and to settings DB asynchronously.
 */
export function setLanguage(mode: string): void {
  currentMode = mode;
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(LANG_KEY, mode);
    }
  } catch {
    /* ignore */
  }
  // Best-effort async persistence to the app settings DB.
  import("@/services/db/settings")
    .then(({ setSetting }) => setSetting(LANG_KEY, mode))
    .catch(() => {});
  emit();
}

/** React hook: re-renders the component when the language changes. */
export function useLang(): Lang {
  const [lang, setLang] = useState(currentLang);
  useEffect(() => {
    setLang(currentLang);
    listeners.add(() => setLang(currentLang));
    return () => {
      listeners.delete(() => setLang(currentLang));
    };
  }, []);
  return lang;
}

/** also re-export for convenience */
import { useState, useEffect } from "react";

/**
 * Translate a key. Supports `{var}` interpolation.
 * Falls back to English if the key is missing in the active locale,
 * and to the raw key if missing in both (so nothing is ever blank).
 */
export function t(key: string, vars?: Record<string, string | number>): string {
  const dict = dictionaries[currentLang] ?? dictionaries.en;
  let str: string | undefined = dict[key] ?? dictionaries.en[key] ?? key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      str = str.replace(new RegExp(`\\{${k}\\}`, "g"), String(v));
    }
  }
  return str;
}

/** Initialize language from the settings DB once it is available. */
export async function initLanguageFromSettings(): Promise<void> {
  try {
    const { getSetting } = await import("@/services/db/settings");
    const v = await getSetting(LANG_KEY);
    if (v && v !== currentMode) {
      currentMode = v;
      try {
        if (typeof localStorage !== "undefined") localStorage.setItem(LANG_KEY, v);
      } catch {
        /* ignore */
      }
      emit();
    }
  } catch {
    /* ignore */
  }
}
