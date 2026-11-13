// The viewer's color preference file: one per user, so every workspace looks the same.
// $KRETSA_THEME, else $XDG_CONFIG_HOME/kretsa/theme.json, else ~/.config/kretsa/theme.json.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { defaultThemeFile, resolveTheme, type ThemeInfo } from "../../shared/theme";

export function themePath(): string {
  if (process.env.KRETSA_THEME) return process.env.KRETSA_THEME;
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "kretsa", "theme.json");
}

export function readTheme(path = themePath()): ThemeInfo {
  if (!existsSync(path)) return { ...resolveTheme(null), path, exists: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    return { ...resolveTheme(null), path, exists: true, warnings: [`can't parse ${path}: ${(e as Error).message}; using the defaults`] };
  }
  return { ...resolveTheme(parsed), path, exists: true };
}

/** Write the full default theme (so every key is there to edit). Refuses to overwrite unless `force`. */
export function initTheme(force = false, path = themePath()): { path: string; written: boolean } {
  if (existsSync(path) && !force) return { path, written: false };
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(defaultThemeFile(), null, 2) + "\n");
  renameSync(tmp, path);
  return { path, written: true };
}
