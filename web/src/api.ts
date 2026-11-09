import type { CheckReport } from "../../shared/check";
import type { Netlist } from "../../shared/netlist";
import type { WorkspaceInfo } from "../../shared/workspace";
export interface ServerComponent { ref: string; value: string; footprint: string; lib?: string; layer?: string; props: [string, string][] }
import type { AgentStatus, Comment, CommentPatch, NewComment, ProjectInfo, Review, ServerMessage } from "../../shared/review";

async function req<T>(method: string, url: string, body?: unknown): Promise<T> {
  const r = await fetch(url, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(`${method} ${url}: ${r.status} ${await r.text()}`);
  return r.json() as Promise<T>;
}

export const api = {
  project: () => req<ProjectInfo>("GET", "/api/project"),
  review: () => req<Review>("GET", "/api/review"),
  netlist: () => req<Netlist>("GET", "/api/netlist"),
  check: () => req<CheckReport>("GET", "/api/check"),
  workspace: () => req<WorkspaceInfo>("GET", "/api/workspace"),
  setProject: (id: string) => req<{ current: string }>("POST", "/api/workspace/current", { id }),
  addComment: (c: NewComment) => req<Comment>("POST", "/api/review/comments", c),
  patchComment: (id: string, p: CommentPatch) => req<Comment>("PATCH", `/api/review/comments/${id}`, p),
  /** "Send to AI": hand drafts to the agent (all, or `ids`). */
  deleteComment: (id: string) => req<{ deleted: string }>("DELETE", `/api/review/comments/${id}`),
  agent: () => req<AgentStatus>("GET", "/api/agent"),
  send: (ids?: string[]) => req<{ sent: string[] }>("POST", "/api/review/send", ids ? { ids } : {}),
  /** Components parsed server-side from the files (for views without a KiCanvas pane, e.g. 3D only). */
  components: () => req<ServerComponent[]>("GET", "/api/components"),
};

/** Auto-reconnecting WebSocket to the server's change feed. */
export function connect(onMessage: (m: ServerMessage) => void, onStatus: (up: boolean) => void) {
  const open = () => {
    const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
    ws.onopen = () => onStatus(true);
    ws.onmessage = (e) => onMessage(JSON.parse(e.data));
    ws.onclose = () => { onStatus(false); setTimeout(open, 1000); };
  };
  open();
}
