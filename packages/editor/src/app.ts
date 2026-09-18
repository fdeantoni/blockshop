import { adminToken, api, ApiError, setAdminToken, type DevPackInfo, type PackResult, type PieceSummary, type ProfileInfo, type ServerStatus, type ServerUpdateResult, type WorkspaceInfo } from "./api.js";
import { ICONS, PROFILE_ICONS, SOURCE_URL, T } from "./i18n.js";
import { renderPackIcon } from "./pack-icon.js";
import { iconNode } from "./icons.js";
import { attachLongPress, attachTap } from "./input.js";
import { neighborCell, VoxelModel } from "./model.js";
import { Scene3D, type ViewName } from "./scene.js";
import { ThumbnailRenderer } from "./thumbnail.js";
import { TEMPLATES, type Template } from "./templates.js";
import type { Piece, PieceOptions, Voxel } from "@blockshop/schema";

const link = (href: string, text: string) => { const a = document.createElement("a"); a.href = href; a.textContent = text; a.target = "_blank"; a.rel = "noopener"; return a; };

/** License, source code (AGPL-3.0 section 13) and the Minecraft disclaimer, at the bottom of the home and grown-up pages. */
function legalFooter(): HTMLElement {
  const footer = document.createElement("footer");
  footer.className = "legal";
  const line = document.createElement("p");
  line.append(`${T.freeSoftware} · `, link(SOURCE_URL, T.sourceCode), " · ", link("third-party-licenses.txt", T.thirdPartyLicenses));
  const disclaimer = document.createElement("p");
  disclaimer.textContent = T.notOfficial;
  footer.append(line, disclaimer);
  return footer;
}

const h = <K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...children: Array<Node | string>): HTMLElementTagNameMap[K] => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) { if (k === "class") el.className = v; else el.setAttribute(k, v); }
  el.append(...children);
  return el;
};
const btn = (label: string, cls: string, onClick: () => void): HTMLButtonElement => {
  const b = h("button", { class: cls, type: "button" }, label);
  b.addEventListener("click", onClick);
  return b;
};

/** Debounced autosave with flush-on-hide, so edits survive a jump to Minecraft. */
class Saver {
  private timer: number | null = null;
  private pending: Promise<void> | null = null;
  private dirty = false;
  constructor(private readonly save: (keepalive: boolean) => Promise<void>, private readonly onState: (s: "saving" | "saved" | "error") => void) {
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") void this.flush(true); });
    window.addEventListener("pagehide", () => { void this.flush(true); });
  }
  mark(): void {
    this.dirty = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = window.setTimeout(() => void this.flush(false), 800);
  }
  async flush(keepalive = false): Promise<void> {
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null; }
    if (this.pending) await this.pending;
    if (!this.dirty) return;
    this.dirty = false;
    this.onState("saving");
    this.pending = this.save(keepalive).then(() => this.onState("saved"), () => { this.dirty = true; this.onState("error"); });
    await this.pending;
    this.pending = null;
  }
}

type Route = { kind: "home" } | { kind: "setup" } | { kind: "gallery"; pid: string } | { kind: "piece"; pid: string; id: string } | { kind: "admin" };

/** `#/`, `#/setup`, `#/p/<profile>`, `#/p/<profile>/piece/<id>`, `#/admin`. Anything else is home. */
function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  if (parts[0] === "setup") return { kind: "setup" };
  if (parts[0] === "admin") return { kind: "admin" };
  if (parts[0] === "p" && parts[1]) {
    if (parts[2] === "piece" && parts[3]) return { kind: "piece", pid: parts[1], id: parts[3] };
    return { kind: "gallery", pid: parts[1] };
  }
  return { kind: "home" };
}

const go = (hash: string) => { if (location.hash === hash) window.dispatchEvent(new HashChangeEvent("hashchange")); else location.hash = hash; };

export class App {
  private root: HTMLElement;
  private workspace!: WorkspaceInfo;
  private profile: ProfileInfo | null = null;
  private home!: HTMLElement;
  private setup!: HTMLElement;
  private gallery!: HTMLElement;
  private editor!: HTMLElement;
  private admin!: HTMLElement;
  private canvas!: HTMLCanvasElement;
  private scene: Scene3D | null = null;
  private thumbs: ThumbnailRenderer | null = null;
  /** Template pictures rendered this session, by profile and template id (palettes differ per profile). */
  private templateThumbs = new Map<string, string>();
  private model = new VoxelModel();
  private piece: Piece | null = null;
  private color = "oak";
  private mode: "build" | "erase" = "build";
  private saver!: Saver;
  private thumbTimer: number | null = null;
  private routing: Promise<void> = Promise.resolve();
  private ui!: { undo: HTMLButtonElement; redo: HTMLButtonElement; build: HTMLButtonElement; erase: HTMLButtonElement; seat: HTMLButtonElement; seatH: HTMLElement; seatVal: HTMLElement; share: HTMLButtonElement; name: HTMLInputElement; status: HTMLElement; palette: HTMLElement };
  private galleryUi!: { header: HTMLElement; cards: HTMLElement; publish: HTMLButtonElement; count: HTMLElement; icon: HTMLButtonElement; title: HTMLElement };

  constructor(root: HTMLElement) { this.root = root; }

  async start(): Promise<void> {
    this.workspace = await api.workspace();
    void this.backfillPackIcons();
    document.title = this.workspace.uiTitle;
    this.root.replaceChildren();
    this.home = h("div", { id: "home", class: "screen" });
    this.setup = h("div", { id: "setup", class: "screen" });
    this.admin = h("div", { id: "admin", class: "screen" });
    this.gallery = this.buildGallery();
    this.editor = this.buildEditor();
    this.root.append(this.home, this.setup, this.gallery, this.editor, this.admin);
    this.saver = new Saver((keepalive) => this.savePiece(keepalive), (s) => { this.ui.status.textContent = s === "saving" ? T.saving : s === "saved" ? T.saved : T.offline; });
    window.addEventListener("hashchange", () => { this.routing = this.routing.then(() => this.route()).catch((e) => this.showError(e)); });
    await this.route();
  }

  /**
   * Draw the profile's icon and hand it to the server, which puts it on that profile's packs. The server
   * cannot draw an emoji, so this is the only place it can come from; it runs on every icon change and once
   * for profiles that predate it.
   */
  private async uploadPackIcon(p: ProfileInfo): Promise<void> {
    try {
      const palette = p.palette as Array<{ rgba: [number, number, number, number] }>;
      const accent = palette[0]?.rgba ?? [184, 148, 95, 255];
      await api.setIconPng(p.id, await renderPackIcon(p.icon, accent));
    } catch {
      // A pack icon is decoration: a failure here must never stop a kid from building.
    }
  }

  /** Profiles whose packs have no icon yet (made before the editor drew them, or icon changed elsewhere). */
  private async backfillPackIcons(): Promise<void> {
    for (const p of this.workspace.profiles) if (!p.hasIconPng) await this.uploadPackIcon(p);
  }

  private show(screen: HTMLElement): void {
    for (const s of [this.home, this.setup, this.gallery, this.editor, this.admin]) s.hidden = s !== screen;
  }

  private async route(): Promise<void> {
    const r = parseRoute(location.hash);
    if (this.piece && r.kind !== "piece") await this.leaveEditor();
    if (r.kind !== "piece") this.workspace = await api.workspace();
    if (this.workspace.setupNeeded && r.kind !== "setup") { go("#/setup"); return; }
    switch (r.kind) {
      case "setup": return this.showSetup();
      case "admin": return this.showAdmin();
      case "gallery": await this.openProfile(r.pid); return this.showGallery();
      case "piece": await this.openProfile(r.pid); return this.openPiece(r.id);
      default: return this.showHome();
    }
  }

  // ---------- Home: one card per profile
  private showHome(): void {
    this.show(this.home);
    const cards = h("div", { class: "profiles" });
    for (const p of this.workspace.profiles) {
      const meta = p.latest ? T.latestPack(p.latest.version) : T.noPackYet;
      const card = h("div", { class: "profile" },
        h("div", { class: "bigicon" }, iconNode(p.icon)),
        h("div", { class: "name" }, p.name),
        h("div", { class: "meta" }, `${T.pieces(p.pieceCount, p.maxPieces)} · ${meta}`),
        h("div", { class: "row" },
          btn(`▶ ${T.open}`, "primary big", () => go(`#/p/${p.id}`)),
          (() => { const b = btn(`⬇︎ ${T.makeDownload}`, "big", () => void this.makeDownloadFor(p, b)); return b; })(),
        ),
      );
      cards.append(card);
    }
    this.home.replaceChildren(
      h("header", {}, h("h1", {}, this.workspace.uiTitle), btn(`⚙️ ${T.grownUp}`, "", () => go("#/admin"))),
      h("h2", { class: "sub" }, T.whoseFurniture),
      cards,
      legalFooter(),
    );
  }

  // ---------- First run: the grown-up PIN and profile
  private showSetup(): void {
    this.show(this.setup);
    if (!this.workspace.setupNeeded) { go("#/"); return; }
    const name = h("input", { class: "name", type: "text", maxlength: "40", placeholder: T.yourName, autocomplete: "off", autocapitalize: "words" });
    const pin = h("input", { class: "name", type: "password", inputmode: "numeric", pattern: "[0-9]*", maxlength: "8", placeholder: T.pin, autocomplete: "new-password" });
    const pin2 = h("input", { class: "name", type: "password", inputmode: "numeric", pattern: "[0-9]*", maxlength: "8", placeholder: T.pinAgain, autocomplete: "new-password" });
    let icon = "🧔";
    const icons = this.iconGrid(icon, (i) => { icon = i; });
    const error = h("p", { class: "error" });
    const submit = btn(`✨ ${T.letsGo}`, "primary big", async () => {
      error.textContent = "";
      if (pin.value !== pin2.value) { error.textContent = T.pinMismatch; return; }
      submit.disabled = true;
      try {
        const r = await api.setup({ pin: pin.value, name: name.value.trim(), icon });
        setAdminToken(r.token);
        void this.uploadPackIcon(r.profile);
        go("#/admin");
      } catch (e) {
        error.textContent = e instanceof ApiError ? e.message : String(e);
      } finally { submit.disabled = false; }
    });
    this.setup.replaceChildren(h("div", { class: "form" },
      h("h1", {}, `🧱 ${T.setupTitle}`), h("p", {}, T.setupText),
      h("label", {}, T.yourName, name), h("label", {}, T.pickIcon, icons),
      h("label", {}, T.pin, pin), h("label", {}, T.pinAgain, pin2),
      error, submit,
    ));
  }

  /** Emoji grid for profile icons; calls back with the pick and highlights it. */
  private iconGrid(current: string, onPick: (icon: string) => void): HTMLElement {
    const grid = h("div", { class: "icons emoji" });
    const buttons: HTMLButtonElement[] = [];
    for (const i of PROFILE_ICONS) {
      const b = h("button", { type: "button", class: i === current ? "on" : "" }, iconNode(i));
      b.addEventListener("click", () => { for (const x of buttons) x.classList.toggle("on", x === b); onPick(i); });
      buttons.push(b);
      grid.append(b);
    }
    return grid;
  }

  // ---------- Gallery
  private buildGallery(): HTMLElement {
    const cards = h("div", { class: "cards" });
    const publish = btn(`⬇︎ ${T.makeDownload}`, "big", () => void this.makeDownload());
    const count = h("span", { class: "count" });
    const icon = btn("", "icon profileicon", () => this.pickProfileIcon());
    const title = h("h1", {});
    const header = h("header", {},
      btn(`◀ ${T.home}`, "", () => go("#/")), icon, title, count,
      btn(`➕ ${T.newPiece}`, "big", () => this.showStartFrom()), publish,
    );
    this.galleryUi = { header, cards, publish, count, icon, title };
    return h("div", { id: "gallery", class: "screen" }, header, cards);
  }

  /** Load a profile and point the gallery and editor at it (palette bar, scene palette, template pictures). */
  private async openProfile(pid: string): Promise<void> {
    if (this.profile?.id === pid) return;
    const profile = await api.profile(pid);
    this.profile = profile;
    this.color = profile.palette[0]?.id ?? "oak";
    this.fillPalette();
    this.scene?.setPalette(profile.palette);
    this.refreshGalleryHeader();
  }

  private refreshGalleryHeader(): void {
    const p = this.profile;
    if (!p) return;
    this.galleryUi.icon.replaceChildren(iconNode(p.icon));
    this.galleryUi.title.textContent = p.packName;
    this.galleryUi.count.textContent = T.pieces(p.pieceCount, p.maxPieces);
    this.galleryUi.count.classList.toggle("full", p.pieceCount >= p.maxPieces);
  }

  private async refreshProfile(): Promise<void> {
    if (!this.profile) return;
    try { this.profile = await api.profile(this.profile.id); this.refreshGalleryHeader(); } catch { /* keep what we have */ }
  }

  private async showGallery(): Promise<void> {
    if (!this.profile) return;
    this.show(this.gallery);
    const { cards } = this.galleryUi;
    cards.replaceChildren();
    await this.refreshProfile();
    let list: PieceSummary[] = [];
    try { list = await api.pieces(this.profile.id); } catch (e) { cards.append(h("div", { class: "empty" }, `${T.offline} (${(e as Error).message})`)); return; }
    if (list.length === 0) cards.append(h("div", { class: "empty" }, T.empty));
    for (const p of list) {
      const img = p.hasThumbnail ? h("img", { src: api.thumbnailUrl(this.profile.id, p.id, p.updatedAt), alt: "" }) : h("div", { class: "ph" }, "🪑");
      // Being on the family server shows as the card's own outline; the words live in the menu and the editor.
      const card = h("div", { class: `card${p.hidden ? " hidden-piece" : ""}${p.onFamilyServer ? " on-server" : ""}` }, img, h("div", { class: "name" }, p.name), h("div", { class: "meta" }, p.hidden ? T.hidden : p.author || ""));
      let longPressed = false;
      attachLongPress(card, 600, () => { longPressed = true; void this.pieceMenu(p); });
      card.addEventListener("click", () => { if (longPressed) { longPressed = false; return; } go(`#/p/${this.profile!.id}/piece/${p.id}`); });
      cards.append(card);
    }
  }

  /** Long-press on a card: on the family server or not, then copy, hide or bring back, delete when never sent. */
  private pieceMenu(p: PieceSummary): Promise<void> {
    const pid = this.profile!.id;
    return new Promise((resolve) => {
      const overlay = h("div", { class: "overlay" });
      const close = () => { overlay.remove(); resolve(); };
      const after = (promise: Promise<unknown>) => { void promise.then(() => { close(); void this.showGallery(); }, (e) => { close(); this.showError(e); }); };
      const action = p.hidden
        ? btn(T.unhide, "big", () => after(api.unhide(pid, p.id)))
        : btn(T.hide, "danger big", () => after(api.hide(pid, p.id)));
      const set = (on: boolean) => () => (on === p.onFamilyServer ? close() : after(api.update(pid, p.id, { options: { onFamilyServer: on } })));
      const choice = h("div", { class: "row" },
        btn(T.yes, p.onFamilyServer ? "primary big on" : "big", set(true)),
        btn(T.no, p.onFamilyServer ? "big" : "primary big on", set(false)),
      );
      const row = h("div", { class: "row" }, btn(`📋 ${T.copy}`, "big", () => { close(); void this.copyPiece(p); }), action);
      if (!p.publishedInVersion) row.append(btn(`🗑 ${T.delete}`, "danger big", () => after(api.remove(pid, p.id))));
      row.append(btn(T.close, "big", close));
      overlay.append(h("div", { class: "dialog" },
        h("h2", {}, p.name),
        h("p", {}, `🏠 ${T.onFamilyServer}?`),
        choice,
        h("p", { class: "meta" }, p.onFamilyServer ? T.shareOffText : T.shareOnText),
        row,
      ));
      this.root.append(overlay);
    });
  }

  private pickProfileIcon(): void {
    const p = this.profile;
    if (!p) return;
    const overlay = h("div", { class: "overlay" });
    const grid = this.iconGrid(p.icon, (icon) => {
      overlay.remove();
      void api.setIcon(p.id, icon).then((updated) => { this.profile = updated; this.refreshGalleryHeader(); return this.uploadPackIcon(updated); }, (e) => this.showError(e));
    });
    overlay.append(h("div", { class: "dialog" }, h("h2", {}, T.pickIcon), grid, btn(T.close, "big", () => overlay.remove())));
    this.root.append(overlay);
  }

  /** "Start from…": an empty grid, or a copy of a template to recolour and change. */
  private showStartFrom(): void {
    const p = this.profile;
    if (!p) return;
    if (p.pieceCount >= p.maxPieces) { this.showNotice("🧱", T.full(p.maxPieces)); return; }
    const overlay = h("div", { class: "overlay" });
    const cards = h("div", { class: "cards templates" });
    const pick = (t: Template | null) => {
      overlay.remove();
      void this.createPiece(t ? t.name : T.newPiece, t?.voxels ?? [], t?.options ?? {});
    };
    const empty = h("div", { class: "card" }, h("div", { class: "ph" }, "✨"), h("div", { class: "name" }, T.emptyPiece));
    empty.addEventListener("click", () => pick(null));
    cards.append(empty);
    const thumbs = this.templateThumbnails();
    for (const t of TEMPLATES) {
      const url = thumbs.get(`${p.id}:${t.id}`);
      const img = url ? h("img", { src: url, alt: "" }) : h("div", { class: "ph" }, t.icon);
      const card = h("div", { class: "card" }, img, h("div", { class: "name" }, t.name));
      card.addEventListener("click", () => pick(t));
      cards.append(card);
    }
    overlay.append(h("div", { class: "dialog wide" }, h("h2", {}, `✨ ${T.startFrom}`), cards, btn(T.close, "big", () => overlay.remove())));
    this.root.append(overlay);
  }

  /** Create a piece with this content, name it "<word> <n>" from the id number (friendlier than the server's default), open it. */
  private async createPiece(word: string, voxels: Voxel[], options: PieceOptions): Promise<void> {
    const pid = this.profile!.id;
    try {
      const piece = await api.create(pid, { name: word.slice(0, 40), voxels, options });
      const n = piece.id.replace(/\D/g, "");
      const named = await api.update(pid, piece.id, { name: `${word} ${n}`.slice(0, 40) });
      go(`#/p/${pid}/piece/${named.id}`);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) this.showNotice("🧱", T.full(this.profile!.maxPieces));
      else this.showError(e);
    }
  }

  /** A new piece with the same voxels, seat and light as an existing one. */
  private async copyPiece(p: PieceSummary): Promise<void> {
    let src;
    try { src = await api.piece(this.profile!.id, p.id); } catch (e) { this.showError(e); return; }
    const word = src.name.replace(/\s+\d+$/, "").trim() || src.name;
    await this.createPiece(word, src.voxels, { seat: src.options.seat, light: src.options.light });
  }

  /**
   * Template pictures, rendered once per profile and session through the live scene and thumbnail
   * renderer (a second WebGL context is expensive on the iPad, and Scene3D has no dispose). Without
   * WebGL the picker falls back to the template icons.
   */
  private templateThumbnails(): Map<string, string> {
    const pid = this.profile!.id;
    if (TEMPLATES.every((t) => this.templateThumbs.has(`${pid}:${t.id}`))) return this.templateThumbs;
    try {
      const scene = this.ensureScene();
      const thumbs = this.thumbs;
      if (!thumbs) return this.templateThumbs;
      for (const t of TEMPLATES) {
        if (this.templateThumbs.has(`${pid}:${t.id}`)) continue;
        this.model.reset(t.voxels);
        this.templateThumbs.set(`${pid}:${t.id}`, thumbs.render(scene, this.model.bounds()));
      }
    } catch { /* no WebGL: icons instead */ } finally {
      if (!this.piece) this.model.reset([]);
    }
    return this.templateThumbs;
  }

  // ---------- Editor
  private buildEditor(): HTMLElement {
    this.canvas = h("canvas");
    const name = h("input", { class: "name", type: "text", maxlength: "40", placeholder: T.name, autocomplete: "off", autocapitalize: "words" });
    name.addEventListener("input", () => this.saver.mark());
    name.addEventListener("keydown", (e) => { if (e.key === "Enter") name.blur(); });
    const undo = btn("↶", "icon", () => { this.model.undo(); this.afterEdit(); });
    const redo = btn("↷", "icon", () => { this.model.redo(); this.afterEdit(); });
    const mirror = btn("⇔", "icon", () => { this.model.mirrorX(); this.afterEdit(); });
    mirror.title = T.mirror;
    const views = h("div", { class: "group" }, ...(["front", "side", "top"] as ViewName[]).map((v) => btn(T.views[v as "front" | "side" | "top"], "", () => this.scene?.setView(v))));
    const seat = btn("🪑", "icon", () => this.toggleSeat());
    seat.title = T.seat;
    const share = btn("🏠", "icon", () => this.toggleShare());
    const seatVal = h("span", { class: "seatval" }, "5");
    const seatH = h("div", { class: "group" }, btn("▼", "icon", () => this.nudgeSeat(-1)), seatVal, btn("▲", "icon", () => this.nudgeSeat(1)));
    seatH.style.alignItems = "center";
    seatH.hidden = true;
    const build = btn(`🧱 ${T.build}`, "on", () => this.setMode("build"));
    const erase = btn(`🧽 ${T.erase}`, "", () => this.setMode("erase"));
    const palette = h("div", { class: "palette" });
    const status = h("div", { class: "status" });
    const top = h("div", { class: "topbar" },
      btn(`◀ ${T.back}`, "", () => go(`#/p/${this.profile?.id ?? ""}`)),
      h("div", { class: "group" }, name, btn("😀", "icon", () => this.pickIcon())),
      views,
      h("div", { class: "group" }, undo, redo, mirror),
      h("div", { class: "group" }, seat, seatH, share),
    );
    const bottom = h("div", { class: "bottombar" }, h("div", { class: "group" }, build, erase), h("div", { class: "group" }, palette));
    const el = h("div", { id: "editor", class: "screen" }, this.canvas, top, bottom, status);
    el.hidden = true;
    this.ui = { undo, redo, build, erase, seat, seatH, seatVal, share, name, status, palette };
    attachTap(this.canvas, (x, y) => this.tap(x, y));
    return el;
  }

  private fillPalette(): void {
    const palette = this.ui.palette;
    palette.replaceChildren();
    for (const p of this.profile?.palette ?? []) {
      const [r, g, b, a] = p.rgba;
      const sw = btn("", `swatch${p.translucent || a < 255 ? " glass" : ""}`, () => this.setColor(p.id));
      sw.style.backgroundColor = `rgb(${r} ${g} ${b})`;
      sw.title = p.label;
      sw.dataset["id"] = p.id;
      palette.append(sw);
    }
  }

  private ensureScene(): Scene3D {
    if (!this.scene) {
      this.scene = new Scene3D(this.canvas, this.profile?.palette ?? []);
      this.scene.setModel(this.model);
      this.thumbs = new ThumbnailRenderer();
    }
    return this.scene;
  }

  private async openPiece(id: string): Promise<void> {
    const pid = this.profile!.id;
    if (this.piece && this.piece.id !== id) await this.leaveEditor();
    const piece = await api.piece(pid, id);
    this.piece = piece;
    this.model.reset(piece.voxels);
    this.show(this.editor);
    const scene = this.ensureScene();
    scene.setView("iso");
    this.ui.name.value = piece.name;
    this.ui.status.textContent = "";
    this.setMode("build");
    this.setColor(this.color);
    this.refreshSeat();
    this.refreshShare();
    this.refreshHistoryButtons();
    // The canvas was display:none while hidden; size it now.
    window.dispatchEvent(new Event("resize"));
  }

  /** Save and push the picture before the editor goes away (route change). */
  private async leaveEditor(): Promise<void> {
    await this.saver.flush();
    await this.pushThumbnail();
    this.piece = null;
  }

  private tap(x: number, y: number): void {
    if (!this.scene || !this.piece) return;
    const hit = this.scene.raycast(x, y);
    if (!hit) return;
    if (this.mode === "erase") {
      if (hit.kind === "voxel") this.model.remove(hit.cell);
    } else {
      const target = hit.kind === "floor" ? hit.cell : neighborCell(hit.cell, hit.normal);
      if (target && !this.model.has(target)) this.model.place(target, this.color);
    }
    this.afterEdit();
  }

  private afterEdit(): void {
    this.refreshHistoryButtons();
    this.saver.mark();
    if (this.thumbTimer !== null) clearTimeout(this.thumbTimer);
    this.thumbTimer = window.setTimeout(() => void this.pushThumbnail(), 2500);
  }

  private refreshHistoryButtons(): void {
    this.ui.undo.disabled = !this.model.canUndo;
    this.ui.redo.disabled = !this.model.canRedo;
  }

  private setMode(mode: "build" | "erase"): void {
    this.mode = mode;
    this.ui.build.classList.toggle("on", mode === "build");
    this.ui.erase.classList.toggle("on", mode === "erase");
  }

  private setColor(id: string): void {
    this.color = id;
    for (const sw of this.ui.palette.querySelectorAll<HTMLButtonElement>(".swatch")) sw.classList.toggle("on", sw.dataset["id"] === id);
    this.setMode("build");
  }

  private currentOptions(): PieceOptions { return this.piece?.options ?? {}; }

  private toggleSeat(): void {
    if (!this.piece) return;
    const seat = this.currentOptions().seat;
    const enabled = !(seat?.enabled ?? false);
    this.piece.options = { ...this.piece.options, seat: { enabled, height: seat?.height ?? 5 } };
    this.refreshSeat();
    this.saver.mark();
  }

  private nudgeSeat(d: number): void {
    if (!this.piece?.options.seat) return;
    const height = Math.max(0, Math.min(15, this.piece.options.seat.height + d));
    this.piece.options = { ...this.piece.options, seat: { enabled: true, height } };
    this.refreshSeat();
    this.saver.mark();
  }

  /** On the family server or not; a piece is always in its own profile's worlds either way. */
  private toggleShare(): void {
    if (!this.piece) return;
    this.piece.options = { ...this.piece.options, onFamilyServer: this.currentOptions().onFamilyServer === false };
    this.refreshShare();
    this.saver.mark();
  }

  private refreshShare(): void {
    const on = this.currentOptions().onFamilyServer !== false;
    this.ui.share.classList.toggle("on", on);
    this.ui.share.title = on ? T.onFamilyServer : T.offServerPiece;
  }

  private refreshSeat(): void {
    const seat = this.currentOptions().seat;
    const on = seat?.enabled === true;
    this.ui.seat.classList.toggle("on", on);
    this.ui.seatH.hidden = !on;
    this.ui.seatVal.textContent = String(seat?.height ?? 5);
    this.scene?.setSeatMarker(on ? (seat?.height ?? 5) : null);
  }

  private pickIcon(): void {
    const overlay = h("div", { class: "overlay" });
    const grid = h("div", { class: "icons" });
    for (const { icon, word } of ICONS) {
      const b = h("button", { type: "button" }, icon, h("small", {}, word));
      b.addEventListener("click", () => { this.ui.name.value = word; this.saver.mark(); overlay.remove(); });
      grid.append(b);
    }
    overlay.append(h("div", { class: "dialog" }, grid, btn(T.close, "big", () => overlay.remove())));
    this.root.append(overlay);
  }

  private async savePiece(keepalive: boolean): Promise<void> {
    if (!this.piece || !this.profile) return;
    const name = this.ui.name.value.trim() || this.piece.name;
    const updated = await api.update(this.profile.id, this.piece.id, { name, voxels: this.model.toVoxels(), options: this.piece.options }, keepalive);
    this.piece = { ...updated, options: this.piece.options };
  }

  private async pushThumbnail(): Promise<void> {
    if (this.thumbTimer !== null) { clearTimeout(this.thumbTimer); this.thumbTimer = null; }
    if (!this.piece || !this.profile || !this.scene || !this.thumbs || this.model.size === 0) return;
    try { await api.thumbnail(this.profile.id, this.piece.id, this.thumbs.render(this.scene, this.model.bounds())); } catch { /* thumbnails are best effort */ }
  }

  // ---------- The pack file (for another device or a friend), from the gallery or the home screen
  private async makeDownload(): Promise<void> {
    const p = this.profile;
    if (!p) return;
    const { publish } = this.galleryUi;
    publish.disabled = true;
    publish.textContent = T.working;
    try {
      const r = await api.pack(p.id);
      await this.refreshProfile();
      this.showReady(r, p);
    } catch (e) {
      this.showPackError(e);
    } finally {
      publish.disabled = false;
      publish.textContent = `⬇︎ ${T.makeDownload}`;
    }
  }

  /** The same from the home screen, where there is no gallery button to put in a working state. */
  private async makeDownloadFor(p: ProfileInfo, button: HTMLButtonElement): Promise<void> {
    button.disabled = true;
    const label = button.textContent;
    button.textContent = T.working;
    try {
      this.showReady(await api.pack(p.id), p);
      this.workspace = await api.workspace();
      this.showHome();
    } catch (e) {
      this.showPackError(e);
    } finally {
      button.disabled = false;
      button.textContent = label;
    }
  }

  /** "Nothing drawn yet" is a normal thing for a kid to run into, not an error to apologise for. */
  private showPackError(e: unknown): void {
    if (e instanceof ApiError && e.status === 422) this.showNotice(`✏️ ${T.nothingToPack}`, T.downloadWhy);
    else this.showError(e);
  }

  private showReady(r: PackResult, p: ProfileInfo): void {
    const overlay = h("div", { class: "overlay" });
    const wasFirst = p.latest === null;
    // A plain same-tab link: Safari's download manager takes over, and tapping the file there
    // opens Minecraft. The minecraft:// deep link opens Minecraft without importing (device test).
    const dialog = h("div", { class: "dialog" },
      h("h2", {}, `🎉 ${T.ready}`),
      h("p", {}, T.readyText(p.packName, r.versionString)),
      h("p", { class: "meta" }, T.downloadWhy),
      ...(wasFirst ? [h("p", {}, `💾 ${T.backupTip}`)] : []),
      h("a", { class: "btn primary big", href: r.mcaddonUrl }, `⬇︎ ${T.download}`),
      h("p", {}, T.downloadHint),
      h("details", { class: "parent" },
        h("summary", {}, `🔄 ${T.updateTitle}`),
        h("p", {}, wasFirst ? T.firstActivateHint(p.packName) : T.updateHint(p.packName, r.versionString)),
      ),
      h("p", { class: "server" }, `🏠 ${T.serverNote}`),
      btn(T.close, "", () => overlay.remove()),
    );
    if (adminToken() && (r.warnings.length || r.validation)) {
      dialog.append(h("details", {}, h("summary", {}, `${r.pieceCount} pieces, ${r.cubeCount} cubes, ${r.durationMs} ms, ${r.warnings.length} warnings`), h("pre", {}, r.warnings.join("\n"))));
    }
    overlay.append(dialog);
    this.root.append(overlay);
  }

  private showNotice(title: string, text: string, details?: string): void {
    const overlay = h("div", { class: "overlay" });
    const dialog = h("div", { class: "dialog" }, h("h2", {}, title), h("p", {}, text), btn(T.close, "big", () => overlay.remove()));
    if (details) dialog.append(h("details", {}, h("summary", {}, T.details), h("pre", {}, details)));
    overlay.append(dialog);
    this.root.append(overlay);
  }

  private showError(e: unknown): void {
    const overlay = h("div", { class: "overlay" });
    const msg = e instanceof ApiError ? e.message : (e as Error)?.message ?? String(e);
    const dialog = h("div", { class: "dialog" }, h("h2", {}, `😕 ${T.oops}`), h("p", {}, T.tryAgain), btn(T.close, "big", () => overlay.remove()));
    dialog.append(h("details", {}, h("summary", {}, T.details), h("pre", {}, msg)));
    overlay.append(dialog);
    this.root.append(overlay);
  }

  private confirm(title: string, text: string, yes: string): Promise<boolean> {
    return new Promise((resolve) => {
      const overlay = h("div", { class: "overlay" });
      const done = (v: boolean) => { overlay.remove(); resolve(v); };
      overlay.append(h("div", { class: "dialog" }, h("h2", {}, title), h("p", {}, text), h("div", { class: "row" }, btn(yes, "danger big", () => done(true)), btn(T.no, "big", () => done(false)))));
      this.root.append(overlay);
    });
  }

  private prompt(title: string, placeholder: string, initial = "", opts: { pin?: boolean } = {}): Promise<string | null> {
    return new Promise((resolve) => {
      const overlay = h("div", { class: "overlay" });
      const input = h("input", { class: "name wide", type: opts.pin ? "password" : "text", maxlength: opts.pin ? "8" : "40", placeholder, autocomplete: "off", ...(opts.pin ? { inputmode: "numeric", pattern: "[0-9]*" } : { autocapitalize: "words" }) });
      input.value = initial;
      const done = (v: string | null) => { overlay.remove(); resolve(v); };
      input.addEventListener("keydown", (e) => { if (e.key === "Enter") done(input.value); });
      overlay.append(h("div", { class: "dialog" }, h("h2", {}, title), input, h("div", { class: "row" }, btn("OK", "primary big", () => done(input.value)), btn(T.no, "big", () => done(null)))));
      this.root.append(overlay);
      input.focus();
    });
  }

  // ---------- Grown-up page
  private async showAdmin(): Promise<void> {
    this.show(this.admin);
    if (!adminToken()) return this.showLogin();
    try {
      const [info, server, devPack] = await Promise.all([
        api.admin(),
        api.server().catch((e: unknown) => (e instanceof ApiError && e.status === 401 ? Promise.reject(e) : null)),
        api.devPack().catch(() => null),
      ]);
      this.renderAdmin(info.profiles, info.maxProfiles, server, devPack);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) { setAdminToken(null); return this.showLogin(); }
      this.showError(e);
    }
  }

  private showLogin(error = ""): void {
    const pin = h("input", { class: "name", type: "password", inputmode: "numeric", pattern: "[0-9]*", maxlength: "8", placeholder: T.pin, autocomplete: "current-password" });
    const err = h("p", { class: "error" }, error);
    const submit = btn(`🔑 ${T.logIn}`, "primary big", async () => {
      try { setAdminToken((await api.login(pin.value)).token); await this.showAdmin(); } catch (e) { err.textContent = e instanceof ApiError && e.status === 401 ? T.wrongPin : String((e as Error).message); }
    });
    pin.addEventListener("keydown", (e) => { if (e.key === "Enter") submit.click(); });
    this.admin.replaceChildren(h("div", { class: "form" }, h("h1", {}, `⚙️ ${T.adminTitle}`), h("p", {}, T.enterPin), pin, err, submit, btn(`◀ ${T.home}`, "", () => go("#/"))));
    pin.focus();
  }

  private renderAdmin(profiles: ProfileInfo[], maxProfiles: number, server: ServerStatus | null, devPack: DevPackInfo | null): void {
    const refresh = () => void this.showAdmin();
    const guard = (promise: Promise<unknown>) => promise.then(refresh, (e) => this.showError(e));

    // Profiles
    const list = h("div", { class: "list" });
    for (const p of profiles) {
      const row = h("div", { class: "prow" },
        h("span", { class: "bigicon small" }, iconNode(p.icon)),
        h("div", { class: "grow" },
          h("div", { class: "name" }, `${p.name} `, h("small", {}, `(${p.id}${p.role === "grownup" ? ", grown-up" : p.role === "guest" ? `, ${T.guest}` : ""})`)),
          h("div", { class: "meta" }, `${T.pieces(p.pieceCount, p.maxPieces)} · ${p.latest ? T.latestPack(p.latest.version) : T.noPackYet}`),
          h("label", { class: "meta" },
            (() => {
              const box = h("input", { type: "checkbox" }) as HTMLInputElement;
              box.checked = p.onFamilyServer;
              box.addEventListener("change", () => void guard(api.updateProfile(p.id, { onFamilyServer: box.checked })));
              return box;
            })(),
            ` ${T.onFamilyServer}`,
          ),
        ),
        btn(T.rename, "", () => void this.prompt(T.newName, T.kidName, p.name).then((name) => { if (name?.trim()) void guard(api.updateProfile(p.id, { name: name.trim() })); })),
        btn(T.changeIcon, "", () => {
          const overlay = h("div", { class: "overlay" });
          overlay.append(h("div", { class: "dialog" }, h("h2", {}, T.pickIcon), this.iconGrid(p.icon, (icon) => { overlay.remove(); void guard(api.updateProfile(p.id, { icon }).then((updated) => this.uploadPackIcon(updated))); }), btn(T.close, "big", () => overlay.remove())));
          this.root.append(overlay);
        }),
      );
      if (!(p.role === "grownup" && profiles.filter((x) => x.role === "grownup").length === 1)) {
        row.append(btn(T.remove, "danger", () => void this.confirm(`${T.remove} ${p.name}?`, T.removeText(p.name), T.remove).then((ok) => { if (ok) void guard(api.deleteProfile(p.id)); })));
      }
      list.append(row);
    }
    const addKid = h("div", { class: "prow add" });
    if (profiles.length < maxProfiles) {
      const name = h("input", { class: "name", type: "text", maxlength: "40", placeholder: T.kidName, autocomplete: "off", autocapitalize: "words" });
      let icon = "🦄";
      const add = (role: "kid" | "guest") => {
        if (!name.value.trim()) return;
        void guard(api.addProfile({ name: name.value.trim(), icon, role }).then((p) => this.uploadPackIcon(p)));
      };
      addKid.append(
        h("div", { class: "grow" }, h("div", { class: "name" }, `➕ ${T.addKid}`), name, this.iconGrid(icon, (i) => { icon = i; }), h("div", { class: "meta" }, T.guestServerHint)),
        btn(T.add, "primary", () => add("kid")),
        btn(`🧑‍🤝‍🧑 ${T.addGuest}`, "", () => add("guest")),
      );
    }

    // Family server
    const serverBox = h("div", { class: "box" }, h("h2", {}, `🏠 ${T.familyServer}`));
    if (!server || server.mode === "off") {
      serverBox.append(h("p", {}, T.serverOff));
    } else {
      const rows = server.profiles.map((s) => h("li", {}, iconNode(s.icon), s.onFamilyServer
        ? ` ${s.name}: ${T.piecesNow(s.pieces)}, ${T.onServer} ${s.onServer ?? T.never}${s.changed ? ` · ${T.changedSince}` : ""}`
        : ` ${s.name}: ${T.offServerPiece}`));
      const online = server.online === null ? (server.onlineError ? `? (${server.onlineError})` : "?") : server.online.length ? server.online.map((n) => n.replace(/^\./, "")).join(", ") : T.nobodyOnline;
      const verdict = !server.changed ? T.serverUpToDate : server.needsRestart ? T.serverRestartNeeded : T.serverReloadOnly;
      serverBox.append(
        h("ul", {}, ...rows),
        h("p", {}, `${T.online}: ${online}`),
        h("p", { class: server.changed && server.needsRestart ? "warnline" : "" }, verdict),
        ...(server.restartPending ? [h("p", { class: "warnline" }, T.serverRestartPending)] : []),
        h("p", { class: "meta" }, `v${server.version} · ${T.serverFull(server.piecesLeft)}${server.lastDeploy?.error ? ` · ${server.lastDeploy.error}` : ""}`),
        h("div", { class: "row" },
          btn(`🏠 ${T.updateServer}`, "warn big", () => void this.updateServer()),
          ...(server.restartPending && !server.restartCommand ? [btn(`✅ ${T.markRestarted}`, "", () => void guard(api.serverRestarted()))] : []),
        ),
        h("p", { class: "meta" }, h("a", { href: "/java/", target: "_blank" }, "export files")),
      );
    }

    // The live packs for tablets' own worlds: one download for everyone, or one profile at a time.
    const tabletBox = h("div", { class: "box" }, h("h2", {}, `📲 ${T.tabletPack}`));
    tabletBox.append(h("p", {}, T.tabletPackIntro));
    if (devPack) {
      const linkRow = (file: string, url: string, meta: string) => {
        const copy = btn(T.copyLink, "", () => {
          void navigator.clipboard?.writeText(url).then(() => { copy.textContent = T.copied; setTimeout(() => { copy.textContent = T.copyLink; }, 1500); }, () => undefined);
        });
        return h("div", { class: "prow" },
          h("div", { class: "grow" }, h("div", { class: "name" }, h("a", { href: url }, file)), h("div", { class: "meta" }, meta)),
          copy,
        );
      };
      tabletBox.append(
        h("p", { class: "meta" }, T.tabletPackEveryone),
        h("div", { class: "list" }, linkRow(devPack.archive.file, devPack.archive.url, devPack.profiles.map((p) => p.packName).join(" · "))),
        h("p", { class: "meta" }, T.tabletPackOne),
        h("div", { class: "list" }, ...devPack.profiles.map((p) => linkRow(
          p.archive.file,
          p.archive.url,
          `${p.packName} · ${T.tabletPackPieces(p.pieces.length)}${p.skipped.length ? ` · ${T.tabletPackSkipped(p.skipped.length)}` : ""}`,
        ))),
        h("p", { class: "meta" }, T.tabletPackHowTo),
      );
    }

    const pinBox = h("div", { class: "row" },
      btn(`🔑 ${T.changePin}`, "", () => void this.prompt(T.changePin, T.newPin, "", { pin: true }).then((pin) => { if (pin) void api.changePin(pin).then((r) => { setAdminToken(r.token); refresh(); }, (e) => this.showError(e)); })),
      btn(T.logOut, "", () => void api.logout().catch(() => undefined).then(() => { setAdminToken(null); go("#/"); })),
    );
    this.admin.replaceChildren(
      h("header", {}, btn(`◀ ${T.home}`, "", () => go("#/")), h("h1", {}, `⚙️ ${T.adminTitle}`)),
      h("div", { class: "adminbody" },
        h("div", { class: "box" }, h("h2", {}, `👪 ${T.profiles}`), list, addKid),
        serverBox,
        tabletBox,
        h("div", { class: "box" }, pinBox),
        legalFooter(),
      ),
    );
  }

  private async updateServer(): Promise<void> {
    try {
      const r: ServerUpdateResult = await api.serverUpdate();
      const d = r.deploy;
      const text = d.error ? T.serverError : d.restarted ? T.serverRestarted : d.restartNeeded ? T.serverNeedsRestartAfter : T.serverReloaded;
      const details = [d.error ? `error: ${d.error}` : "", ...r.warnings.map((w) => `warning: ${w}`), ...d.commands.map((c) => `> ${c.command}\n${c.response}`)].filter(Boolean).join("\n");
      this.showNotice(`🏠 ${T.updateDone} (v${r.version})`, text, details || undefined);
      await this.showAdmin();
    } catch (e) { this.showError(e); }
  }
}
