import type { Anchor, Comment, ProjectInfo, Review, View } from "../../shared/review";
import { api, connect } from "./api";
import { mountKiCanvas, onKiCanvasSelect } from "./kicanvas-view";
import type { ThreeView } from "./three-view";

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

const state = {
  project: null as ProjectInfo | null,
  review: { version: 1, comments: [] } as Review,
  view: (location.hash.slice(1) as View) || "sch",
  draftAnchors: [] as Anchor[],
  three: null as ThreeView | null,
  wsUp: false,
};

// ---------- viewer ----------

async function showView(view: View) {
  state.view = view;
  history.replaceState(null, "", `#${view}`);
  document.querySelectorAll<HTMLButtonElement>("#tabs button").forEach((b) =>
    b.classList.toggle("active", b.dataset.view === view),
  );
  state.three?.dispose();
  state.three = null;
  const host = $("#viewer");
  if (!state.project) return;
  if (view === "3d") {
    const { mountThree } = await import("./three-view"); // three.js is big; load on demand
    state.three = await mountThree(host, state.project.rev, addAnchor);
  }
  else await mountKiCanvas(host, state.project, view);
}

function currentFile(): string | undefined {
  const kind = state.view === "3d" ? "pcb" : state.view;
  return state.project?.files.find((f) => f.kind === kind)?.path;
}

// ---------- anchors (draft) ----------

const anchorLabel = (a: Anchor): string =>
  a.kind === "symbol" ? a.ref
  : a.kind === "net" ? `net:${a.name}`
  : a.kind === "pad" ? `${a.ref}.${a.pad}`
  : a.kind === "point" ? `@${a.at_mm.map((n) => n.toFixed(1)).join(",")}`
  : `area`;

function addAnchor(a: Anchor) {
  const key = anchorLabel(a);
  if (!state.draftAnchors.some((x) => anchorLabel(x) === key)) state.draftAnchors.push(a);
  renderDraftAnchors();
}

function renderDraftAnchors() {
  const host = $("#anchors");
  host.replaceChildren(
    ...state.draftAnchors.map((a, i) => {
      const chip = document.createElement("span");
      chip.className = "chip";
      chip.textContent = anchorLabel(a);
      chip.title = "click to remove";
      chip.onclick = () => { state.draftAnchors.splice(i, 1); renderDraftAnchors(); };
      return chip;
    }),
  );
}

/** "U3, C12, net:VBUS, U3.4" -> anchors */
function parseExtraAnchors(s: string): Anchor[] {
  return s.split(/[,\s]+/).filter(Boolean).map((tok): Anchor => {
    if (tok.startsWith("net:")) return { kind: "net", name: tok.slice(4) };
    const pad = tok.match(/^([A-Za-z]+\d+)\.(\w+)$/);
    if (pad) return { kind: "pad", ref: pad[1]!, pad: pad[2]! };
    return { kind: "symbol", ref: tok };
  });
}

// ---------- comments ----------

async function submitComment(form: HTMLFormElement) {
  const data = new FormData(form);
  const text = String(data.get("text") ?? "").trim();
  if (!text) return;
  const anchors = [...state.draftAnchors, ...parseExtraAnchors(String(data.get("extra") ?? ""))];
  await api.addComment({
    view: state.view,
    file: currentFile(),
    anchors,
    text,
    // TODO: 2D snapshots (KiCanvas canvas lives in shadow DOM, needs preserveDrawingBuffer or a re-render)
    snapshotPng: state.three?.snapshot(),
  });
  form.reset();
  state.draftAnchors = [];
  renderDraftAnchors();
  await refreshReview();
}

async function refreshReview() {
  state.review = await api.review();
  renderComments();
}

function renderComments() {
  const showClosed = $<HTMLInputElement>("#show-closed").checked;
  const list = $("#comment-list");
  const items = state.review.comments
    .filter((c) => showClosed || c.status === "open" || c.status === "addressed")
    .slice()
    .reverse();
  list.replaceChildren(...items.map(renderComment));
}

function renderComment(c: Comment): HTMLLIElement {
  const li = document.createElement("li");
  const stale = state.project && c.design_rev !== state.project.rev;
  li.innerHTML = `
    <div class="meta">
      <span class="badge ${c.status}">${c.status}</span>
      <span>${c.view}</span>
      <span>${c.anchors.map(anchorLabel).join(" ")}</span>
      <span title="design changed since this comment">${stale ? "· design changed" : ""}</span>
    </div>
    <div class="text"></div>
    <div class="thread"></div>
    <div class="actions"></div>`;
  li.querySelector(".text")!.textContent = c.text;
  const thread = li.querySelector(".thread")!;
  for (const t of c.thread) {
    const p = document.createElement("div");
    p.className = t.author;
    p.textContent = `${t.author}: ${t.text}`;
    thread.appendChild(p);
  }
  if (!c.thread.length) thread.remove();
  if (c.snapshot) {
    const img = document.createElement("img");
    img.src = `/wiber/${c.snapshot}`;
    li.appendChild(img);
  }
  const actions = li.querySelector(".actions")!;
  const btn = (label: string, fn: () => Promise<unknown>, ghost = true) => {
    const b = document.createElement("button");
    b.textContent = label;
    if (ghost) b.className = "ghost";
    b.onclick = async () => { await fn(); await refreshReview(); };
    actions.appendChild(b);
  };
  if (c.status !== "resolved") btn("Resolve", () => api.patchComment(c.id, { status: "resolved" }));
  if (c.status !== "open") btn("Reopen", () => api.patchComment(c.id, { status: "open" }));
  btn("Reply", async () => {
    const text = prompt("Reply"); // TODO: inline reply box
    if (text) await api.patchComment(c.id, { reply: { author: "human", text } });
  });
  return li;
}

// ---------- status / boot ----------

function renderStatus() {
  const p = state.project;
  $("#status").textContent = [
    state.wsUp ? "● live" : "○ disconnected",
    p ? `rev ${p.rev.slice(0, 7)}` : "",
    p?.kicadCli ? `kicad-cli ${p.kicadCli}` : "no kicad-cli (3D off)",
  ].filter(Boolean).join("  ·  ");
}

async function boot() {
  state.project = await api.project();
  $("#project-name").textContent = state.project.name;
  document.title = `${state.project.name} · kicad-wiber`;
  renderStatus();

  document.querySelectorAll<HTMLButtonElement>("#tabs button").forEach((b) =>
    (b.onclick = () => showView(b.dataset.view as View)),
  );
  const form = $<HTMLFormElement>("#new-comment");
  form.onsubmit = (e) => { e.preventDefault(); submitComment(form); };
  form.text.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submitComment(form); }
  });
  $("#show-closed").onchange = renderComments;
  onKiCanvasSelect(addAnchor);

  connect(
    async (msg) => {
      if (msg.type === "review") return refreshReview();
      state.project = await api.project();
      renderStatus();
      const kind = state.view === "3d" ? "pcb" : state.view;
      const relevant = msg.changed.length === 0 ||
        state.project.files.some((f) => msg.changed.includes(f.path) && (f.kind === kind || f.kind === "pro"));
      // TODO: preserve KiCanvas pan/zoom across reloads
      if (relevant) await showView(state.view);
      renderComments();
    },
    (up) => { state.wsUp = up; renderStatus(); },
  );

  await Promise.all([showView(state.view), refreshReview()]);
}

boot().catch((e) => {
  $("#viewer").innerHTML = `<div class="notice">Failed to start: ${e}</div>`;
});
