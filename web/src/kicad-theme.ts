// Canvas colors from the user's theme file (GET /api/theme; defaults in shared/theme.ts).
//
// KiCanvas ships only "kicad" (cream paper) and "witchhazel" themes and has no API to add one, so we
// recolor its theme objects in place (their Color instances are mutable and shared by the painters and
// layers), then repaint. Re-applied when the theme file changes (version counter).

import { parseColor, resolveTheme, type Theme } from "../../shared/theme";

let theme: Theme = resolveTheme(null).theme;
let version = 1;

export const currentTheme = (): Theme => theme;

/** Install a new theme; viewers pick it up on their next applyTheme() call. Also sets CSS vars for overlays. */
export function setTheme(t: Theme) {
  theme = t;
  version++;
  const s = document.documentElement.style;
  s.setProperty("--net-hl", t.highlight.net);
  s.setProperty("--breathe", t.highlight.breathe_seconds > 0 ? `${t.highlight.breathe_seconds}s` : "0s");
  document.documentElement.classList.toggle("no-breathe", !(t.highlight.breathe_seconds > 0));
}

function recolor(target: any, colors: Record<string, string>) {
  for (const [path, css] of Object.entries(colors)) {
    let c = target;
    for (const k of path.split(".")) c = c?.[k];
    if (!c || typeof c.r !== "number") continue;
    [c.r, c.g, c.b, c.a] = parseColor(css);
  }
}

/** Color object of this viewer's Color class (for things we draw through KiCanvas). */
export function kcColor(viewer: any, css: string): any {
  const Color = viewer.theme.background.constructor;
  return new Color(...parseColor(css));
}

/** Apply the current theme to a KiCanvas viewer and repaint it (no-op if it already has this version). */
export function applyTheme(viewer: any, kind: "sch" | "pcb"): boolean {
  if (!viewer?.theme || viewer.__kretsaTheme === version) return false;
  viewer.__kretsaTheme = version;
  recolor(viewer.theme, kind === "sch" ? theme.schematic : theme.board);
  const sel = kcColor(viewer, theme.highlight.selection);
  Object.defineProperty(viewer, "selection_color", { get: () => sel, configurable: true });
  // paint() rebuilds the layer set (layer colors come from the theme) and repaints everything.
  try { viewer.paint(); viewer.draw(); } catch (e) { console.warn("theme repaint failed", e); }
  return true;
}
