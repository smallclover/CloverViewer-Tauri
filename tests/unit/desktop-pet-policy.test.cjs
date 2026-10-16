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

test("desktop pet toggles and readiness stay quiet while load failures remain visible", async () => {
  const loadTs = require("./helpers/load-ts.cjs");
  let onStatus;
  let config = { desktop_pet_enabled: false };
  const notices = [], calls = [], hidden = new Set();
  const { createDesktopPetController } = loadTs("ui/desktop-pet-controller.ts", {
    "../api": {
      listenDesktopPetLoadStatus: async handler => { onStatus = handler; },
      setDesktopPetEnabled: async enabled => { calls.push(enabled); },
      requestDesktopPetLoadStatus: async () => {},
    },
  }, { window: {
    setTimeout: (callback, delay) => { if (delay === 150) setImmediate(callback); return 1; },
    clearTimeout() {},
  } });
  const controller = createDesktopPetController({
    status: { classList: { add: name => hidden.add(name), remove: name => hidden.delete(name), contains: name => hidden.has(name) } },
    statusText: { dataset: {} }, getConfig: () => config, setCurrentConfig: next => { config = next; },
    translate: key => key, toast: (message, kind) => notices.push({ message, kind }),
  });
  await controller.setEnabled(true);
  onStatus({ state: "started", sessionId: "one" });
  onStatus({ state: "ready", sessionId: "one" });
  await controller.setEnabled(false);
  assert.deepEqual(calls, [true, false]);
  assert.deepEqual(notices, []);
  await controller.setEnabled(true);
  onStatus({ state: "started", sessionId: "two" });
  onStatus({ state: "failed", sessionId: "two" });
  assert.deepEqual(notices, [{ message: "toast.desktopPetLoadFailed", kind: "error" }]);
});
