// 刷書結果的提示音：老師連刷時不必看螢幕。用 Web Audio 產生，不需要音檔。

export type Tone = "move" | "here" | "error";

/** [頻率 Hz, 長度 ms] 依序播放，中間停 60 ms。 */
const PATTERNS: Record<Tone, Array<[number, number]>> = {
  move: [[1320, 90]],
  here: [[880, 70], [880, 70]],
  error: [[220, 350]],
};

let ctx: AudioContext | null = null;

export function beep(tone: Tone): void {
  try {
    ctx ??= new AudioContext();
    let t = ctx.currentTime;
    for (const [freq, ms] of PATTERNS[tone]) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = tone === "error" ? "square" : "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.2, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + ms / 1000);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + ms / 1000);
      t += (ms + 60) / 1000;
    }
  } catch {
    // 瀏覽器不支援或尚未有使用者互動時沒有聲音，畫面仍會顯示結果。
  }
}
