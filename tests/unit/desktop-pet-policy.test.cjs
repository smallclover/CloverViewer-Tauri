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
  // fetch() uses connect-src, even when script-src permits the core script.
  const sources = directives.get("connect-src") ?? directives.get("default-src");
  assert.ok(sources.includes("'self'"), "Live2D fetches must be allowed on the app origin");
  assert.ok(sources.includes("ipc:"), "Tauri IPC must remain available");
  assert.ok(sources.includes("http://ipc.localhost"), "Windows IPC must remain available");
});
