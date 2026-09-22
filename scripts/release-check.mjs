/**
 * 发版前机械预检：把「靠人记」的同步项变成一条命令。
 *
 * 用法：
 *   node scripts/release-check.mjs      # 等价于 npm run release:check
 *
 * 退出码：
 *   0 = 没有阻塞项（可能有提示项，需要人判断）
 *   1 = 存在阻塞项，不要继续发布
 *
 * 说明：
 * - 只读检查，不修改任何文件；不使用子进程，可在受限环境直接运行。
 * - 只覆盖 `npm run check` 管不到的部分（CHANGELOG 段落、三语同步、站点一致性）。
 *   版本号一致性仍由 `npm run check` 里的 version:check 负责。
 * - CHANGELOG 只记录已发布版本：一旦把 package.json 的版本进位，就必须已有该版本的
 *   段落，否则发布流水线只能生成兜底正文 —— 这就是本检查存在的意义。
 */

import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (rel) => readFile(path.join(root, rel), "utf8");
const readJson = async (rel) => JSON.parse(await read(rel));

const blockers = [];
const notes = [];
const passed = [];

/** 阻塞项：发布前必须修掉 */
function fail(label, detail, fix) {
  blockers.push({ label, detail, fix });
}

/** 提示项：需要人判断，不阻塞 */
function note(label, detail, fix) {
  notes.push({ label, detail, fix });
}

function ok(label, detail) {
  passed.push({ label, detail });
}

const RELATIVE_CANONICAL = "https://smallclover.github.io/CloverViewer-Tauri/";
const LOCALES = ["README.md", "README.en.md", "README.ja.md"];
const FEATURE_BULLET = /^\* {3}\*\*/gm;
const today = new Date().toLocaleDateString("sv-SE"); // YYYY-MM-DD（本地时区）

// ---------- 1. 版本号 ----------
const pkg = await readJson("package.json");
const version = pkg.version;
const semver =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
if (typeof version !== "string" || !semver.test(version)) {
  fail(
    "package.json 版本号",
    `不是合法 semver：${String(version)}`,
    "修正 package.json 的 version",
  );
} else {
  ok("package.json 版本号", version);
}

// ---------- 2. 版本号引用方式 ----------
try {
  const conf = await readJson("src-tauri/tauri.conf.json");
  if (conf.version === "../package.json") {
    ok("tauri.conf.json 版本引用", conf.version);
  } else {
    fail(
      "tauri.conf.json 版本引用",
      `应为 "../package.json"，实际是 ${JSON.stringify(conf.version)}`,
      '把 src-tauri/tauri.conf.json 的 version 改回 "../package.json"（版本号只允许有一个来源）',
    );
  }
} catch (error) {
  fail("src-tauri/tauri.conf.json", `无法解析：${error.message}`, "检查该文件是否为合法 JSON");
}

// ---------- 3. CHANGELOG 版本段落 ----------
const changelog = await read("CHANGELOG.md");
const lines = changelog.split(/\r?\n/);
const versionHeading = new RegExp(`^##\\s+v${version.replace(/\./g, "\\.")}(\\s|$)`);
const start = lines.findIndex((line) => versionHeading.test(line));

if (start < 0) {
  fail(
    "CHANGELOG 版本段落",
    `找不到 \`## v${version}\` 段落`,
    `在 CHANGELOG.md 顶部新增 \`## v${version} — <主题>\` 段落（本文件只记录已发布版本，发布流水线靠该段落生成 Release 正文）`,
  );
} else {
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^##\s/.test(lines[i])) {
      end = i;
      break;
    }
  }
  const body = lines.slice(start + 1, end);
  const subsections = body.filter((line) => /^###\s/.test(line));
  const contentLines = body.filter((line) => line.trim() && !/^---+$/.test(line.trim()));
  if (contentLines.length === 0) {
    fail("CHANGELOG 段落内容", `\`${lines[start].trim()}\` 段落是空的`, "补写该版本的用户可见变化");
  } else if (subsections.length === 0) {
    note(
      "CHANGELOG 段落结构",
      `\`${lines[start].trim()}\` 没有 \`###\` 小节`,
      "按既有格式补 `### 新增` / `### 改进与修复` 等小节，方便直接作为 Release 正文",
    );
  } else {
    ok(
      "CHANGELOG 版本段落",
      `${lines[start].trim()}（${subsections.length} 个小节，${contentLines.length} 行正文）`,
    );
  }
}

// ---------- 4. 三语 README 同步 ----------
const readmes = new Map();
for (const file of LOCALES) {
  try {
    readmes.set(file, await read(file));
  } catch {
    fail("三语 README", `读不到 ${file}`, "确认文件存在");
  }
}
if (readmes.size === LOCALES.length) {
  const stats = [...readmes].map(([file, text]) => ({
    file,
    h2: (text.match(/^## /gm) ?? []).length,
    h3: (text.match(/^### /gm) ?? []).length,
    bullets: (text.match(FEATURE_BULLET) ?? []).length,
  }));
  const base = stats[0];
  const drift = stats.filter(
    (s) => s.h2 !== base.h2 || s.h3 !== base.h3 || s.bullets !== base.bullets,
  );
  if (drift.length > 0) {
    const shape = (s) => `${s.file}: h2=${s.h2} h3=${s.h3} 特性条目=${s.bullets}`;
    fail(
      "三语 README 结构同步",
      `与 ${base.file} 不一致 —— ${[base, ...drift].map(shape).join(" / ")}`,
      "把缺失的标题或特性条目补到对应语言（用户可见文字必须三语同步）",
    );
  } else {
    ok("三语 README 结构同步", `h2=${base.h2} h3=${base.h3} 特性条目=${base.bullets}`);
  }
  for (const [file, text] of readmes) {
    const missing = LOCALES.filter((other) => other !== file && !text.includes(other));
    if (missing.length > 0) {
      fail("README 语言切换", `${file} 缺少指向 ${missing.join("、")} 的链接`, "补语言切换链接");
    }
  }
  ok("README 语言切换", "三份互相可达");
}

// ---------- 5. 介绍页与站点一致性 ----------
let canonical = null;
try {
  const html = await read("site/index.html");
  // 属性可能跨行书写，匹配时不能假设同一行内相邻
  const canonicalMatch = html.match(/<link[^>]*rel="canonical"[^>]*href="([^"]+)"/);
  canonical = canonicalMatch ? canonicalMatch[1] : null;
  const ogImage = html.match(/<meta[^>]*property="og:image"[^>]*content="([^"]+)"/);
  const ogUrl = html.match(/<meta[^>]*property="og:url"[^>]*content="([^"]+)"/);
  const ldBlocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];

  if (canonical === RELATIVE_CANONICAL) {
    ok("介绍页 canonical", canonical);
  } else {
    fail(
      "介绍页 canonical",
      `期望 ${RELATIVE_CANONICAL}，实际 ${canonical ?? "缺失"}`,
      "修正 site/index.html 的 canonical（换域名/仓库名时 canonical、og:url、sitemap、robots 要一起改）",
    );
  }

  if (!ogUrl) {
    fail(
      "介绍页 og:url",
      "缺少 og:url",
      `补 <meta property="og:url" content="${RELATIVE_CANONICAL}" />`,
    );
  } else if (ogUrl[1] !== RELATIVE_CANONICAL) {
    fail("介绍页 og:url", `${ogUrl[1]} 与 canonical 不一致`, `改成 ${RELATIVE_CANONICAL}`);
  } else {
    ok("介绍页 og:url", ogUrl[1]);
  }

  if (!ogImage) {
    fail("介绍页 og:image", "缺少 og:image", "补 og:image 指向 og-image.png 的绝对地址");
  } else if (ogImage[1] !== `${RELATIVE_CANONICAL}og-image.png`) {
    fail(
      "介绍页 og:image",
      `${ogImage[1]} 与 canonical 不同源`,
      `改成 ${RELATIVE_CANONICAL}og-image.png（分享预览图必须能被外部抓取到）`,
    );
  } else {
    ok("介绍页 og:image", ogImage[1]);
  }

  if (ldBlocks.length === 0) {
    fail("介绍页结构化数据", "没有 application/ld+json", "补 SoftwareApplication 与 FAQPage");
  } else {
    let valid = 0;
    for (const [index, block] of ldBlocks.entries()) {
      try {
        const parsed = JSON.parse(block[1]);
        if (!parsed["@type"]) throw new Error("缺少 @type");
        valid += 1;
      } catch (error) {
        fail(
          "介绍页结构化数据",
          `第 ${index + 1} 段 JSON-LD 有问题：${error.message}`,
          "修正该段 JSON（多余逗号是最常见原因）",
        );
      }
    }
    if (valid === ldBlocks.length) {
      ok("介绍页结构化数据", `${valid} 段，均可解析且带 @type`);
    }
  }

  const assets = ["site/styles.css", "site/logo.png", "site/og-image.png"];
  const missing = [];
  for (const asset of assets) {
    try {
      await access(path.join(root, asset));
    } catch {
      missing.push(asset);
    }
  }
  if (missing.length > 0) {
    fail("介绍页资源", `缺少 ${missing.join("、")}`, "补齐站点资源（Pages 只发布 site/ 目录）");
  } else {
    ok("介绍页资源", assets.join("、"));
  }
} catch {
  fail("site/index.html", "读不到介绍页", "确认 site/ 目录完整");
}

// ---------- 6. sitemap / robots ----------
try {
  const sitemap = await read("site/sitemap.xml");
  const loc = sitemap.match(/<loc>([^<]+)<\/loc>/);
  const lastmod = sitemap.match(/<lastmod>([^<]+)<\/lastmod>/);
  if (!loc || loc[1] !== canonical) {
    fail(
      "sitemap <loc>",
      `期望 ${canonical}，实际 ${loc ? loc[1] : "缺失"}`,
      "修正 site/sitemap.xml 的 <loc>，保持与 canonical 完全一致",
    );
  } else {
    ok("sitemap <loc>", loc[1]);
  }
  if (!lastmod || !/^\d{4}-\d{2}-\d{2}$/.test(lastmod[1])) {
    fail("sitemap <lastmod>", `不是 YYYY-MM-DD：${lastmod ? lastmod[1] : "缺失"}`, "补合法日期");
  } else if (lastmod[1] > today) {
    fail("sitemap <lastmod>", `${lastmod[1]} 在未来`, `改成 ${today}`);
  } else if (lastmod[1] !== today) {
    note(
      "sitemap <lastmod>",
      `仍是 ${lastmod[1]}（今天 ${today}）`,
      `本次发布若改动了介绍页内容，把 <lastmod> 改成 ${today}`,
    );
  } else {
    ok("sitemap <lastmod>", lastmod[1]);
  }

  const robots = await read("site/robots.txt");
  if (robots.includes(`Sitemap: ${canonical}sitemap.xml`)) {
    ok("robots.txt", "已声明 sitemap");
  } else {
    fail(
      "robots.txt",
      "没有声明 sitemap 或地址不一致",
      `补一行 \`Sitemap: ${canonical}sitemap.xml\``,
    );
  }
} catch {
  fail("site/sitemap.xml", "读不到站点地图", "确认 site/sitemap.xml 与 site/robots.txt 存在");
}

// ---------- 7. 发布与安全前置 ----------
try {
  const gitignore = await read(".gitignore");
  if (/^\.tauri$/m.test(gitignore)) {
    ok(".gitignore", "已忽略 .tauri（签名私钥不会被提交）");
  } else {
    fail(
      ".gitignore",
      "没有忽略 .tauri",
      "立刻确认 .tauri/cloverviewer.key 未被提交，并把 .tauri 加回 .gitignore",
    );
  }
} catch {
  fail(".gitignore", "读不到 .gitignore", "确认仓库根目录存在 .gitignore");
}

try {
  await read(".github/workflows/pages.yml");
  ok("Pages 工作流", ".github/workflows/pages.yml");
} catch {
  note("Pages 工作流", "缺少 .github/workflows/pages.yml", "若已停用介绍页可忽略");
}

// ---------- 输出 ----------
const mark = { pass: "[OK]  ", note: "[WARN]", fail: "[FAIL]" };
const print = (entry, kind) => {
  console.log(`${mark[kind]} ${entry.label}`);
  if (entry.detail) console.log(`       ${entry.detail}`);
  if (kind !== "pass" && entry.fix) console.log(`       修复：${entry.fix}`);
};

console.log(`\n发版前机械预检（目标版本 v${version}）\n${"=".repeat(60)}`);
for (const entry of passed) print(entry, "pass");
for (const entry of notes) print(entry, "note");
for (const entry of blockers) print(entry, "fail");
console.log("=".repeat(60));
console.log(`通过 ${passed.length} 项，提示 ${notes.length} 项，阻塞 ${blockers.length} 项`);

if (blockers.length > 0) {
  console.log("\n存在阻塞项，先修掉再发布。\n");
  process.exit(1);
}

console.log(`
仍需人工完成（AI 不能代替）：
  [ ] Settings → Pages → Source = GitHub Actions
  [ ] 仓库首页 About：Description / Website / Topics（文案见 docs/seo.md）
  [ ] Settings → General → Social preview：上传 site/og-image.png
  [ ] Search Console：提交 sitemap.xml、请求编入索引（可选）
  [ ] 推标签前最后确认：本次版本号与 CHANGELOG 主题是否符合预期

下一步：./publish-release.ps1 -Tag v${version}
`);
