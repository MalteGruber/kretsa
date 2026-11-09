// Safe edits to symbol fields (`kretsa lib set`), so an agent doesn't hand-edit s-expressions for
// routine changes. Edits are spliced into the original text (KiCad's formatting is kept), the result
// is parsed back and checked, and the file is replaced atomically. Only .kicad_sym property values;
// never schematics or boards.

import { readFile, rename, writeFile } from "node:fs/promises";
import { kids, parseSexpr } from "./sexpr";

interface Tok { t: string; start: number; end: number }

function* tokens(text: string): Generator<Tok> {
  const re = /\(|\)|"((?:\\.|[^"\\])*)"|[^\s()"]+/g;
  for (let m; (m = re.exec(text)); ) yield { t: m[0], start: m.index, end: m.index + m[0].length };
}

const quote = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
const unquote = (s: string) => s.slice(1, -1).replace(/\\(.)/g, (_, c) => (c === "n" ? "\n" : c));

/** [start, end) of the top-level `(symbol "name" …)` of a .kicad_sym text. */
function symbolSpan(text: string, name: string): [number, number] | null {
  let depth = 0, open = -1, pending: number | null = null, prev = "";
  for (const k of tokens(text)) {
    if (k.t === "(") { depth++; if (depth === 2) open = k.start; }
    else if (k.t === ")") {
      if (depth === 2 && pending !== null) return [pending, k.end];
      depth--;
    } else if (depth === 2 && prev === "symbol" && pending === null && k.t.startsWith('"') && unquote(k.t) === name) pending = open;
    prev = k.t;
  }
  return null;
}

/** Direct `(property "Field" "value" …)` children of the span: field -> value token position, and the span of the whole property. */
function properties(text: string, [s, e]: [number, number]) {
  const out = new Map<string, { value: Tok; span: [number, number] }>();
  let depth = 0, open = -1, state = 0, field = "";
  for (const k of tokens(text.slice(s, e))) {
    const t = { ...k, start: k.start + s, end: k.end + s };
    if (t.t === "(") { depth++; if (depth === 2) { open = t.start; state = 1; } continue; }
    if (t.t === ")") {
      if (depth === 2 && state === 3) { const p = out.get(field)!; p.span = [open, t.end]; }
      depth--; if (depth < 2) state = 0; continue;
    }
    if (depth !== 2) continue;
    if (state === 1) state = t.t === "property" ? 2 : 0;
    else if (state === 2) { field = unquote(t.t); state = 2.5; }
    else if (state === 2.5) { out.set(field, { value: t, span: [open, -1] }); state = 3; }
  }
  return out;
}

export interface FieldEdit { field: string; value: string | null } // null = remove

/**
 * Set (or remove, value null) fields of symbol `name` in `file`. New fields are added hidden, after the
 * last property, with the Value field's text settings. Returns a description of what changed.
 */
export async function setSymbolFields(file: string, name: string, edits: FieldEdit[]): Promise<string[]> {
  let text = await readFile(file, "utf8");
  const changed: string[] = [];
  for (const { field, value } of edits) {
    if (["Reference", "Value"].includes(field) && value === null) throw new Error(`${field} can't be removed`);
    const span = symbolSpan(text, name);
    if (!span) throw new Error(`symbol "${name}" not found in ${file}`);
    const props = properties(text, span);
    const p = props.get(field);
    if (p && value === null) {
      let [a, b] = p.span;
      while (a > 0 && /[ \t]/.test(text[a - 1]!)) a--;
      if (text[a - 1] === "\n") a--;
      text = text.slice(0, a) + text.slice(b);
      changed.push(`removed ${field}`);
    } else if (p) {
      const old = unquote(p.value.t);
      if (old === value) continue;
      text = text.slice(0, p.value.start) + quote(value!) + text.slice(p.value.end);
      changed.push(`${field}: "${old}" → "${value}"`);
    } else if (value !== null) {
      const last = [...props.values()].sort((x, y) => y.span[1] - x.span[1])[0];
      if (!last) throw new Error(`symbol "${name}" has no properties`);
      const version = Number(text.match(/\(version\s+(\d+)\)/)?.[1] ?? 0);
      const hide = version >= 20231120 ? "(hide yes)" : "hide";
      const lineStart = text.lastIndexOf("\n", last.span[0]) + 1;
      const indent = text.slice(lineStart, last.span[0]);
      const block = `(property ${quote(field)} ${quote(value)} (at 0 0 0) (effects (font (size 1.27 1.27)) ${hide}))`;
      text = text.slice(0, last.span[1]) + "\n" + indent + block + text.slice(last.span[1]);
      changed.push(`added ${field} = "${value}"`);
    }
  }
  if (!changed.length) return [];
  // Parse back and verify before replacing the file.
  const root = parseSexpr(text)[0];
  const sym = Array.isArray(root) ? kids(root, "symbol").find((s) => s[1] === name) : undefined;
  if (!sym) throw new Error("edit produced an unreadable library; nothing written");
  for (const { field, value } of edits) {
    const got = kids(sym, "property").find((p) => p[1] === field);
    if (value === null ? got : got?.[2] !== value) throw new Error(`verification failed for ${field}; nothing written`);
  }
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, text);
  await rename(tmp, file);
  return changed;
}
