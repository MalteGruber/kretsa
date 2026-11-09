// VS Code "Dark Modern" colors for KiCanvas' canvases.
//
// KiCanvas ships only "kicad" (cream paper) and "witchhazel" themes and has no API to add one, so we
// recolor the theme objects in place after mount (their Color instances are mutable and shared by the
// painters), then repaint. Idempotent. Token colors follow VS Code's Dark+ syntax palette.

const SCH: Record<string, string> = {
  background: "#1f1f1f",
  grid: "#3c3c3c",
  grid_axes: "#569cd6",
  worksheet: "#6e7681",
  wire: "#4ec9b0",
  junction: "#4ec9b0",
  bus: "#c586c0",
  bus_junction: "#c586c0",
  no_connect: "#f14c4c",
  component_outline: "#569cd6",
  component_body: "#252526",
  pin: "#569cd6",
  pin_name: "#9cdcfe",
  pin_number: "#858585",
  reference: "#dcdcaa",
  value: "#ce9178",
  fields: "#8b949e",
  label_local: "#d4d4d4",
  label_global: "#c586c0",
  label_hier: "#d7ba7d",
  netclass_flag: "#8b949e",
  note: "#6a9955",
  sheet: "#c586c0",
  sheet_background: "rgba(0,0,0,0)",
  sheet_fields: "#8b949e",
  sheet_filename: "#ce9178",
  sheet_label: "#9cdcfe",
  sheet_name: "#dcdcaa",
  hidden: "#6e7681",
  brightened: "#ffd700",
  anchor: "#569cd6",
  aux_items: "#d4d4d4",
  cursor: "#aeafad",
  rule_area: "#f14c4c",
  shadow: "rgba(0,120,212,0.35)",
};

const BOARD: Record<string, string> = {
  background: "#1f1f1f",
  grid: "#3c3c3c",
  grid_axes: "#569cd6",
};

function hex(css: string): [number, number, number, number] {
  const m = css.match(/rgba?\(([^)]+)\)/);
  if (m) {
    const [r, g, b, a = "1"] = m[1]!.split(",").map((s) => s.trim());
    return [Number(r) / 255, Number(g) / 255, Number(b) / 255, Number(a)];
  }
  const h = css.replace("#", "");
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).concat(1) as [number, number, number, number];
}

function recolor(theme: any, colors: Record<string, string>) {
  for (const [k, css] of Object.entries(colors)) {
    const c = theme?.[k];
    if (!c || typeof c.r !== "number") continue;
    [c.r, c.g, c.b, c.a] = hex(css);
  }
}

/** Apply the dark palette to a KiCanvas viewer and repaint it. */
export function applyDarkTheme(viewer: any, kind: "sch" | "pcb") {
  if (!viewer?.theme || viewer.__wiberThemed) return;
  viewer.__wiberThemed = true;
  recolor(viewer.theme, kind === "sch" ? SCH : BOARD);
  // Translucent VS Code-blue selection instead of the default white box (opaque on schematics).
  const Color = viewer.theme.background.constructor;
  const sel = new Color(...hex("rgba(0,120,212,0.35)"));
  Object.defineProperty(viewer, "selection_color", { get: () => sel, configurable: true });
  try { viewer.paint(); viewer.draw(); } catch (e) { console.warn("theme repaint failed", e); }
}
