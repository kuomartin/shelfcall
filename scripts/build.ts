// 建置：gas/app 打包成一支 Apps Script 檔，web 打包成靜態頁，輸出到 dist/。
// `--dev` 時 __DEV__ 為 true，Apps Script 端多出端到端測試用的動作（gas/app/dev.ts）。
//
// Apps Script 只認得頂層函式宣告，而 esbuild 的 IIFE 會把 export 包進一個全域物件。
// 所以 gas/app/main.ts export 的每個函式，都在檔尾補一個同名的頂層轉呼叫函式。

import * as esbuild from "esbuild";
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";

const GLOBAL = "__shelfcall";
const dev = process.argv.includes("--dev");

async function buildGas(): Promise<void> {
  const outdir = "dist/gas/app";
  mkdirSync(outdir, { recursive: true });
  const common = {
    entryPoints: ["gas/app/main.ts"],
    bundle: true,
    target: "es2020",
    charset: "utf8",
    define: { __DEV__: String(dev) },
    minifySyntax: true,
    write: false,
  } satisfies esbuild.BuildOptions;
  // metafile 只在 ESM 輸出時列出 exports，所以先用 ESM 取得名單，再輸出 IIFE。
  const esm = await esbuild.build({ ...common, format: "esm", metafile: true });
  const exports = Object.values(esm.metafile!.outputs)[0].exports;
  const result = await esbuild.build({ ...common, format: "iife", globalName: GLOBAL });
  const stubs = exports
    .map((fn) => `function ${fn}() { return ${GLOBAL}.${fn}.apply(this, arguments); }`)
    .join("\n");
  writeFileSync(`${outdir}/Code.js`, `${result.outputFiles![0].text}\n${stubs}\n`);
  copyFileSync("gas/app/appsscript.json", `${outdir}/appsscript.json`);
}

async function buildWeb(): Promise<void> {
  // splitting：web/barcode.ts（含 ponyfill）拆成獨立 chunk，按下相機時才載入。
  await esbuild.build({
    entryPoints: ["web/main.ts"],
    bundle: true,
    format: "esm",
    splitting: true,
    target: "es2022",
    charset: "utf8",
    outdir: "dist/web",
    chunkNames: "chunks/[name]-[hash]",
    minify: true,
  });
  copyFileSync("web/index.html", "dist/web/index.html");
  // web/barcode.ts 的 ponyfill 從頁面同一個位置載入 wasm。
  copyFileSync("node_modules/zxing-wasm/dist/reader/zxing_reader.wasm", "dist/web/zxing_reader.wasm");
}

rmSync("dist", { recursive: true, force: true });
await Promise.all([buildGas(), buildWeb()]);
