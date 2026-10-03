const assert = require("node:assert/strict");
const test = require("node:test");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { runInNewContext } = require("node:vm");
const ts = require("typescript");

function setup() {
  const elements = [];
  const timers = [];
  const shapes = [];
  let focused = false;
  let rootWidth = 960;
  let rootHeight = 540;
  const context = { measureText: text => ({ width: text.length * 16 }) };
  const style = { color: "#f00", strokeWidth: 2, fontSize: 32 };
  const source = readFileSync(resolve(__dirname, "../../src/screenshot/text-input.ts"), "utf8");
  const exports = {};
  runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, {
    exports,
    document: { createElement: tag => {
      const classes = new Set();
      const listeners = {};
      const element = { tag, style: {}, value: "", scrollHeight: 0, children: [],
        get className() { return [...classes].join(" "); },
        set className(value) { classes.clear(); value.split(" ").forEach(name => classes.add(name)); },
        classList: { add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name) },
        appendChild: child => element.children.push(child),
        addEventListener: (name, handler) => { listeners[name] = handler; },
        fire: (name, event) => listeners[name]?.(event), focus: () => { focused = true; },
      };
      elements.push(element);
      return element;
    } },
    window: { addEventListener: () => {} },
    setTimeout: callback => timers.push(callback),
    require: () => require("../../.unit-test-dist/image-editor/annotation-style.js"),
  });
  const input = exports.createTextInputController({
    uiLayer: { appendChild: () => {} }, root: { getBoundingClientRect: () => ({ width: rootWidth, height: rootHeight }) },
    context, getCanvasSize: () => ({ width: 1920, height: 1080 }), getStyle: () => style,
    getScale: () => 1920 / rootWidth, getPrompt: () => "Enter annotation text:",
    onCommit: shape => shapes.push(shape), onRender: () => {},
  });
  const key = (overrides = {}) => {
    const event = { key: "Enter", isComposing: false, keyCode: 13, shiftKey: false, prevented: false,
      stopPropagation: () => {}, preventDefault() { this.prevented = true; }, ...overrides };
    input.element.fire("keydown", event);
    return event;
  };
  return { input, element: input.element, shapes, key, style,
    flush: () => { while (timers.length) timers.shift()(); }, focused: () => focused,
    resize: (width, height) => { rootWidth = width; rootHeight = height; },
  };
}

test("screenshot text grows and shrinks while keeping the same physical annotation origin", () => {
  const { input, element, shapes } = setup();
  input.show({ x: 100, y: 80 });
  assert.equal(element.style.width, "180px");
  assert.equal(element.style.height, "44px");
  assert.equal(element.wrap, "off");
  element.value = "Long text ".repeat(8) + "\nSecond line";
  element.fire("input");
  assert.ok(parseFloat(element.style.width) > 180);
  assert.ok(parseFloat(element.style.height) > 44);
  element.value = "中文";
  element.fire("input");
  assert.equal(element.style.width, "180px");
  assert.equal(element.style.height, "44px");
  input.commit();
  assert.equal(shapes[0].start.x, 100);
  assert.equal(shapes[0].start.y, 80);
  assert.equal(shapes[0].end.x, 132);
  input.show({ x: 300, y: 200 });
  assert.equal(element.value, "");
  assert.equal(element.style.width, "180px");
  assert.equal(element.style.height, "44px");
});

test("screenshot input at the screen edge stays visible and commits at its displayed origin", () => {
  const { input, element, shapes } = setup();
  input.show({ x: 1900, y: 1060 });
  element.value = "Long text ".repeat(12) + "\nSecond line\nThird line";
  element.fire("input");
  const left = parseFloat(element.style.left);
  const top = parseFloat(element.style.top);
  assert.ok(left + parseFloat(element.style.width) <= 952);
  assert.ok(top + parseFloat(element.style.height) <= 532);
  input.commit();
  assert.equal(shapes[0].start.x, (left + 9) * 2);
  assert.equal(shapes[0].start.y, (top + 7) * 2);
  assert.equal(shapes[0].fontSize, 32);
});

test("composition and explicit newlines stay editable; cancellation and session reset prevent late focus", () => {
  const fixture = setup();
  fixture.input.show({ x: 100, y: 80 });
  fixture.element.value = "中文\n第二行";
  for (const options of [{ isComposing: true }, { keyCode: 229 }, { shiftKey: true }]) {
    assert.equal(fixture.key(options).prevented, false);
    assert.equal(fixture.shapes.length, 0);
  }
  fixture.key({ key: "Escape" }); fixture.flush();
  assert.equal(fixture.focused(), false);
  assert.equal(fixture.element.classList.contains("editing"), false);
  fixture.input.commit();
  assert.equal(fixture.shapes.length, 0);
  fixture.input.show({ x: 100, y: 80 });
  fixture.element.classList.remove("editing"); fixture.flush();
  assert.equal(fixture.focused(), false);
  fixture.input.show({ x: 300, y: 200 }); fixture.flush();
  fixture.element.value = "中文\n第二行";
  fixture.key();
  assert.equal(fixture.shapes[0].text, "中文\n第二行");
});
