const assert = require("node:assert/strict");
const test = require("node:test");
const loadTs = require("./helpers/load-ts.cjs");
const {createNavigationGuard} = loadTs("ui/navigation-guard.ts");
const {createDirectoryLoader} = loadTs("viewer/directory-loader.ts");
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve = a; reject = b; }); return {promise,resolve,reject}; };
test("navigation keeps edits on rejection and merges repeated requests into one confirmation", async () => {
  const confirmation = deferred(); let asks = 0; const committed = [];
  const guard = createNavigationGuard(() => { asks++; return confirmation.promise; });
  const first = guard.run(() => committed.push("drop"));
  const second = guard.run(() => committed.push("history"));
  confirmation.resolve(false);
  assert.equal(await first, false); assert.equal(await second, false);
  assert.equal(asks, 1); assert.deepEqual(committed, []);
});
test("only the latest navigation commits after accepting a shared confirmation", async () => {
  const confirmation = deferred(); const committed = [];
  const guard = createNavigationGuard(() => confirmation.promise);
  const first = guard.run(() => committed.push("old"));
  const second = guard.run(() => committed.push("latest"));
  confirmation.resolve(true); await first; await second;
  assert.deepEqual(committed, ["latest"]);
});
test("late and cancelled directory requests cannot replace the newest directory", async () => {
  const pending = new Map(); const commits = [], errors = [];
  const loader = createDirectoryLoader({load: dir => { const task = deferred(); pending.set(dir, task); return task.promise; },
    commit: dir => commits.push(dir), onError: error => errors.push(error)});
  const a = loader.open("A"), b = loader.open("B");
  pending.get("B").resolve([]); assert.equal(await b, true);
  pending.get("A").resolve([]); assert.equal(await a, false);
  const c = loader.open("C"); loader.cancel(); pending.get("C").reject(Error("old")); await c;
  assert.deepEqual(commits, ["B"]); assert.equal(errors.length, 0);
});
test("directory failures report failure instead of committing an empty or old directory", async () => {
  let committed = false, reported = false;
  const loader = createDirectoryLoader({load: async () => { throw Error("denied"); }, commit: () => {committed = true;}, onError: () => {reported = true;}});
  assert.equal(await loader.open("denied"), false); assert.equal(committed, false); assert.equal(reported, true);
});
test("history buttons go through the editing guard before mutating history", () => {
  const buttons = new Map(); const shown = []; let intent;
  const {createPageNavigationController} = loadTs("ui/page-navigation-controller.ts", {}, {
    document: {getElementById: id => { const node = {addEventListener: (_, handler) => {node.click = handler;}}; buttons.set(id,node); return node; }},
  });
  const navigation = createPageNavigationController({showViewer: index => shown.push(index), showSettings() {}, showAbout() {}, beforeNavigate: action => {intent = action;}});
  navigation.showImage(1); buttons.get("page-back").click();
  assert.deepEqual(shown, [1]); intent(); assert.deepEqual(shown, [1,null]);
});

test("the actual viewer Escape handlers consume a press only once", () => {
  const {readFileSync} = require("node:fs");
  const {runInNewContext} = require("node:vm");
  const ts = require("typescript");
  const source = readFileSync(require("node:path").resolve(__dirname, "../../src/main.ts"), "utf8");
  const ast = ts.createSourceFile("main.ts", source, ts.ScriptTarget.Latest, true);
  let backs = 0;
  const context = {viewerSession: {viewMode: "single"}, aboutController: {isOpen: () => false},
    settingsController: {isOpen: () => false, dismissUpdateIfOpen: () => false}, imageEditor: {isOpen: () => false},
    pageNavigation: {back: () => {backs++; return true;}}};
  const event = {key: "Escape", defaultPrevented: false, preventDefault() {this.defaultPrevented = true;}};
  for (const statement of ast.statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) continue;
    const call = statement.expression;
    if (call.expression.getText(ast) !== "window.addEventListener" || call.arguments[0]?.text !== "keydown") continue;
    const handler = ts.transpileModule(`const handler = ${call.arguments[1].getText(ast)}; handler;`, {}).outputText;
    runInNewContext(handler, context)(event);
  }
  assert.equal(backs, 1);
});

test("refresh requests share the directory generation and distinguish refresh from open", async () => {
  const pending=[];const commits=[];
  const loader=createDirectoryLoader({load:()=>new Promise(resolve=>pending.push(resolve)),commit:(dir,entries,refresh)=>commits.push({dir,refresh}),onError(){}});
  const refresh=loader.refresh("A"),open=loader.open("B");
  pending[0]([]);assert.equal(await refresh,false);pending[1]([]);await open;
  const latest=loader.refresh("B");pending[2]([]);await latest;
  assert.deepEqual(commits,[{dir:"B",refresh:false},{dir:"B",refresh:true}]);
});
test("refresh shortcuts prevent destructive page reload while editing", async () => {
  let handler,blocked=true,calls=0;
  const {bindDirectoryRefreshShortcut}=loadTs("viewer/refresh-shortcut.ts",{}, {window:{addEventListener:(_,fn)=>{handler=fn;}}});
  bindDirectoryRefreshShortcut({isBlocked:()=>blocked,refresh:async()=>{calls++;}});
  const event={key:"F5",preventDefault(){this.prevented=true;},stopImmediatePropagation(){}};
  handler(event);assert.equal(event.prevented,true);assert.equal(calls,0);
  blocked=false;handler(event);assert.equal(calls,1);
});

test("refresh remaps navigation history by file path when sorting changes indexes", () => {
  const shown=[];
  const {createPageNavigationController}=loadTs("ui/page-navigation-controller.ts",{}, {document:{getElementById:()=>({addEventListener(){}})}});
  const navigation=createPageNavigationController({showViewer:index=>shown.push(index),showSettings(){},showAbout(){}});
  navigation.showImage(0);navigation.showImage(1);
  navigation.remapImages(["a","b"],["b","a"]);navigation.back();
  assert.equal(shown.at(-1),1);
});

test("native window close awaits the edit guard and has narrowly scoped destroy permission",async()=>{
  let handler,allowed=false;
  const handle={onCloseRequested:async fn=>{handler=fn;},onResized:async()=>{},isMaximized:async()=>false};
  const {bindWindowChrome}=loadTs("ui/window-chrome.ts",{
    "@tauri-apps/api/window":{getCurrentWindow:()=>handle},"../i18n":{t:key=>key},
  },{document:{getElementById:()=>({dataset:{},addEventListener(){}}),querySelectorAll:()=>[],documentElement:{dataset:{}}}});
  bindWindowChrome(async()=>allowed);
  const first={preventDefault(){this.prevented=true;}};await handler(first);assert.equal(first.prevented,true);
  allowed=true;const second={preventDefault(){this.prevented=true;}};await handler(second);assert.equal(second.prevented,undefined);
  const permission=require("../../src-tauri/capabilities/main-close.json");
  assert.deepEqual(permission.windows,["main"]);assert(permission.permissions.includes("core:window:allow-destroy"));
});
