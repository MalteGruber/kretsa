import type { Anchor, Comment, ProjectInfo, Review, View } from "../../shared/review";
import { api, connect } from "./api";
import { itemToAnchor, itemToComponent, KiCanvasView, type Component } from "./kicanvas-view";
import type { ThreeView } from "./three-view";

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const $$ = <T extends HTMLElement = HTMLElement>(sel: string) => [...document.querySelectorAll<T>(sel)];
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const state = {
  project: null as ProjectInfo | null,
  review: { version: 1, comments: [] } as Review,
  view: ((location.hash.slice(1) as View) || "sch") as View,
  kc: null as KiCanvasView | null,
  three: null as ThreeView | null,
  components: [] as Component[],
  selected: null as Component | null,
  draftAnchors: [] as Anchor[],
  draftPoint: null as [number, number] | null,
  commentMode: false,
  activeComment: null as string | null,
  filter: "active" as "active" | "all",
  wsUp: false,
  mountSeq: 0,
};

// =====================================================================================
// Viewer
// =====================================================================================

async function showView(view: View, opts: { keepCamera?: boolean } = {}) {
  const seq = ++state.mountSeq;
  const prevCam = opts.keepCamera && state.view === view ? saveCamera() : null;
  const prevPage = opts.keepCamera && state.view === view ? state.kc?.pages().find((p) => p.active)?.path : undefined;

  state.view = view;
  history.replaceState(null, "", `#${view}`);
  $$("#tabs button").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
  setCommentMode(false);
  state.three?.dispose();
  state.three = null;
  state.kc = null;
  state.components = [];
  state.selected = null;
  renderProps();
  $("#pins").replaceChildren();
  const stage = $(".stage");
  stage.classList.toggle("dark", view !== "sch");
  stage.classList.toggle("has-layerbar", view === "pcb");
  $("#layerbar").hidden = view !== "pcb";
  $("#toolbar [data-act=zoomsel]").hidden = view === "3d";

  const host = $("#viewer");
  if (!state.project) return;
  if (view === "3d") {
    const { mountThree } = await import("./three-view"); // three.js is big; load on demand
    const tv = await mountThree(host, state.project.rev, onThreePick);
    if (seq !== state.mountSeq) return tv?.dispose();
    state.three = tv;
  } else {
    const kc = new KiCanvasView(host, view);
    kc.onSelect = onKiCanvasSelect;
    state.kc = kc;
    const ok = await kc.mount(state.project);
    if (seq !== state.mountSeq || !ok) return;
    if (prevPage) { kc.setPage(prevPage); await kc.waitViewer(); }
    if (prevCam) setTimeout(() => restoreCamera(prevCam), 150);
    setTimeout(() => { if (seq === state.mountSeq) refreshViewerData(); }, 100);
  }
  renderDocs();
  renderComponents();
}

function refreshViewerData() {
  state.components = state.kc?.components() ?? [];
  renderComponents();
  renderDocs();
  renderLayers();
}

function saveCamera() {
  const cam = state.kc?.viewer?.viewport?.camera;
  return cam ? { x: cam.center.x, y: cam.center.y, zoom: cam.zoom } : null;
}
function restoreCamera(c: { x: number; y: number; zoom: number } | null) {
  const v = state.kc?.viewer;
  const cam = v?.viewport?.camera;
  if (!c || !cam) return;
  cam.center.set(c.x, c.y);
  cam.zoom = c.zoom;
  v.draw();
}

function currentFile(): string | undefined {
  const kind = state.view === "3d" ? "pcb" : state.view;
  if (kind === "sch") {
    const page = state.kc?.pages().find((p) => p.active);
    if (page) return page.path.split(":")[0];
  }
  return state.project?.files.find((f) => f.kind === kind)?.path;
}
function currentSheet(): string | undefined {
  return state.view === "sch" ? state.kc?.pages().find((p) => p.active)?.path : undefined;
}

// ---------- selection ----------

function onKiCanvasSelect(item: any) {
  state.selected = itemToComponent(item);
  renderProps();
  renderComponents();
  if (state.selected) showRightTab("props");
  // While composing, clicking parts in the design attaches them to the comment.
  const composing = document.activeElement === $("#composer textarea") || $<HTMLTextAreaElement>("#composer textarea").value.trim();
  const a = itemToAnchor(item);
  if (a && composing && a.kind !== "point") addAnchor(a);
}

function onThreePick(a: Anchor) {
  if (a.kind !== "symbol") return;
  state.selected = { ref: a.ref, value: "", footprint: "", props: [] };
  renderProps();
  if (state.commentMode) {
    addAnchor(a);
    setCommentMode(false);
    focusComposer();
  }
}

// ---------- comment mode (click on canvas to drop a pin) ----------

function setCommentMode(on: boolean) {
  state.commentMode = on;
  $("#toolbar [data-act=comment]").classList.toggle("active", on);
  // 2D: an overlay captures the click; 3D: the three view's own pick handler is used.
  $("#comment-catcher").hidden = !on || state.view === "3d";
}

// Cursor position readout in document mm (KiCad coordinates).
$(".stage").addEventListener("pointermove", (e) => {
  const r = $("#viewer").getBoundingClientRect();
  const w = state.kc?.screenToWorld(e.clientX - r.left, e.clientY - r.top);
  $("#coords").textContent = w ? `X ${w[0].toFixed(2)}  Y ${w[1].toFixed(2)} mm` : "";
});
$(".stage").addEventListener("pointerleave", () => ($("#coords").textContent = ""));

$("#comment-catcher").addEventListener("click", (e) => {
  const r = $("#viewer").getBoundingClientRect();
  const w = state.kc?.screenToWorld(e.clientX - r.left, e.clientY - r.top);
  setCommentMode(false);
  if (!w) return;
  state.draftPoint = w;
  addAnchor({ kind: "point", at_mm: w });
  focusComposer();
});

function focusComposer() {
  showRightTab("comments");
  $("#right").hidden = false;
  $<HTMLTextAreaElement>("#composer textarea").focus();
}

// =====================================================================================
// Pins overlay (follows the KiCanvas camera)
// =====================================================================================

function commentNumber(c: Comment) { return state.review.comments.indexOf(c) + 1; }

function anchorWorldPos(c: Comment): [number, number] | null {
  for (const a of c.anchors) {
    if (a.kind === "point") return a.at_mm;
    if (a.kind === "area") return [(a.bbox_mm[0] + a.bbox_mm[2]) / 2, (a.bbox_mm[1] + a.bbox_mm[3]) / 2];
  }
  for (const a of c.anchors) {
    if (a.kind === "symbol" || a.kind === "pad") {
      const p = state.kc?.positionOf(a.ref);
      if (p) return p;
    }
  }
  return null;
}

function commentOnCurrentDoc(c: Comment) {
  if (c.view !== state.view) return false;
  if (state.view === "sch") {
    const sheet = currentSheet();
    return !c.sheet || !sheet || c.sheet === sheet;
  }
  return !c.file || c.file === currentFile();
}

function visibleComments(): Comment[] {
  return state.review.comments.filter((c) => state.filter === "all" || c.status === "open" || c.status === "addressed");
}

const pinEls = new Map<string, HTMLElement>();
function updatePins() {
  requestAnimationFrame(updatePins);
  const kc = state.kc;
  const host = $("#pins");
  if (!kc?.viewer) { if (host.childElementCount) host.replaceChildren(), pinEls.clear(); return; }
  const want = new Set<string>();
  const w = host.clientWidth, h = host.clientHeight;
  const place = (key: string, pos: [number, number] | null, make: () => HTMLElement) => {
    const s = pos && kc.worldToScreen(pos[0], pos[1]);
    if (!s || s[0] < -30 || s[1] < -30 || s[0] > w + 30 || s[1] > h + 30) return;
    want.add(key);
    let el = pinEls.get(key);
    if (!el) { el = make(); pinEls.set(key, el); host.appendChild(el); }
    el.style.left = `${s[0]}px`;
    el.style.top = `${s[1]}px`;
  };
  for (const c of visibleComments()) {
    if (!commentOnCurrentDoc(c)) continue;
    place(c.id, anchorWorldPos(c), () => {
      const el = document.createElement("div");
      el.onclick = () => activateComment(c.id, { fromPin: true });
      return el;
    });
    const el = pinEls.get(c.id);
    if (el) {
      el.className = `pin ${c.status}${state.activeComment === c.id ? " active" : ""}`;
      el.textContent = String(commentNumber(c));
      el.title = c.text;
    }
  }
  if (state.draftPoint) {
    place("__draft", state.draftPoint, () => {
      const el = document.createElement("div");
      el.className = "pin draft";
      el.textContent = "+";
      return el;
    });
  }
  for (const [k, el] of pinEls) if (!want.has(k)) { el.remove(); pinEls.delete(k); }
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
  const go = async () => {
    if (c.view !== state.view) await showView(c.view);
    if (c.sheet && state.kc && currentSheet() !== c.sheet) { state.kc.setPage(c.sheet); await state.kc.waitViewer(); }
    const sym = c.anchors.find((a) => a.kind === "symbol" || a.kind === "pad") as { ref: string } | undefined;
    if (sym && state.kc) { state.kc.select(sym.ref); state.kc.zoomSelection(); return; }
    const p = anchorWorldPos(c);
    if (p) state.kc?.centerOn(p[0], p[1]);
  };
  go();
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
  const c = await api.addComment({
    view: state.view,
    file: currentFile(),
    sheet: currentSheet(),
    anchors,
    text,
    // TODO: 2D snapshots (KiCanvas canvas lives in shadow DOM, needs preserveDrawingBuffer or a re-render)
    snapshotPng: state.three?.snapshot(),
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
  const list = $("#comment-list");
  list.replaceChildren(...visibleComments().slice().reverse().map(renderComment));
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
  const actions = li.querySelector(".cactions")!;
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
    const input = box.querySelector("input")!;
    const send = async () => { if (input.value.trim()) await patch({ reply: { author: "human", text: input.value.trim() } }); };
    box.querySelector("button")!.onclick = send;
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
    host.querySelector<HTMLButtonElement>("[data-pa=comment]")!.onclick = () => {
      addAnchor({ kind: "net", name: s.ref });
      focusComposer();
    };
    return;
  }
  const rows: [string, string][] = [
    ["Designator", s.ref],
    ["Value", s.value],
    ["Footprint", s.footprint],
    ...(s.lib ? [["Library ID", s.lib] as [string, string]] : []),
    ...(s.layer ? [["Layer", s.layer] as [string, string]] : []),
    ...s.props.filter(([k]) => !["Reference", "Value", "Footprint"].includes(k)),
  ].filter(([, v]) => v) as [string, string][];
  host.innerHTML = `
    <h3>${esc(s.ref)}</h3>
    <div class="sub">${esc(s.value || "")}</div>
    <table>${rows.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join("")}</table>
    <div class="pactions">
      <button class="primary" data-pa="comment">Comment on ${esc(s.ref)}</button>
      ${state.kc ? `<button class="secondary" data-pa="zoom">Zoom to</button>` : ""}
    </div>`;
  host.querySelector<HTMLButtonElement>("[data-pa=comment]")!.onclick = () => {
    addAnchor({ kind: "symbol", ref: s.ref, uuid: s.uuid, value: s.value || undefined });
    focusComposer();
  };
  const z = host.querySelector<HTMLButtonElement>("[data-pa=zoom]");
  if (z) z.onclick = () => { state.kc?.select(s.ref); state.kc?.zoomSelection(); };
}

// =====================================================================================
// Left panel: documents + components
// =====================================================================================

function renderDocs() {
  const p = state.project;
  if (!p) return;
  const list = $("#doc-list");
  const items: string[] = [];
  const pages = state.view === "sch" ? state.kc?.pages() ?? [] : [];
  items.push(`<li class="group">Schematic</li>`);
  if (pages.length) {
    for (const pg of pages) items.push(docItem("sch", pg.path, pg.name, pg.active));
  } else {
    for (const f of p.files.filter((f) => f.kind === "sch")) items.push(docItem("sch", f.path, f.path, false));
  }
  items.push(`<li class="group">Board</li>`);
  for (const f of p.files.filter((f) => f.kind === "pcb")) {
    items.push(docItem("pcb", f.path, f.path, state.view === "pcb"));
    items.push(docItem("3d", f.path, `${f.path} (3D)`, state.view === "3d"));
  }
  list.innerHTML = items.join("");
  list.querySelectorAll<HTMLLIElement>("li[data-view]").forEach((li) => {
    li.onclick = async () => {
      const view = li.dataset.view as View;
      if (view !== state.view) await showView(view);
      if (view === "sch" && state.kc) {
        const page = state.kc.pages().find((pg) => pg.path === li.dataset.path || pg.path.split(":")[0] === li.dataset.path);
        if (page && !page.active) {
          state.kc.setPage(page.path);
          await state.kc.waitViewer();
          setTimeout(refreshViewerData, 200);
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
  const list = $("#comp-list");
  const items = state.components.filter((c) => !q || `${c.ref} ${c.value} ${c.footprint}`.toLowerCase().includes(q));
  list.innerHTML = items.length
    ? items.map((c) => `<li data-ref="${esc(c.ref)}" class="${state.selected?.ref === c.ref ? "active" : ""}"><span class="ref">${esc(c.ref)}</span><span class="val">${esc(c.value)}</span></li>`).join("")
    : `<li class="group">${state.view === "3d" ? "Open Schematic or PCB to list components" : "No components"}</li>`;
  list.querySelectorAll<HTMLLIElement>("li[data-ref]").forEach((li) => {
    li.onclick = () => { state.kc?.select(li.dataset.ref!); state.kc?.zoomSelection(); };
  });
}

// =====================================================================================
// PCB layer bar
// =====================================================================================

function renderLayers() {
  const bar = $("#layerbar");
  const layers = state.kc?.layers() ?? [];
  // Hide the noisy user/fab layers that are rarely relevant for review.
  const shown = layers.filter((l) => !/^User\.\d|Eco\d|Margin|Adhes/.test(l.name));
  bar.innerHTML = shown
    .map((l) => `<button data-layer="${esc(l.name)}" class="${l.visible ? "" : "off"} ${l.highlighted ? "hl" : ""}" title="Click: focus layer · Right-click: show/hide">
      <span class="sw" style="background:${l.color}"></span>${esc(l.name)}</button>`)
    .join("");
  bar.querySelectorAll<HTMLButtonElement>("button").forEach((b) => {
    b.onclick = () => { state.kc?.highlightLayer(b.dataset.layer!); renderLayers(); };
    b.oncontextmenu = (e) => { e.preventDefault(); state.kc?.toggleLayer(b.dataset.layer!); renderLayers(); };
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
  $$("#tabs button").forEach((b) => (b.onclick = () => showView(b.dataset.view as View)));
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
    if (a === "fit") state.kc ? state.kc.zoomFit() : showView("3d");
    if (a === "zoomsel") state.kc?.zoomSelection();
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
    else if (k === "1") showView("sch");
    else if (k === "2") showView("pcb");
    else if (k === "3") showView("3d");
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
      const kind = state.view === "3d" ? "pcb" : state.view;
      const relevant = msg.changed.length === 0 ||
        state.project.files.some((f) => msg.changed.includes(f.path) && (f.kind === kind || f.kind === "pro"));
      if (relevant) await showView(state.view, { keepCamera: true });
      renderComments();
    },
    (up) => { state.wsUp = up; renderStatus(); },
  );

  requestAnimationFrame(updatePins);
  await Promise.all([showView(state.view), refreshReview()]);
}

boot().catch((e) => {
  $("#viewer").innerHTML = `<div class="notice">Failed to start: ${esc(String(e))}</div>`;
});
