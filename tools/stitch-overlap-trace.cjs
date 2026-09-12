// 离线复刻最终版 append_band / attach_footer（src-tauri/src/scroll_capture.rs）的拼接算式，
// 用「每行唯一编号」的合成页面验证：无重复段、无漏段、页头页脚各只出现一次、每步净增 = shift。
//
// 最终模型（这是踩了很多坑之后定下来的）：
//   画布 = 「吸顶页头 + 累积正文」，**不含吸底栏**；吸底栏收尾由 attach_footer 贴一次。
//   body_h    = h - header - footer
//   new_start = (body_h - shift) + header     // 本帧正文里最新的 shift 行（整帧下标）
//   画布全保留，追加 cur[new_start, h - footer)  → 画布净增恰好 shift
//
// 历史 bug（已修）：旧公式 append_y = h - footer - shift 使每步净增只有 shift - footer，
// 页脚一大净增≈0，画布永远超不过一帧 → 报「没有捕获到可拼接的内容」。

const HEADER = 40, FOOTER = 30, H = 300;
const bodyH = H - HEADER - FOOTER; // 230
const SHIFT = 100;
const STEPS = 3;

const headerRows = Array.from({ length: HEADER }, (_, i) => `H${i}`);
const footerRows = Array.from({ length: FOOTER }, (_, i) => `F${i}`);
const page = Array.from({ length: 2000 }, (_, i) => i);

/** 取一帧：吸顶页头 + 正文[scrollY, scrollY+bodyH) + 吸底页脚 */
function frame(scrollY) {
  const body = [];
  for (let y = 0; y < bodyH; y++) body.push(page[scrollY + y]);
  return [...headerRows, ...body, ...footerRows];
}

function appendBand(canvas, cur, header, footer, shift) {
  const bodyBottom = cur.length - footer;
  if (shift === 0) return [...canvas, ...cur.slice(0, bodyBottom)]; // 起始帧：页头 + 正文
  const body = cur.length - header - footer;
  const newStart = Math.max(0, body - shift) + header;
  return [...canvas, ...cur.slice(newStart, bodyBottom)];
}

function attachFooter(canvas, lastFrame, footer) {
  if (footer <= 0) return canvas;
  return [...canvas, ...lastFrame.slice(lastFrame.length - footer)];
}

const f0 = frame(0);
let canvas = appendBand([], f0, HEADER, FOOTER, 0);
console.log(`起始帧: 画布 ${canvas.length} 行 = 页头 ${HEADER} + 正文 ${bodyH}（不含页脚）`);
let last = f0;

let invariantOk = true;
for (let i = 1; i <= STEPS; i++) {
  const cur = frame(i * SHIFT);
  const before = canvas.length;
  canvas = appendBand(canvas, cur, HEADER, FOOTER, SHIFT);
  const grew = canvas.length - before;
  if (grew !== SHIFT) invariantOk = false;
  console.log(
    `第${i}帧 scrollY=${i * SHIFT} → 画布 ${before} → ${canvas.length}（净增 ${grew}，应为 ${SHIFT}）`
  );
  last = cur;
}
canvas = attachFooter(canvas, last, FOOTER);

const expected = [...headerRows, ...page.slice(0, bodyH + STEPS * SHIFT), ...footerRows];
console.log(`\n结果 ${canvas.length} 行，期望 ${expected.length} 行`);

let bad = -1;
for (let i = 0; i < Math.max(canvas.length, expected.length); i++) {
  if (canvas[i] !== expected[i]) { bad = i; break; }
}
if (!invariantOk) console.log("❌ 每步净增 ≠ shift（核心不变量被破坏）");
else if (bad < 0) console.log("✅ 无重复段、无漏段、页头页脚各一次，每步净增 = shift");
else console.log(`❌ 第 ${bad} 行：out=${canvas[bad]} expected=${expected[bad]}`);
