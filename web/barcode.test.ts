import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { prepareZXingModule } from "barcode-detector/ponyfill";
import { prepareZXingModule as prepareWriter, writeBarcode } from "zxing-wasm/writer";
import { createPonyfill, FORMATS, WASM_FILE } from "./barcode.ts";

// ponyfill 回傳的 boundingBox 用到 DOMRectReadOnly，Node 沒有。
(globalThis as Record<string, unknown>).DOMRectReadOnly ??= class {
  static fromRect(r: { x?: number; y?: number; width?: number; height?: number } = {}) {
    return { ...r };
  }
};

const wasm = (dir: string, file: string) => readFileSync(new URL(`../node_modules/zxing-wasm/dist/${dir}/${file}`, import.meta.url));

let detector: ReturnType<typeof createPonyfill>;

before(() => {
  detector = createPonyfill("unused-in-node");
  // Node 的 fetch 讀不了本機檔案，直接把 wasm 內容交給模組。
  prepareZXingModule({ overrides: { wasmBinary: wasm("reader", WASM_FILE) }, fireImmediately: true });
  prepareWriter({ overrides: { wasmBinary: wasm("writer", "zxing_writer.wasm") }, fireImmediately: true });
});

async function decode(image: Blob): Promise<Array<[string, string]>> {
  return (await detector.detect(image)).map((b) => [b.format, b.rawValue]);
}

for (const [format, name] of [
  ["Code128", "code_128"],
  ["Code39", "code_39"],
  ["QRCode", "qr_code"],
] as const) {
  test(`decodes ${name}`, async () => {
    const { image } = await writeBarcode("T0777", { format, scale: 2 });
    assert.deepEqual(await decode(image!), [[name, "T0777"]]);
  });
}

test("decodes non-ASCII QR content", async () => {
  const { image } = await writeBarcode("學員A001", { format: "QRCode", scale: 2 });
  assert.deepEqual(await decode(image!), [["qr_code", "學員A001"]]);
});

test("decodes a real Code 128 attendee label", async () => {
  const png = readFileSync(new URL("./fixtures/t0777-code128.png", import.meta.url));
  assert.deepEqual(await decode(new Blob([png])), [["code_128", "T0777"]]);
});

test("ignores formats outside the list", async () => {
  const { image } = await writeBarcode("4711234567899", { format: "EAN13", scale: 2 });
  assert.deepEqual(await decode(image!), []);
});

test("the format list covers QR and the common 1D attendee barcodes", () => {
  assert.deepEqual([...FORMATS], ["qr_code", "code_128", "code_39"]);
});
