// Minimal KiCad s-expression reader (read-only). Lists are arrays; atoms are strings (quotes removed).

export type SExpr = string | SExpr[];

export function parseSexpr(text: string): SExpr[] {
  const stack: SExpr[][] = [[]];
  const re = /\(|\)|"((?:\\.|[^"\\])*)"|[^\s()"]+/g;
  for (let m; (m = re.exec(text)); ) {
    const t = m[0];
    if (t === "(") stack.push([]);
    else if (t === ")") {
      const done = stack.pop()!;
      stack[stack.length - 1]?.push(done);
    } else stack[stack.length - 1]!.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, (_, c) => (c === "n" ? "\n" : c)) : t);
  }
  return stack[0]!;
}

export const isList = (x: SExpr | undefined): x is SExpr[] => Array.isArray(x);
export const head = (x: SExpr | undefined) => (isList(x) ? x[0] : undefined);

/** Child lists of `node` whose first atom is `name`. */
export function kids(node: SExpr[], name: string): SExpr[][] {
  return node.filter((c): c is SExpr[] => isList(c) && c[0] === name);
}
export function kid(node: SExpr[], name: string): SExpr[] | undefined {
  return node.find((c): c is SExpr[] => isList(c) && c[0] === name);
}
/** The first atom after the head of child `name`, e.g. (layer "F.Cu") -> "F.Cu". */
export function val(node: SExpr[], name: string): string | undefined {
  const k = kid(node, name);
  return k && typeof k[1] === "string" ? k[1] : undefined;
}
export function nums(node: SExpr[] | undefined, from = 1): number[] {
  return node ? node.slice(from).filter((x): x is string => typeof x === "string").map(Number).filter((n) => !Number.isNaN(n)) : [];
}
/** Flags like (hide yes) or a bare `hide` atom. */
export function flag(node: SExpr[], name: string): boolean {
  const k = kid(node, name);
  if (k) return k[1] === undefined || k[1] === "yes";
  return node.includes(name);
}
