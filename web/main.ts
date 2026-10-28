// 掃描頁：選定保管人後連續刷書。書目快取本機判定、先回應再背景同步、離線禁止刷書。

import type { ApiRequest, ApiResponse, BootstrapResult, SyncResult } from "../core/api.ts";
import { DEFAULT_HOLDER } from "../core/books.ts";
import { connectivity, Shelf, SyncClient, type Connectivity, type Outcome } from "../core/client.ts";
import type { Transfer } from "../core/sync.ts";
import { beep } from "./sound.ts";

const BUSY_INTERVAL_MS = 3_000;
const IDLE_INTERVAL_MS = 10_000;
const ENQUEUE_DELAY_MS = 500;
const CAMERA_REPEAT_MS = 3_000;
const RECENT_LIMIT = 50;

const params = new URLSearchParams(location.hash.slice(1));
const deployId = params.get("id");
const endpoint = deployId ? `https://script.google.com/macros/s/${deployId}/exec` : "";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const ui = {
  holder: $<HTMLSelectElement>("holder"),
  status: $("status"),
  pending: $("pending"),
  form: $<HTMLFormElement>("form"),
  input: $<HTMLInputElement>("input"),
  camera: $<HTMLButtonElement>("camera"),
  video: $<HTMLVideoElement>("video"),
  result: $("result"),
  recent: $<HTMLOListElement>("recent"),
  theme: $<HTMLButtonElement>("theme"),
};

function load(key: string): string | null {
  try {
    return localStorage.getItem(`shelfcall.${key}`);
  } catch {
    return null;
  }
}

function store(key: string, value: string): void {
  try {
    localStorage.setItem(`shelfcall.${key}`, value);
  } catch {
    // 無痕模式等情況存不了，只影響下次開頁。
  }
}

type Theme = "auto" | "light" | "dark";
const THEMES: Theme[] = ["auto", "light", "dark"];
const THEME_LABEL: Record<Theme, string> = { auto: "外觀：自動", light: "外觀：淺色", dark: "外觀：深色" };

function applyTheme(theme: Theme): void {
  if (theme === "auto") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  ui.theme.textContent = THEME_LABEL[theme];
}

let theme: Theme = THEMES.includes(load("theme") as Theme) ? (load("theme") as Theme) : "auto";
applyTheme(theme);
ui.theme.addEventListener("click", () => {
  theme = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
  applyTheme(theme);
  store("theme", theme);
});

function deviceId(): string {
  const id = load("deviceId") ?? `dev-${crypto.randomUUID().slice(0, 8)}`;
  store("deviceId", id);
  return id;
}

async function call<T>(body: ApiRequest): Promise<T> {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as ApiResponse<T>;
  if (!json.ok) throw new Error(json.error);
  return json.data;
}

/** 最近刷過的一筆。move 帶著移交，可以復原；undone 表示已經被復原過。 */
interface Recent {
  at: number;
  outcome: Outcome;
  undone?: boolean;
}

const client = new SyncClient(deviceId());
const shelf = new Shelf();
let catalogVersion: string | null = null;
const recent: Recent[] = [];
let lastSuccessAt: number | null = null;
let lastFailureAt: number | null = null;
let lastError = "";
let inFlightSince: number | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;

function state(): Connectivity {
  return connectivity({ now: Date.now(), online: navigator.onLine, lastSuccessAt, lastFailureAt, inFlightSince });
}

function showResult(kind: "ok" | "error" | "info" | "warn", text: string): void {
  ui.result.className = `result ${kind}`;
  ui.result.textContent = text;
}

function renderStatus(): void {
  const s = state();
  const label = { ok: "同步正常", delayed: "同步延遲，照常刷書", offline: "離線，禁止刷書" }[s];
  ui.status.className = `status ${s}`;
  ui.status.textContent = s === "offline" && lastError ? `${label}（${lastError}）` : label;
  const n = client.pending().length;
  ui.pending.textContent = n ? `未送出 ${n} 筆` : "";
}

function clock(at: number): string {
  return new Date(at).toLocaleTimeString("zh-TW", { hour12: false });
}

function describe(o: Outcome): string {
  switch (o.kind) {
    case "move":
      return `${o.title}　${o.transfer.from || "（空白）"} → ${o.transfer.to}`;
    case "here":
      return `${o.title}　已在${o.holder}`;
    case "unknown":
      return `找不到條碼 ${o.code}`;
    case "moved-since":
      return `${o.title}　已被移到${o.holder}，無法復原`;
  }
}

function renderRecent(): void {
  ui.recent.replaceChildren(
    ...recent.map((r) => {
      const li = document.createElement("li");
      const kind = r.outcome.kind === "moved-since" ? "refused" : r.outcome.kind;
      li.className = r.undone ? `${kind} undone` : kind;
      const span = document.createElement("span");
      span.textContent = `${clock(r.at)}　${describe(r.outcome)}${r.undone ? "（已復原）" : ""}`;
      li.append(span);
      if (r.outcome.kind === "move" && !r.undone) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = "復原";
        button.addEventListener("click", () => undo(r));
        li.append(button);
      }
      return li;
    }),
  );
}

function render(): void {
  renderStatus();
  renderRecent();
}

function applyBootstrap(data: BootstrapResult): void {
  shelf.load(data.catalog, client.entries());
  catalogVersion = data.catalog.version;
  const previous = ui.holder.value || load("holder") || DEFAULT_HOLDER;
  ui.holder.replaceChildren(...data.holders.map((h) => new Option(h, h)));
  ui.holder.value = data.holders.includes(previous) ? previous : DEFAULT_HOLDER;
}

async function refreshBootstrap(): Promise<void> {
  applyBootstrap(await call<BootstrapResult>({ action: "bootstrap" }));
}

/** 有待送移交或離線時用短間隔：離線時要盡快恢復，不能等閒置間隔。 */
function schedule(delay?: number): void {
  clearTimeout(timer);
  const busy = client.pending().length > 0 || state() === "offline";
  timer = setTimeout(syncOnce, delay ?? (busy ? BUSY_INTERVAL_MS : IDLE_INTERVAL_MS));
}

async function syncOnce(): Promise<void> {
  if (inFlightSince !== null) return;
  inFlightSince = Date.now();
  renderStatus();
  try {
    const res = await call<SyncResult>({ action: "sync", ...client.request() });
    client.receive(res);
    shelf.apply(res.entries);
    lastSuccessAt = Date.now();
    lastError = "";
    if (res.catalogVersion !== catalogVersion) await refreshBootstrap();
  } catch (err) {
    lastFailureAt = Date.now();
    lastError = err instanceof Error ? err.message : String(err);
  } finally {
    inFlightSince = null;
    render();
    schedule();
  }
}

/** 記下結果、出聲、送進佇列。 */
function record(outcome: Outcome, at: number): void {
  recent.unshift({ at, outcome });
  recent.length = Math.min(recent.length, RECENT_LIMIT);
  const kind = outcome.kind === "move" ? "ok" : outcome.kind === "here" ? "warn" : "error";
  showResult(kind, describe(outcome));
  beep(outcome.kind === "move" ? "move" : outcome.kind === "here" ? "here" : "error");
  if (outcome.kind === "move") {
    client.enqueue(outcome.transfer);
    if (inFlightSince === null) schedule(ENQUEUE_DELAY_MS);
  }
  render();
}

function blockedOffline(): boolean {
  if (state() !== "offline") return false;
  showResult("error", "離線中，禁止刷書。請確認網路後再試。");
  beep("error");
  if (inFlightSince === null) schedule(0);
  return true;
}

function next(): { scanId: string; at: number } {
  return { scanId: crypto.randomUUID(), at: Date.now() };
}

function scan(raw: string): void {
  const code = raw.trim();
  if (!code || catalogVersion === null || blockedOffline()) return;
  const n = next();
  record(shelf.scan(code, ui.holder.value, client.pending(), n), n.at);
}

function undo(r: Recent): void {
  if (r.outcome.kind !== "move" || blockedOffline()) return;
  const original: Transfer = r.outcome.transfer;
  const n = next();
  const outcome = shelf.undo(original, client.pending(), n);
  if (outcome.kind === "move") r.undone = true;
  record(outcome, n.at);
}

ui.form.addEventListener("submit", (ev) => {
  ev.preventDefault();
  const value = ui.input.value;
  ui.input.value = "";
  scan(value);
});
ui.holder.addEventListener("change", () => {
  store("holder", ui.holder.value);
  showResult("info", `接下來刷的書會移到「${ui.holder.value}」。`);
  ui.input.focus();
});

interface Detector {
  detect(source: HTMLVideoElement): Promise<{ rawValue: string }[]>;
}
declare const BarcodeDetector:
  | { new (options: { formats: string[] }): Detector; getSupportedFormats(): Promise<string[]> }
  | undefined;

type Detect = (video: HTMLVideoElement) => Promise<string | null>;

/** 內建的 BarcodeDetector 支援全部所需格式才用；否則載入 ponyfill。 */
async function createDetector(): Promise<Detect> {
  const { FORMATS, WASM_FILE, createPonyfill } = await import("./barcode.ts");
  let detector: Detector;
  const supported = typeof BarcodeDetector === "undefined" ? [] : await BarcodeDetector.getSupportedFormats();
  if (typeof BarcodeDetector !== "undefined" && FORMATS.every((f) => supported.includes(f))) {
    detector = new BarcodeDetector({ formats: [...FORMATS] });
  } else {
    detector = createPonyfill(new URL(WASM_FILE, document.baseURI).href);
  }
  return async (video) => (await detector.detect(video).catch(() => []))[0]?.rawValue ?? null;
}

async function startCamera(): Promise<void> {
  const detect = await createDetector();
  const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
  ui.video.srcObject = stream;
  ui.video.hidden = false;
  ui.camera.textContent = "關閉相機";
  await ui.video.play();
  let last = { value: "", at: 0 };
  const loop = async () => {
    if (!ui.video.srcObject) return;
    const value = await detect(ui.video);
    if (value && !(value === last.value && Date.now() - last.at < CAMERA_REPEAT_MS)) {
      last = { value, at: Date.now() };
      scan(value);
    }
    setTimeout(loop, 250);
  };
  void loop();
}

function stopCamera(): void {
  (ui.video.srcObject as MediaStream | null)?.getTracks().forEach((t) => t.stop());
  ui.video.srcObject = null;
  ui.video.hidden = true;
  ui.camera.textContent = "相機";
}

ui.camera.hidden = !navigator.mediaDevices?.getUserMedia;
ui.camera.addEventListener("click", () => {
  if (ui.video.srcObject) stopCamera();
  else startCamera().catch((err) => showResult("error", `無法開啟相機：${err instanceof Error ? err.message : err}`));
});

async function main(): Promise<void> {
  if (!endpoint) {
    showResult("error", "連結缺少部署 ID，請向管理者取得正確的工作人員連結。");
    return;
  }
  setInterval(renderStatus, 1_000);
  try {
    showResult("info", "載入書目中…");
    await refreshBootstrap();
    lastSuccessAt = Date.now();
    showResult("info", `已載入 ${shelf.size} 冊。選好保管人就可以開始刷書。`);
  } catch (err) {
    lastFailureAt = Date.now();
    lastError = err instanceof Error ? err.message : String(err);
    showResult("error", `載入失敗：${lastError}`);
  }
  render();
  schedule(0);
  ui.input.focus();
}

void main();
