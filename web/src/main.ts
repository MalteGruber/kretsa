import type { Anchor, Comment, ProjectInfo, Review, View } from "../../shared/review";
import { api, connect } from "./api";
import { itemToAnchor, itemToComponent, KiCanvasView, type Component } from "./kicanvas-view";
import type { ThreeView } from "./three-view";

const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector<T>(sel)!;
const $$ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => [...root.querySelectorAll<T>(sel)];
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** UI layout: a single view, or schematic + PCB side by side. */
type Mode = View | "split";
const MODES: Mode[] = ["sch", "pcb", "3d", "split"];
const LABEL: Record<View, string> = { sch: "Schematic", pcb: "PCB", "3d": "3D" };

/** One viewer pane. Split mode has two, which cross-probe each other. */
interface Pane {
  kind: View;
  el: HTMLElement;
  viewer: HTMLElement;
  pins: HTMLElement;
  catcher: HTMLElement;
  coords: HTMLElement;
  layerbar: HTMLElement;
  kc: KiCanvasView | null;
  three: ThreeView | null;
  pinEls: Map<string, HTMLElement>;
}

const state = {
  project: null as ProjectInfo | null,
  review: { version: 1, comments: [] } as Review,
  mode: (MODES.includes(location.hash.slice(1) as Mode) ? location.hash.slice(1) : "sch") as Mode,
  panes: [] as Pane[],
  focus: null as Pane | null,
  /** Cross-probe selection, shared by all panes and preserved across view switches. */
  selectedRef: null as string | null,
  selected: null as Component | null,
  /** Component data per document kind, so 3D picks can show schematic/PCB properties. */
  comps: {} as Partial<Record<"sch" | "pcb", Component[]>>,
  draftAnchors: [] as Anchor[],
  draftPoint: null as { kind: View; at: [number, number] } | null,
  commentMode: false,
  activeComment: null as string | null,
  filter: "active" as "active" | "all",
  wsUp: false,
  mountSeq: 0,
};

// =====================================================================================
// Panes / modes
// =====================================================================================

function createPane(kind: View): Pane {
  const el = document.createElement("div");
  el.className = `stage${kind !== "sch" ? " dark" : ""}${kind === "pcb" ? " has-layerbar" : ""}`;
  el.dataset.kind = kind;
  el.innerHTML = `
    <div class="viewer"></div>
    <div class="pins"></div>
    <div class="catcher" hidden></div>
    <div class="coords"></div>
    <div class="pane-label">${LABEL[kind]}</div>
    <div class="layerbar" ${kind === "pcb" ? "" : "hidden"}></div>`;
  const pane: Pane = {
    kind, el,
    viewer: $(".viewer", el), pins: $(".pins", el), catcher: $(".catcher", el),
    coords: $(".coords", el), layerbar: $(".layerbar", el),
    kc: null, three: null, pinEls: new Map(),
  };
  el.addEventListener("pointerdown", () => setFocus(pane), true);
  el.addEventListener("pointermove", (e) => {
    const r = pane.viewer.getBoundingClientRect();
    const w = pane.kc?.screenToWorld(e.clientX - r.left, e.clientY - r.top);
    pane.coords.textContent = w ? `X ${w[0].toFixed(2)}  Y ${w[1].toFixed(2)} mm` : "";
  });
  el.addEventListener("pointerleave", () => (pane.coords.textContent = ""));
  pane.catcher.addEventListener("click", (e) => {
    const r = pane.viewer.getBoundingClientRect();
    const w = pane.kc?.screenToWorld(e.clientX - r.left, e.clientY - r.top);
    setCommentMode(false);
    if (!w) return;
    state.draftPoint = { kind: pane.kind, at: w };
    addAnchor({ kind: "point", at_mm: w });
    focusComposer();
  });
  return pane;
}

function setFocus(pane: Pane | null) {
  if (state.focus === pane) return;
  state.focus = pane;
  for (const p of state.panes) p.el.classList.toggle("focused", p === pane);
  renderDocs();
  renderComponents();
}

type CamState = { x: number; y: number; zoom: number; page?: string };

async function showMode(mode: Mode, opts: { keepCamera?: boolean } = {}) {
  const seq = ++state.mountSeq;
  const saved = new Map<View, CamState>();
  if (opts.keepCamera) {
    for (const p of state.panes) {
      const cam = p.kc?.viewer?.viewport?.camera;
      if (cam) saved.set(p.kind, { x: cam.center.x, y: cam.center.y, zoom: cam.zoom, page: p.kc!.pages().find((g) => g.active)?.path });
    }
  }
  const prevFocusKind = state.focus?.kind;

  state.mode = mode;
  history.replaceState(null, "", `#${mode}`);
  $$("#tabs button").forEach((b) => b.classList.toggle("active", b.dataset.view === mode));
  setCommentMode(false);
  for (const p of state.panes) { p.three?.dispose(); p.el.remove(); }

  const kinds: View[] = mode === "split" ? ["sch", "pcb"] : [mode];
  state.panes = kinds.map(createPane);
  const stages = $("#stages");
  stages.classList.toggle("split", mode === "split");
  stages.classList.toggle("has-layerbar", kinds.includes("pcb"));
  for (const p of state.panes) stages.insertBefore(p.el, $("#toolbar"));
  state.focus = null;
  setFocus(state.panes.find((p) => p.kind === prevFocusKind) ?? state.panes[0]!);

  await Promise.all(state.panes.map((p) => mountPane(p, seq, saved.get(p.kind))));
  if (seq !== state.mountSeq) return;
  renderDocs();
  renderComponents();
  renderProps();
}

async function mountPane(pane: Pane, seq: number, saved?: CamState) {
  if (!state.project) return;
  if (pane.kind === "3d") {
    const { mountThree } = await import("./three-view"); // three.js is big; load on demand
    const tv = await mountThree(pane.viewer, state.project.rev, (a) => onThreePick(pane, a));
    if (seq !== state.mountSeq) return tv?.dispose();
    pane.three = tv;
    if (state.selectedRef) tv?.highlight(state.selectedRef, !saved);
    return;
  }
  const kc = new KiCanvasView(pane.viewer, pane.kind);
  kc.onSelect = (item) => onKiCanvasSelect(pane, item);
  pane.kc = kc;
  if (!(await kc.mount(state.project)) || seq !== state.mountSeq) return;
  if (saved?.page) { kc.setPage(saved.page); await kc.waitViewer(); }
  // Let KiCanvas finish its own initial zoom before we restore/apply ours.
  await new Promise((r) => setTimeout(r, 150));
  if (seq !== state.mountSeq) return;
  state.comps[pane.kind as "sch" | "pcb"] = kc.components();
  if (saved) restoreCamera(pane, saved);
  if (state.selectedRef) await kc.selectRef(state.selectedRef, !saved);
  renderLayers(pane);
}

function restoreCamera(pane: Pane, c: CamState) {
  const v = pane.kc?.viewer;
  const cam = v?.viewport?.camera;
  if (!cam) return;
  cam.center.set(c.x, c.y);
  cam.zoom = c.zoom;
  v.draw();
}

const paneOf = (kind: View) => state.panes.find((p) => p.kind === kind);
const focusKind = (): View => state.focus?.kind ?? state.panes[0]?.kind ?? "sch";

function fileOf(pane: Pane | null | undefined): string | undefined {
  if (!pane) return undefined;
  const kind = pane.kind === "3d" ? "pcb" : pane.kind;
  if (kind === "sch") {
    const page = pane.kc?.pages().find((p) => p.active);
    if (page) return page.path.split(":")[0];
  }
  return state.project?.files.find((f) => f.kind === kind)?.path;
}
const sheetOf = (pane: Pane | null | undefined) =>
  pane?.kind === "sch" ? pane.kc?.pages().find((p) => p.active)?.path : undefined;

// =====================================================================================
// Selection + cross-probing
// =====================================================================================

/** Fill in fields missing from one source (e.g. a 3D pick) using schematic + PCB data. */
function enrich(ref: string, base?: Component | null): Component {
  const sch = state.comps.sch?.find((c) => c.ref === ref);
  const pcb = state.comps.pcb?.find((c) => c.ref === ref);
  const b = base ?? sch ?? pcb ?? { ref, value: "", footprint: "", props: [] };
  return {
    ...b,
    value: b.value || sch?.value || pcb?.value || "",
    footprint: b.footprint || sch?.footprint || pcb?.footprint || "",
    lib: b.lib ?? sch?.lib,
    layer: b.layer ?? pcb?.layer,
    props: b.props.length ? b.props : sch?.props ?? pcb?.props ?? [],
  };
}

/**
 * Select `ref` everywhere. `origin` is the pane where the user clicked (it already shows the selection).
 * Other panes select it too, and zoom to it in split mode (that's the point of cross-probing).
 */
async function selectRef(ref: string | null, opts: { origin?: Pane; zoom?: boolean; base?: Component | null } = {}) {
  state.selectedRef = ref;
  state.selected = ref ? enrich(ref, opts.base) : null;
  renderProps();
  renderComponents();
  if (ref) showRightTab("props");
  const zoom = opts.zoom ?? state.mode === "split";
  await Promise.all(state.panes.filter((p) => p !== opts.origin).map(async (p) => {
    if (p.kc) await p.kc.selectRef(ref, zoom);
    p.three?.highlight(ref, zoom);
  }));
}

function onKiCanvasSelect(pane: Pane, item: any) {
  const comp = itemToComponent(item);
  // Composing a comment? Clicking parts/nets attaches them as anchors.
  const composing = document.activeElement === $("#composer textarea") || $<HTMLTextAreaElement>("#composer textarea").value.trim();
  const a = itemToAnchor(item);
  if (a && composing && a.kind !== "point") addAnchor(a);

  if (comp?.isNet) {
    state.selected = comp;
    renderProps();
    showRightTab("props");
    return;
  }
  const ref = comp?.ref ?? null;
  // Programmatic selects (from cross-probing) echo back here with the same ref: don't re-broadcast.
  if (ref === state.selectedRef) return;
  setFocus(pane);
  // Defer: we're inside KiCanvas' select() call stack, which is guarded by a @no_self_recursion
  // decorator that is shared across viewer instances, so selecting in the other pane now is dropped.
  setTimeout(() => selectRef(ref, { origin: pane, base: comp }), 0);
}

function onThreePick(pane: Pane, a: Anchor | null) {
  const ref = a?.kind === "symbol" ? a.ref : null;
  if (state.commentMode) {
    if (a) addAnchor(a);
    setCommentMode(false);
    focusComposer();
  }
  pane.three?.highlight(ref);
  if (ref !== state.selectedRef) selectRef(ref, { origin: pane });
}

// ---------- comment mode (click on canvas to drop a pin) ----------

function setCommentMode(on: boolean) {
  state.commentMode = on;
  $("#toolbar [data-act=comment]").classList.toggle("active", on);
  // 2D: an overlay captures the click; 3D: the three view's own pick handler is used.
  for (const p of state.panes) p.catcher.hidden = !on || p.kind === "3d";
}

function focusComposer() {
  showRightTab("comments");
  $("#right").hidden = false;
  $<HTMLTextAreaElement>("#composer textarea").focus();
}

// =====================================================================================
// Pins overlay (follows the KiCanvas camera)
// =====================================================================================

function commentNumber(c: Comment) { return state.review.comments.indexOf(c) + 1; }

function anchorWorldPos(pane: Pane, c: Comment): [number, number] | null {
  for (const a of c.anchors) {
    if (a.kind === "point") return a.at_mm;
    if (a.kind === "area") return [(a.bbox_mm[0] + a.bbox_mm[2]) / 2, (a.bbox_mm[1] + a.bbox_mm[3]) / 2];
  }
  for (const a of c.anchors) {
    if (a.kind === "symbol" || a.kind === "pad") {
      const p = pane.kc?.positionOf(a.ref);
      if (p) return p;
    }
  }
  return null;
}

function commentInPane(pane: Pane, c: Comment) {
  if (c.view !== pane.kind) return false;
  if (pane.kind === "sch") {
    const sheet = sheetOf(pane);
    return !c.sheet || !sheet || c.sheet === sheet;
  }
  return !c.file || c.file === fileOf(pane);
}

function visibleComments(): Comment[] {
  return state.review.comments.filter((c) => state.filter === "all" || c.status === "open" || c.status === "addressed");
}

function updatePins() {
  requestAnimationFrame(updatePins);
  for (const pane of state.panes) updatePanePins(pane);
}

function updatePanePins(pane: Pane) {
  const kc = pane.kc;
  if (!kc?.viewer) { if (pane.pinEls.size) { pane.pins.replaceChildren(); pane.pinEls.clear(); } return; }
  const want = new Set<string>();
  const w = pane.pins.clientWidth, h = pane.pins.clientHeight;
  const place = (key: string, pos: [number, number] | null, make: () => HTMLElement) => {
    const s = pos && kc.worldToScreen(pos[0], pos[1]);
    if (!s || s[0] < -30 || s[1] < -30 || s[0] > w + 30 || s[1] > h + 30) return null;
    want.add(key);
    let el = pane.pinEls.get(key);
    if (!el) { el = make(); pane.pinEls.set(key, el); pane.pins.appendChild(el); }
    el.style.left = `${s[0]}px`;
    el.style.top = `${s[1]}px`;
    return el;
  };
  for (const c of visibleComments()) {
    if (!commentInPane(pane, c)) continue;
    const el = place(c.id, anchorWorldPos(pane, c), () => {
      const e = document.createElement("div");
      e.onclick = () => activateComment(c.id, { fromPin: true });
      return e;
    });
    if (el) {
      el.className = `pin ${c.status}${state.activeComment === c.id ? " active" : ""}`;
      el.textContent = String(commentNumber(c));
      el.title = c.text;
    }
  }
  if (state.draftPoint?.kind === pane.kind) {
    place("__draft", state.draftPoint.at, () => {
      const e = document.createElement("div");
      e.className = "pin draft";
      e.textContent = "+";
      return e;
    });
  }
  for (const [k, el] of pane.pinEls) if (!want.has(k)) { el.remove(); pane.pinEls.delete(k); }
}

function activateComment(id: string, opts: { fromPin?: boolean } = {}) {
  state.activeComment = state.activeComment === id && !opts.fromPin ? null : id;
  renderComments();
  const c = state.review.comments.find((x) => x.id === id);
  if (!c || state.activeComment !== id) return;
  if (opts.fromPin) {
    showRightTab("comments");
    $("#right").hidden = false;
    document.querySelector(`[data-cid="${id}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    return;
  }
  // From the list: navigate to the comment's view and anchor.
  (async () => {
    if (!paneOf(c.view)) await showMode(c.view);
    const pane = paneOf(c.view)!;
    setFocus(pane);
    if (c.sheet && pane.kc && sheetOf(pane) !== c.sheet) { pane.kc.setPage(c.sheet); await pane.kc.waitViewer(); }
    const sym = c.anchors.find((a) => a.kind === "symbol" || a.kind === "pad") as { ref: string } | undefined;
    if (sym) {
      await selectRef(sym.ref, { zoom: true });
      return;
    }
    const p = anchorWorldPos(pane, c);
    if (p) pane.kc?.centerOn(p[0], p[1]);
  })();
}

// =====================================================================================
// Draft anchors / composer
// =====================================================================================

const anchorLabel = (a: Anchor): string =>
  a.kind === "symbol" ? a.ref
  : a.kind === "net" ? `net ${a.name}`
  : a.kind === "pad" ? `${a.ref}.${a.pad}`
  : a.kind === "point" ? `@ ${a.at_mm.map((n) => n.toFixed(1)).join(", ")} mm`
  : "area";

function addAnchor(a: Anchor) {
  const key = anchorLabel(a);
  if (a.kind === "point") state.draftAnchors = state.draftAnchors.filter((x) => x.kind !== "point");
  if (!state.draftAnchors.some((x) => anchorLabel(x) === key)) state.draftAnchors.push(a);
  renderDraftAnchors();
}

function renderDraftAnchors() {
  $("#anchors").replaceChildren(
    ...state.draftAnchors.map((a, i) => {
      const chip = document.createElement("span");
      chip.className = "chip";
      chip.textContent = anchorLabel(a);
      chip.title = "Remove";
      chip.onclick = () => {
        if (a.kind === "point") state.draftPoint = null;
        state.draftAnchors.splice(i, 1);
        renderDraftAnchors();
      };
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

async function submitComment(form: HTMLFormElement) {
  const data = new FormData(form);
  const text = String(data.get("text") ?? "").trim();
  if (!text) return;
  const anchors = [...state.draftAnchors, ...parseExtraAnchors(String(data.get("extra") ?? ""))];
  // A dropped pin decides which pane the comment belongs to; otherwise the focused pane.
  const pane = (state.draftPoint && paneOf(state.draftPoint.kind)) || state.focus;
  const c = await api.addComment({
    view: pane?.kind ?? focusKind(),
    file: fileOf(pane),
    sheet: sheetOf(pane),
    anchors,
    text,
    // TODO: 2D snapshots (KiCanvas canvas lives in shadow DOM, needs preserveDrawingBuffer or a re-render)
    snapshotPng: pane?.three?.snapshot(),
  });
  form.reset();
  state.draftAnchors = [];
  state.draftPoint = null;
  renderDraftAnchors();
  state.activeComment = c.id;
  await refreshReview();
}

// =====================================================================================
// Right panel: comments + properties
// =====================================================================================

function showRightTab(tab: "comments" | "props") {
  $$("[data-rtab]").forEach((b) => b.classList.toggle("active", b.dataset.rtab === tab));
  $$("[data-rpane]").forEach((p) => (p.hidden = p.dataset.rpane !== tab));
}

async function refreshReview() {
  state.review = await api.review();
  renderComments();
}

function ago(iso: string): string {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
}

function renderComments() {
  const open = state.review.comments.filter((c) => c.status === "open").length;
  $("#comment-count").textContent = open ? String(open) : "";
  $("#comment-list").replaceChildren(...visibleComments().slice().reverse().map(renderComment));
}

function renderComment(c: Comment): HTMLLIElement {
  const li = document.createElement("li");
  const closed = c.status === "resolved" || c.status === "wontfix";
  li.className = `card${state.activeComment === c.id ? " active" : ""}${closed ? " closed" : ""}`;
  li.dataset.cid = c.id;
  const stale = state.project && c.design_rev !== state.project.rev && c.status === "open";
  li.innerHTML = `
    <div class="chead">
      <span class="avatar">You</span>
      <span class="who">You</span>
      <span class="when">${esc(ago(c.created))} · ${c.view.toUpperCase()}</span>
      <span class="num">#${commentNumber(c)}</span>
      <span class="status-pill ${c.status}">${c.status}</span>
    </div>
    <div class="ctext">${esc(c.text)}</div>
    ${c.anchors.length ? `<div class="canchors">${c.anchors.map((a) => `<span class="tag">${esc(anchorLabel(a))}</span>`).join("")}</div>` : ""}
    ${stale ? `<div class="stale">● design changed since this comment</div>` : ""}
    ${c.snapshot ? `<img src="/wiber/${esc(c.snapshot)}" alt="snapshot" />` : ""}
    ${c.thread.map((t) => `
      <div class="reply">
        <span class="avatar ${t.author}">${t.author === "ai" ? "AI" : "You"}</span>
        <div class="body"><span class="who">${t.author === "ai" ? "AI agent" : "You"}</span>
          <span class="when">${esc(ago(t.at))}</span><div class="ctext">${esc(t.text)}</div></div>
      </div>`).join("")}
    <div class="cactions"></div>`;
  li.onclick = (e) => {
    if ((e.target as HTMLElement).closest("button, input")) return;
    activateComment(c.id);
  };
  const actions = $(".cactions", li);
  const btn = (label: string, fn: () => unknown, cls = "") => {
    const b = document.createElement("button");
    b.textContent = label;
    b.className = cls;
    b.onclick = async () => { await fn(); };
    actions.appendChild(b);
  };
  const patch = async (p: Parameters<typeof api.patchComment>[1]) => { await api.patchComment(c.id, p); await refreshReview(); };
  btn("Reply", () => {
    if (li.querySelector(".replybox")) return;
    const box = document.createElement("div");
    box.className = "replybox";
    box.innerHTML = `<input placeholder="Reply…" /><button class="primary">Send</button>`;
    const input = $<HTMLInputElement>("input", box);
    const send = async () => { if (input.value.trim()) await patch({ reply: { author: "human", text: input.value.trim() } }); };
    $("button", box).onclick = send;
    input.onkeydown = (e) => { if (e.key === "Enter") send(); if (e.key === "Escape") box.remove(); };
    li.appendChild(box);
    input.focus();
  });
  if (!closed) btn("Resolve", () => patch({ status: "resolved" }), "ok");
  if (c.status !== "open") btn("Reopen", () => patch({ status: "open" }));
  return li;
}

function renderProps() {
  const host = $("#props");
  const s = state.selected;
  if (!s) {
    host.innerHTML = `<div class="empty">Select a component in the design<br/>to see its properties.</div>`;
    return;
  }
  if (s.isNet) {
    host.innerHTML = `<h3>${esc(s.ref)}</h3><div class="sub">Net (highlighted)</div>
      <div class="pactions"><button class="primary" data-pa="comment">Comment on net ${esc(s.ref)}</button></div>`;
    $("[data-pa=comment]", host).onclick = () => { addAnchor({ kind: "net", name: s.ref }); focusComposer(); };
    return;
  }
  const rows = ([
    ["Designator", s.ref],
    ["Value", s.value],
    ["Footprint", s.footprint],
    ["Library ID", s.lib ?? ""],
    ["Layer", s.layer ?? ""],
    ...s.props.filter(([k]) => !["Reference", "Value", "Footprint"].includes(k)),
  ] as [string, string][]).filter(([, v]) => v);
  host.innerHTML = `
    <h3>${esc(s.ref)}</h3>
    <div class="sub">${esc(s.value || "")}</div>
    <table>${rows.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join("")}</table>
    <div class="pactions">
      <button class="primary" data-pa="comment">Comment on ${esc(s.ref)}</button>
      <button class="secondary" data-pa="zoom">Zoom to</button>
    </div>`;
  $("[data-pa=comment]", host).onclick = () => {
    addAnchor({ kind: "symbol", ref: s.ref, uuid: s.uuid, value: s.value || undefined });
    focusComposer();
  };
  $("[data-pa=zoom]", host).onclick = () => selectRef(s.ref, { zoom: true, base: s });
}

// =====================================================================================
// Left panel: documents + components
// =====================================================================================

function renderDocs() {
  const p = state.project;
  if (!p) return;
  const list = $("#doc-list");
  const schPane = paneOf("sch");
  const pages = schPane?.kc?.pages() ?? [];
  const items: string[] = [`<li class="group">Schematic</li>`];
  if (pages.length) for (const pg of pages) items.push(docItem("sch", pg.path, pg.name, pg.active));
  else for (const f of p.files.filter((f) => f.kind === "sch")) items.push(docItem("sch", f.path, f.path, false));
  items.push(`<li class="group">Board</li>`);
  for (const f of p.files.filter((f) => f.kind === "pcb")) {
    items.push(docItem("pcb", f.path, f.path, !!paneOf("pcb")));
    items.push(docItem("3d", f.path, `${f.path} (3D)`, !!paneOf("3d")));
  }
  list.innerHTML = items.join("");
  $$<HTMLLIElement>("li[data-view]", list).forEach((li) => {
    li.onclick = async () => {
      const view = li.dataset.view as View;
      if (!paneOf(view)) await showMode(view);
      const pane = paneOf(view)!;
      setFocus(pane);
      if (view === "sch" && pane.kc) {
        const page = pane.kc.pages().find((pg) => pg.path === li.dataset.path || pg.path.split(":")[0] === li.dataset.path);
        if (page && !page.active) {
          pane.kc.setPage(page.path);
          await pane.kc.waitViewer();
          setTimeout(() => { state.comps.sch = pane.kc?.components() ?? state.comps.sch; renderDocs(); renderComponents(); }, 200);
        }
      }
    };
  });
}

function docItem(view: View, path: string, name: string, active: boolean) {
  const icon = view === "sch" ? "▤" : view === "pcb" ? "▦" : "◈";
  return `<li data-view="${view}" data-path="${esc(path)}" class="${active ? "active" : ""}"><span class="ico">${icon}</span><span>${esc(name)}</span></li>`;
}

function renderComponents() {
  const q = $<HTMLInputElement>("#comp-search").value.trim().toLowerCase();
  const kind = focusKind();
  const comps = (kind === "3d" ? state.comps.pcb ?? state.comps.sch : state.comps[kind]) ?? [];
  const items = comps.filter((c) => !q || `${c.ref} ${c.value} ${c.footprint}`.toLowerCase().includes(q));
  const list = $("#comp-list");
  list.innerHTML = items.length
    ? items.map((c) => `<li data-ref="${esc(c.ref)}" class="${state.selectedRef === c.ref ? "active" : ""}"><span class="ref">${esc(c.ref)}</span><span class="val">${esc(c.value)}</span></li>`).join("")
    : `<li class="group">${kind === "3d" ? "Open Schematic or PCB once to list components" : "No components"}</li>`;
  $$<HTMLLIElement>("li[data-ref]", list).forEach((li) => {
    li.onclick = () => selectRef(li.dataset.ref!, { zoom: true });
  });
}

// =====================================================================================
// PCB layer bar
// =====================================================================================

function renderLayers(pane: Pane) {
  if (pane.kind !== "pcb") return;
  const layers = pane.kc?.layers() ?? [];
  // Hide the noisy user/fab layers that are rarely relevant for review.
  const shown = layers.filter((l) => !/^User\.\d|Eco\d|Margin|Adhes/.test(l.name));
  pane.layerbar.innerHTML = shown
    .map((l) => `<button data-layer="${esc(l.name)}" class="${l.visible ? "" : "off"} ${l.highlighted ? "hl" : ""}" title="Click: focus layer · Right-click: show/hide">
      <span class="sw" style="background:${l.color}"></span>${esc(l.name)}</button>`)
    .join("");
  $$<HTMLButtonElement>("button", pane.layerbar).forEach((b) => {
    b.onclick = () => { pane.kc?.highlightLayer(b.dataset.layer!); renderLayers(pane); };
    b.oncontextmenu = (e) => { e.preventDefault(); pane.kc?.toggleLayer(b.dataset.layer!); renderLayers(pane); };
  });
}

// =====================================================================================
// Status / boot
// =====================================================================================

function renderStatus() {
  const p = state.project;
  $("#status").innerHTML = [
    state.wsUp ? `<span class="live">● Live</span>` : `<span class="dead">● Offline</span>`,
    p ? `rev ${p.rev.slice(0, 7)}` : "",
    p?.kicadCli ? `KiCad ${esc(p.kicadCli)}` : "no kicad-cli",
  ].filter(Boolean).join(" · ");
}

function bindUi() {
  $$("#tabs button").forEach((b) => (b.onclick = () => showMode(b.dataset.view as Mode)));
  $$("[data-ltab]").forEach((b) => (b.onclick = () => {
    $$("[data-ltab]").forEach((x) => x.classList.toggle("active", x === b));
    $$("[data-lpane]").forEach((p) => (p.hidden = p.dataset.lpane !== b.dataset.ltab));
  }));
  $$("[data-rtab]").forEach((b) => (b.onclick = () => showRightTab(b.dataset.rtab as "comments" | "props")));
  $$("[data-filter]").forEach((b) => (b.onclick = () => {
    state.filter = b.dataset.filter as "active" | "all";
    $$("[data-filter]").forEach((x) => x.classList.toggle("active", x === b));
    renderComments();
  }));
  $("#toggle-comments").onclick = () => {
    const r = $("#right");
    r.hidden = !r.hidden;
    $("#toggle-comments").classList.toggle("active", !r.hidden);
  };
  $("#toggle-comments").classList.add("active");
  $("#comp-search").oninput = renderComponents;

  const act = (a: string) => {
    const pane = state.focus;
    if (a === "fit") { pane?.kc?.zoomFit(); pane?.three?.fit(); }
    if (a === "zoomsel" && state.selectedRef) {
      pane?.kc?.zoomSelection();
      pane?.three?.highlight(state.selectedRef, true);
    }
    if (a === "comment") setCommentMode(!state.commentMode);
    if (a === "left") $("#left").hidden = !$("#left").hidden;
  };
  $$("#toolbar [data-act]").forEach((b) => (b.onclick = () => act(b.dataset.act!)));

  const form = $<HTMLFormElement>("#composer");
  form.onsubmit = (e) => { e.preventDefault(); submitComment(form); };
  form.text.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submitComment(form); }
  });

  document.addEventListener("keydown", (e) => {
    if ((e.target as HTMLElement).closest("input, textarea") || e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === "c") act("comment");
    else if (k === "f") act("fit");
    else if (k === "z") act("zoomsel");
    else if (k === "[") act("left");
    else if (k >= "1" && k <= "4") showMode(MODES[Number(k) - 1]!);
    else if (k === "escape") { setCommentMode(false); state.activeComment = null; renderComments(); }
  });
}

async function boot() {
  bindUi();
  state.project = await api.project();
  $("#project-name").textContent = state.project.name;
  document.title = `${state.project.name} · kicad-wiber`;
  renderStatus();
  renderProps();

  connect(
    async (msg) => {
      if (msg.type === "review") return refreshReview();
      state.project = await api.project();
      renderStatus();
      const kinds = new Set(state.panes.map((p) => (p.kind === "3d" ? "pcb" : p.kind)));
      const relevant = msg.changed.length === 0 ||
        state.project.files.some((f) => msg.changed.includes(f.path) && (kinds.has(f.kind as "sch" | "pcb") || f.kind === "pro"));
      if (relevant) await showMode(state.mode, { keepCamera: true });
      renderComments();
    },
    (up) => { state.wsUp = up; renderStatus(); },
  );

  requestAnimationFrame(updatePins);
  await Promise.all([showMode(state.mode), refreshReview()]);
}

boot().catch((e) => {
  $("#stages").insertAdjacentHTML("afterbegin", `<div class="notice">Failed to start: ${esc(String(e))}</div>`);
});
