// Starting the design agent from the viewer. Off unless configured: `kretsa serve --agent "<command>"`
// or `<workspace>/.kretsa/config.json` { "agent": { "command": [...], "prompt_extra": "...", "auto_start": true } }.
// The command is only ever taken from the server side (flag or config file), never from the browser.
// In the command, {prompt} is replaced by the agent prompt and {project_dir} by the project folder.

import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AgentRun } from "../../shared/review";

const ROOT = resolve(import.meta.dir, "../..");

export const DEFAULT_AGENT_PROMPT = `You are the PCB design agent for the KiCad project at {project_dir}. A human reviews your work in
the kretsa viewer and sends you comments with "Send to AI". You talk to them only through kretsa.

Before you start, read the CLAUDE.md files in this workspace (house style, part standards, tooling)
and {review_doc} if you haven't yet.

Loop:
1. Run \`kretsa wait --timeout {idle_seconds}\`. It returns the comments the human sent (immediately if
   some are waiting). If it times out (exit 3), stop: the human can start you again from the viewer.
2. For each comment: read the text, anchors (refs, nets, pins, areas) and the snapshot/ink image if
   there is one. Use \`kretsa render\` / \`kretsa diff\` to see the area if needed.
3. Make the change in the KiCad files. Prefer small, targeted edits; keep the files loadable by KiCad.
4. Verify: \`kretsa check\` (no NEW errors you caused), and \`kretsa render\` of what you changed.
   Look at the image.
5. Answer every comment: \`kretsa reply <#> "what you changed and how you verified it" --addressed\`.
   If you can't or shouldn't do it, \`--wontfix\` with the reason. If you need a decision, ask in a
   reply with \`--open\` and move on to the next comment. Never resolve comments; the human does.
6. Go back to 1.

Rules:
- Only touch files inside {project_dir} and the libraries its lib tables point to.
- Don't commit, push, publish, or upload anything, and don't contact any outside service unless the
  human asked for it in a comment.
- If something is ambiguous or risky (removing parts, changing the board outline, replacing a part
  with a different footprint), ask with \`--open\` instead of guessing.
- Keep replies short and concrete: refs, nets, values, before -> after.`;

export interface AgentConfig {
  /** argv; {prompt} and {project_dir} are substituted. */
  command: string[];
  /** Appended to the default prompt (your instructions, kept in your workspace, not in kretsa). */
  prompt_extra?: string;
  /** Replaces the default prompt entirely. */
  prompt?: string;
  /** Send to AI starts the agent when none is listening (default true). */
  auto_start?: boolean;
  /** How long the agent keeps listening after its last comment before it exits (default 900 s). */
  idle_seconds?: number;
}

/** Split a command line like a shell would for the common cases (quotes, backslash escapes; no expansion). */
export function splitCommand(s: string): string[] {
  const out: string[] = [];
  let cur = "", q: string | null = null, any = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (q) {
      if (c === q) q = null;
      else if (c === "\\" && q === '"' && i + 1 < s.length) cur += s[++i];
      else cur += c;
    } else if (c === "'" || c === '"') { q = c; any = true; }
    else if (c === "\\" && i + 1 < s.length) { cur += s[++i]; any = true; }
    else if (/\s/.test(c)) { if (cur || any) out.push(cur); cur = ""; any = false; }
    else { cur += c; any = true; }
  }
  if (cur || any) out.push(cur);
  return out;
}

/** The agent config: the serve flag wins over `<workspace>/.kretsa/config.json`. Null = feature off. */
export function readAgentConfig(workspaceRoot: string, flag?: string): AgentConfig | null {
  let file: Partial<AgentConfig> = {};
  const p = join(workspaceRoot, ".kretsa", "config.json");
  if (existsSync(p)) {
    try { file = (JSON.parse(readFileSync(p, "utf8")).agent ?? {}) as Partial<AgentConfig>; }
    catch (e) { throw new Error(`can't parse ${p}: ${(e as Error).message}`); }
  }
  const command = flag ? splitCommand(flag) : typeof file.command === "string" ? splitCommand(file.command) : file.command;
  if (!Array.isArray(command) || !command.length) return null;
  return { ...file, command: command.map(String) };
}

export function agentPrompt(cfg: AgentConfig, projectDir: string): string {
  const base = cfg.prompt ?? DEFAULT_AGENT_PROMPT;
  const text = cfg.prompt_extra ? `${base}\n\nAlso:\n${cfg.prompt_extra}` : base;
  return text
    .replaceAll("{project_dir}", projectDir)
    .replaceAll("{review_doc}", join(ROOT, "docs", "review-format.md"))
    .replaceAll("{idle_seconds}", String(cfg.idle_seconds ?? 900));
}

/** A `kretsa` on PATH for the agent: the real one if installed, else a shim running this checkout's CLI. */
function kretsaPath(): string | null {
  if (Bun.which("kretsa")) return null;
  const dir = join(tmpdir(), `kretsa-bin-${process.getuid?.() ?? "u"}`);
  mkdirSync(dir, { recursive: true });
  const shim = join(dir, "kretsa");
  writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${join(ROOT, "cli/src/main.ts")}" "$@"\n`);
  chmodSync(shim, 0o755);
  return dir;
}

/**
 * Turn one line of agent output into something readable. Claude Code's `--output-format stream-json`
 * events become "text" / "tool: input" lines; anything else is passed through.
 */
export function formatAgentLine(line: string): string | null {
  const t = line.trim();
  if (!t.startsWith("{")) return line;
  let e: any;
  try { e = JSON.parse(t); } catch { return line; }
  const short = (s: unknown, n = 300) => { const x = String(s ?? "").replace(/\s+/g, " ").trim(); return x.length > n ? x.slice(0, n) + "…" : x; };
  if (e.type === "system" && e.subtype === "init") return `· session ${String(e.session_id ?? "").slice(0, 8)} (${e.model ?? "?"})`;
  if (e.type === "assistant") {
    const parts: string[] = [];
    for (const c of e.message?.content ?? []) {
      if (c.type === "text" && c.text?.trim()) parts.push(c.text.trim());
      else if (c.type === "tool_use") {
        const i = c.input ?? {};
        const arg = i.command ?? i.file_path ?? i.path ?? i.pattern ?? i.url ?? i.description ?? (Object.keys(i).length ? JSON.stringify(i) : "");
        parts.push(`▸ ${c.name}${arg ? ": " + short(arg, 200) : ""}`);
      }
    }
    return parts.length ? parts.join("\n") : null;
  }
  if (e.type === "user") {
    const r = (e.message?.content ?? []).find((c: any) => c.type === "tool_result");
    if (!r?.is_error) return null;
    const txt = Array.isArray(r.content) ? r.content.map((x: any) => x.text ?? "").join(" ") : r.content;
    return `  ✗ ${short(txt, 200)}`;
  }
  if (e.type === "result") {
    const cost = typeof e.total_cost_usd === "number" ? `, $${e.total_cost_usd.toFixed(2)}` : "";
    return `· ${e.subtype === "success" ? "finished" : e.subtype ?? "ended"} (${e.num_turns ?? "?"} turns${cost})${e.is_error && e.result ? ": " + short(e.result) : ""}`;
  }
  return null;
}

/** One agent process at a time, started by the server for the viewer. */
export class AgentRunner {
  private proc: ReturnType<typeof Bun.spawn> | null = null;
  private lines: string[] = [];
  private offset = 0; // number of lines dropped from the front
  private info: Omit<AgentRun, "available" | "lines"> = { running: false };
  constructor(private onChange: (ev: { lines?: string[]; status?: boolean }) => void) {}

  status(available: boolean): AgentRun {
    return { available, ...this.info, lines: this.offset + this.lines.length };
  }

  /** Log lines from index `since` (as counted by status().lines). */
  log(since = 0): { from: number; lines: string[] } {
    const from = Math.max(since, this.offset);
    return { from, lines: this.lines.slice(from - this.offset) };
  }

  private push(text: string, logFile?: string) {
    const add = text.split("\n");
    this.lines.push(...add);
    if (this.lines.length > 3000) { const drop = this.lines.length - 3000; this.lines.splice(0, drop); this.offset += drop; }
    if (logFile) try { appendFileSync(logFile, text + "\n"); } catch {}
    this.onChange({ lines: add });
  }

  start(cfg: AgentConfig, projectDir: string, workspaceRoot: string, reason: string): AgentRun {
    if (this.proc) return this.status(true);
    const prompt = agentPrompt(cfg, projectDir);
    const argv = cfg.command.map((a) => a.replaceAll("{prompt}", prompt).replaceAll("{project_dir}", projectDir));
    const shown = cfg.command.map((a) => (a.includes("{prompt}") ? a.replaceAll("{prompt}", "<prompt>") : a)).join(" ");
    const logFile = join(projectDir, ".kretsa", "agent-run.log");
    mkdirSync(join(projectDir, ".kretsa"), { recursive: true });
    const extra = kretsaPath();
    const env = { ...process.env, KRETSA_PROJECT: projectDir, KRETSA_WORKSPACE: workspaceRoot, ...(extra ? { PATH: `${extra}:${process.env.PATH ?? ""}` } : {}) };
    const started = new Date().toISOString();
    this.push(`\n=== ${new Date(started).toLocaleString()} · ${reason} · ${shown}`, logFile);
    let proc: ReturnType<typeof Bun.spawn>;
    try {
      // Own process group, so Stop also ends what the agent started (e.g. its background `kretsa wait`).
      proc = Bun.spawn(argv, { cwd: projectDir, env, stdin: "ignore", stdout: "pipe", stderr: "pipe", detached: true } as Parameters<typeof Bun.spawn>[1]);
    } catch (e) {
      this.push(`✗ could not start: ${(e as Error).message}`, logFile);
      this.info = { running: false, exitCode: -1, ended: new Date().toISOString(), command: shown };
      this.onChange({ status: true });
      return this.status(true);
    }
    this.proc = proc;
    this.info = { running: true, pid: proc.pid, started, command: shown };
    this.onChange({ status: true });
    const pump = async (stream: ReadableStream<Uint8Array>, err: boolean) => {
      const dec = new TextDecoder();
      let buf = "";
      for await (const chunk of stream) {
        buf += dec.decode(chunk, { stream: true });
        let i: number;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i);
          buf = buf.slice(i + 1);
          const f = err ? (line.trim() ? `! ${line}` : null) : formatAgentLine(line);
          if (f) this.push(f, logFile);
        }
      }
      if (buf.trim()) { const f = err ? `! ${buf}` : formatAgentLine(buf); if (f) this.push(f, logFile); }
    };
    Promise.all([pump(proc.stdout as ReadableStream<Uint8Array>, false), pump(proc.stderr as ReadableStream<Uint8Array>, true)])
      .catch(() => {})
      .then(() => proc.exited)
      .then((code) => {
        this.proc = null;
        this.info = { running: false, exitCode: code, started, ended: new Date().toISOString(), command: shown };
        this.push(`=== agent exited (code ${code})`, logFile);
        this.onChange({ status: true });
      });
    return this.status(true);
  }

  stop(): boolean {
    if (!this.proc) return false;
    this.push("=== stopping (SIGTERM)");
    const p = this.proc;
    signalGroup(p, "SIGTERM");
    setTimeout(() => { if (this.proc === p) signalGroup(p, "SIGKILL"); }, 5000);
    return true;
  }

  /** Server shutting down: don't leave the agent orphaned. */
  kill() { if (this.proc) signalGroup(this.proc, "SIGTERM"); }
}

function signalGroup(p: { pid: number; kill(sig?: any): void }, sig: "SIGTERM" | "SIGKILL") {
  try { process.kill(-p.pid, sig); } catch { try { p.kill(sig); } catch {} }
}
