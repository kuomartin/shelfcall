// 試算表內的對話框，以及 Web App 的初始化頁。

import type { BookIssue } from "../../core/books.ts";

export const PAGES_URL = "https://kuomartin.github.io/shelfcall/";

export function staffUrl(deploymentId: string): string {
  return `${PAGES_URL}#id=${encodeURIComponent(deploymentId)}`;
}

function escape(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

const STYLE = `<style>
  body { font-family: system-ui, sans-serif; margin: 12px; line-height: 1.5; }
  textarea { width: 100%; box-sizing: border-box; font: inherit; padding: 6px; }
  button { font: inherit; padding: 6px 14px; margin-top: 8px; }
  table { border-collapse: collapse; width: 100%; font-size: 14px; }
  th, td { border-bottom: 1px solid #ddd; padding: 4px 6px; text-align: left; vertical-align: top; }
  .error { color: #c62828; } .ok { color: #2e7d32; }
  code { word-break: break-all; }
</style>`;

export const NEED_SETUP = `${STYLE}
<p>尚未取得部署 ID。請先「部署 → 新增部署作業」部署成網頁應用程式（執行身分：我；存取權：所有人），再用瀏覽器開一次網頁應用程式網址。</p>`;

export function setupPage(deploymentId: string | null): string {
  if (!deploymentId) return `${STYLE}<p class="error">無法取得部署 ID，請確認此專案已部署成網頁應用程式。</p>`;
  const url = staffUrl(deploymentId);
  return `${STYLE}
<p class="ok">已完成初始化。</p>
<p>工作人員連結：<br><a href="${escape(url)}" target="_top"><code>${escape(url)}</code></a></p>
<p>之後也可以在試算表選單「保管 → 工作人員連結」取得。</p>`;
}

export function staffLinkDialog(deploymentId: string): string {
  const url = staffUrl(deploymentId);
  return `${STYLE}
<p>把這個連結或 QR code 交給老師。知道連結的人就能移書。</p>
<p><a href="${escape(url)}" target="_blank"><code>${escape(url)}</code></a></p>
<div id="qr"></div>
<script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
<script>new QRCode(document.getElementById("qr"), { text: ${JSON.stringify(url)}, width: 240, height: 240 });</script>`;
}

export const SETTINGS_DIALOG = `${STYLE}
<label>保管人（用逗號分隔；「學校」一定會在清單裡）</label>
<textarea id="holders" rows="4"></textarea>
<button id="save">儲存</button>
<p id="msg"></p>
<script>
  const $ = (id) => document.getElementById(id);
  google.script.run.withSuccessHandler((h) => { $("holders").value = h.join(", "); }).loadHolders();
  $("save").addEventListener("click", () => {
    $("msg").textContent = "儲存中…";
    $("msg").className = "";
    google.script.run
      .withSuccessHandler((h) => {
        $("holders").value = h.join(", ");
        $("msg").textContent = "已儲存。開著的掃描頁會在下次同步時更新清單。";
        $("msg").className = "ok";
      })
      .withFailureHandler((e) => { $("msg").textContent = e.message; $("msg").className = "error"; })
      .storeHolders($("holders").value);
  });
</script>`;

const ISSUE_LIMIT = 500;

export function checkDialog(issues: BookIssue[]): string {
  if (!issues.length) return `${STYLE}<p class="ok">沒有發現問題。</p>`;
  const rows = issues
    .slice(0, ISSUE_LIMIT)
    .map((i) => `<tr><td>${i.row}</td><td>${escape(i.code)}</td><td>${escape(i.title)}</td><td>${escape(i.problem)}</td></tr>`)
    .join("");
  const more = issues.length > ISSUE_LIMIT ? `<p>只列出前 ${ISSUE_LIMIT} 筆，共 ${issues.length} 筆。</p>` : "";
  return `${STYLE}
<p>共 ${issues.length} 個問題。修正後再執行一次確認。</p>${more}
<table><tr><th>列</th><th>主條碼</th><th>書名</th><th>問題</th></tr>${rows}</table>`;
}
