// 瀏覽器內建的 BarcodeDetector 不存在、或不支援所需格式時（Windows／Linux 的桌機 Chrome、Firefox），
// 改用 barcode-detector ponyfill（底層是 zxing-wasm）。main.ts 以動態 import 載入，手機用內建的就不會下載。
// wasm 由 GitHub Pages 自己提供（建置時複製到 dist/web），不依賴第三方 CDN。

import { BarcodeDetector, setZXingModuleOverrides } from "barcode-detector/ponyfill";

/** 學員證常見的條碼：QR code 與 Code 128／Code 39 一維條碼。 */
export const FORMATS = ["qr_code", "code_128", "code_39"] as const;

export const WASM_FILE = "zxing_reader.wasm";

export function createPonyfill(wasmUrl: string): BarcodeDetector {
  setZXingModuleOverrides({
    locateFile: (path: string, prefix: string) => (path.endsWith(".wasm") ? wasmUrl : prefix + path),
  });
  return new BarcodeDetector({ formats: [...FORMATS] });
}
