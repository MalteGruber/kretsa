import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve, sep, basename } from "node:path";
import type { ProjectFile, ProjectInfo } from "../../shared/review";

const KINDS: Record<string, ProjectFile["kind"]> = {
  ".kicad_pro": "pro",
  ".kicad_sch": "sch",
  ".kicad_pcb": "pcb",
};
const SKIP_DIRS = new Set([".kretsa", ".wiber", ".git", "node_modules"]);

function hash(data: string | Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(data).digest("hex").slice(0, 16);
}

async function walk(dir: string, out: string[] = []): Promise<string[]> {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name) && !e.name.endsWith("-backups")) await walk(join(dir, e.name), out);
    } else if (Object.keys(KINDS).some((ext) => e.name.endsWith(ext))) {
      out.push(join(dir, e.name));
    }
  }
  return out;
}

export async function scanProject(dir: string, kicadCli: string | null): Promise<ProjectInfo> {
  const paths = (await walk(dir)).sort();
  const files: ProjectFile[] = [];
  for (const p of paths) {
    const ext = Object.keys(KINDS).find((e) => p.endsWith(e))!;
    files.push({
      path: relative(dir, p).split(sep).join("/"),
      kind: KINDS[ext]!,
      hash: hash(await readFile(p)),
    });
  }
  const pro = files.find((f) => f.kind === "pro");
  return {
    name: pro ? basename(pro.path, ".kicad_pro") : basename(dir),
    dir,
    rev: hash(files.map((f) => f.path + f.hash).join("\n")),
    files,
    kicadCli,
  };
}

/** Resolve a project-relative path, refusing anything that escapes the project dir. */
export function safeJoin(dir: string, rel: string): string | null {
  const p = resolve(dir, rel);
  return p === dir || p.startsWith(dir + sep) ? p : null;
}
