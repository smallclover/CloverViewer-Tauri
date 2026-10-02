const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const test = require("node:test");

test("packaged desktop pet can fetch its same-origin model, motions, core and shaders", () => {
  const config = JSON.parse(
    readFileSync(resolve(__dirname, "../../src-tauri/tauri.conf.json"), "utf8"),
  );
  const directives = new Map(
    config.app.security.csp
      .split(";")
      .map((directive) => directive.trim().split(/\s+/))
      .filter(([name]) => name)
      .map(([name, ...sources]) => [name, sources]),
  );
  // script-src 允许加载 core 脚本，但 fetch() 取模型仍受 connect-src 约束。
  const sources = directives.get("connect-src") ?? directives.get("default-src");
  assert.ok(sources.includes("'self'"), "Live2D fetches must be allowed on the app origin");
  assert.ok(sources.includes("ipc:"), "Tauri IPC must remain available");
  assert.ok(sources.includes("http://ipc.localhost"), "Windows IPC must remain available");
});
