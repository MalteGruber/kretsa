// Viewer colors: one preference file (`kretsa theme` prints where), merged over these defaults.
//
// File format (every key optional; delete one to get the default back):
//   { "schematic": { "wire": "#4ec9b0", ... },
//     "board": { "F.Cu": "#c83434", "In1.Cu": "...", "F.SilkS": "...", "via_through": "...", ... },
//     "highlight": { "net": "#ff7a1a", "selection": "rgba(0,120,212,0.35)", "breathe_seconds": 1.6 },
//     "3d": { "background": "#1f1f1f" } }
// Board keys are KiCad layer names (F.Cu, B.SilkS, Edge.Cuts, User.1, …) or KiCanvas theme keys for
// non-layer items (via_through, pad_through_hole, …). Colors: #rgb, #rrggbb, #rrggbbaa, rgb(), rgba().

export interface Theme {
  schematic: Record<string, string>;
  /** Keys normalized to KiCanvas theme paths: "copper.f", "f_silks", "via_through", … */
  board: Record<string, string>;
  highlight: { net: string; selection: string; breathe_seconds: number };
  "3d": { background: string };
}

/** GET /api/theme */
export interface ThemeInfo {
  theme: Theme;
  path: string;
  exists: boolean;
  warnings: string[];
}

export const DEFAULT_SCHEMATIC: Record<string, string> = {
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
  erc_error: "rgba(230,9,13,0.8)",
  erc_warning: "rgba(209,146,0,0.8)",
};

/** Board colors as written to the file: KiCad layer names where there is a layer. KiCad's default palette on a dark background. */
export const DEFAULT_BOARD: Record<string, string> = {
  background: "#1f1f1f",
  grid: "#3c3c3c",
  grid_axes: "#569cd6",
  "F.Cu": "rgb(200,52,52)",
  "B.Cu": "rgb(77,127,196)",
  "In1.Cu": "rgb(127,200,127)",
  "In2.Cu": "rgb(206,125,44)",
  "In3.Cu": "rgb(79,203,203)",
  "In4.Cu": "rgb(219,98,139)",
  "In5.Cu": "rgb(167,165,198)",
  "In6.Cu": "rgb(40,204,217)",
  "F.SilkS": "rgb(242,237,161)",
  "B.SilkS": "rgb(232,178,167)",
  "F.Mask": "rgba(216,100,255,0.4)",
  "B.Mask": "rgba(2,255,238,0.4)",
  "F.Paste": "rgba(180,160,154,0.9)",
  "B.Paste": "rgba(0,194,194,0.9)",
  "F.Adhes": "rgb(132,0,132)",
  "B.Adhes": "rgb(0,0,132)",
  "F.CrtYd": "rgb(255,38,226)",
  "B.CrtYd": "rgb(38,233,255)",
  "F.Fab": "rgb(175,175,175)",
  "B.Fab": "rgb(88,93,132)",
  "Edge.Cuts": "rgb(208,210,205)",
  "Margin": "rgb(255,38,226)",
  "Dwgs.User": "rgb(194,194,194)",
  "Cmts.User": "rgb(89,148,220)",
  "Eco1.User": "rgb(180,219,210)",
  "Eco2.User": "rgb(216,200,82)",
  "User.1": "rgb(194,194,194)",
  "User.2": "rgb(89,148,220)",
  "User.3": "rgb(180,219,210)",
  "User.4": "rgb(216,200,82)",
  via_through: "rgb(236,236,236)",
  via_blind_buried: "rgb(187,151,38)",
  via_micro: "rgb(0,132,132)",
  via_hole: "rgb(227,183,46)",
  pad_through_hole: "rgb(227,183,46)",
  pad_plated_hole: "rgb(194,194,0)",
  non_plated_hole: "rgb(26,196,210)",
  ratsnest: "rgba(245,255,213,0.7)",
  footprint_text_invisible: "rgb(132,132,132)",
  worksheet: "#6e7681",
  aux_items: "rgb(255,255,255)",
  anchor: "rgb(255,38,226)",
  cursor: "rgb(255,255,255)",
  drc_error: "rgba(215,91,107,0.8)",
  drc_warning: "rgba(255,208,66,0.8)",
  drc_exclusion: "rgba(255,255,255,0.8)",
  no_connect: "rgb(0,0,132)",
};

export const DEFAULT_HIGHLIGHT: Theme["highlight"] = { net: "#ff7a1a", selection: "rgba(0,120,212,0.35)", breathe_seconds: 1.6 };
export const DEFAULT_3D: Theme["3d"] = { background: "#1f1f1f" };

/** KiCad layer name (or theme key) -> KiCanvas board theme path. "F.Cu" -> "copper.f", "F.SilkS" -> "f_silks". */
export function boardThemeKey(name: string): string {
  const cu = name.match(/^(F|B|In\d+)\.Cu$/i);
  if (cu) return `copper.${cu[1]!.toLowerCase()}`;
  return name.toLowerCase().replace(/\./g, "_");
}

const COLOR = /^(#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})|rgba?\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*(,\s*[\d.]+\s*)?\))$/i;
export const isColor = (s: unknown): s is string => typeof s === "string" && COLOR.test(s.trim());

/** CSS color -> [r, g, b, a] in 0..1 (the formats isColor accepts). */
export function parseColor(css: string): [number, number, number, number] {
  const s = css.trim();
  const m = s.match(/rgba?\(([^)]+)\)/i);
  if (m) {
    const [r, g, b, a = "1"] = m[1]!.split(",").map((x) => x.trim());
    return [Number(r) / 255, Number(g) / 255, Number(b) / 255, Number(a)];
  }
  let h = s.replace("#", "");
  if (h.length === 3) h = [...h].map((c) => c + c).join("");
  const v = [0, 2, 4, 6].map((i) => (i < h.length ? parseInt(h.slice(i, i + 2), 16) / 255 : 1));
  return v as [number, number, number, number];
}

/** The defaults in file form (what `kretsa theme init` writes). */
export function defaultThemeFile(): Record<string, unknown> {
  return {
    $comment: "kretsa viewer colors. Save and the open viewer updates. Delete a key to get its default back. Board keys: KiCad layer names (F.Cu, In1.Cu, B.SilkS, Edge.Cuts, User.1, …) or item keys (via_through, pad_through_hole, …). Colors: #rgb, #rrggbb, #rrggbbaa, rgb(), rgba().",
    schematic: DEFAULT_SCHEMATIC,
    board: DEFAULT_BOARD,
    highlight: DEFAULT_HIGHLIGHT,
    "3d": DEFAULT_3D,
  };
}

/** Merge a parsed theme file over the defaults; bad entries are skipped with a warning. */
export function resolveTheme(file: unknown): { theme: Theme; warnings: string[] } {
  const warnings: string[] = [];
  const board: Record<string, string> = {};
  for (const [k, v] of Object.entries(DEFAULT_BOARD)) board[boardThemeKey(k)] = v;
  const theme: Theme = { schematic: { ...DEFAULT_SCHEMATIC }, board, highlight: { ...DEFAULT_HIGHLIGHT }, "3d": { ...DEFAULT_3D } };
  if (file == null) return { theme, warnings };
  if (typeof file !== "object" || Array.isArray(file)) return { theme, warnings: ["the theme file must be a JSON object"] };
  const f = file as Record<string, unknown>;
  const section = (name: string): Record<string, unknown> => {
    const s = f[name];
    if (s == null) return {};
    if (typeof s === "object" && !Array.isArray(s)) return s as Record<string, unknown>;
    warnings.push(`"${name}" must be an object`);
    return {};
  };
  for (const k of Object.keys(f)) if (!["$comment", "schematic", "board", "highlight", "3d"].includes(k)) warnings.push(`unknown section "${k}"`);
  for (const [k, v] of Object.entries(section("schematic"))) {
    if (!(k in DEFAULT_SCHEMATIC)) warnings.push(`schematic: unknown key "${k}"`);
    else if (!isColor(v)) warnings.push(`schematic.${k}: not a color: ${JSON.stringify(v)}`);
    else theme.schematic[k] = v.trim();
  }
  const knownBoard = new Set(Object.keys(board));
  for (const [k, v] of Object.entries(section("board"))) {
    // Also accept KiCanvas' nested form: "copper": { "f": "#…", "in1": "#…" }.
    if (k === "copper" && v && typeof v === "object") {
      for (const [ck, cv] of Object.entries(v as Record<string, unknown>)) {
        if (!/^(f|b|in\d+)$/.test(ck)) warnings.push(`board.copper: unknown key "${ck}"`);
        else if (!isColor(cv)) warnings.push(`board.copper.${ck}: not a color: ${JSON.stringify(cv)}`);
        else theme.board[`copper.${ck}`] = cv.trim();
      }
      continue;
    }
    const key = boardThemeKey(k);
    if (!knownBoard.has(key) && !/^copper\.in\d+$/.test(key) && !/^user_\d+$/.test(key)) warnings.push(`board: unknown key "${k}"`);
    else if (!isColor(v)) warnings.push(`board.${k}: not a color: ${JSON.stringify(v)}`);
    else theme.board[key] = v.trim();
  }
  const hl = section("highlight");
  for (const k of ["net", "selection"] as const) {
    if (hl[k] == null) continue;
    if (isColor(hl[k])) theme.highlight[k] = (hl[k] as string).trim();
    else warnings.push(`highlight.${k}: not a color: ${JSON.stringify(hl[k])}`);
  }
  if (hl.breathe_seconds != null) {
    const n = Number(hl.breathe_seconds);
    if (Number.isFinite(n) && n >= 0) theme.highlight.breathe_seconds = n;
    else warnings.push(`highlight.breathe_seconds: not a number >= 0 (0 = no breathing)`);
  }
  for (const k of Object.keys(hl)) if (!["net", "selection", "breathe_seconds"].includes(k)) warnings.push(`highlight: unknown key "${k}"`);
  const d3 = section("3d");
  if (d3.background != null) {
    if (isColor(d3.background)) theme["3d"].background = (d3.background as string).trim();
    else warnings.push(`3d.background: not a color: ${JSON.stringify(d3.background)}`);
  }
  return { theme, warnings };
}
