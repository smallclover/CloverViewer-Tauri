import type { OcrLine, OcrPoint } from "../../api";
import { intersectsRect } from "../../ocr/geometry";
import { boundsOf } from "../../ocr/layout";
import { keysFor, toggleUnit, unitsFor, type OcrSession, type OcrUnit } from "../../ocr/selection";

export function createOcrImageOverlay(options: {
  stage: HTMLElement;
  getImage: () => HTMLImageElement;
  panImage: (x: number, y: number) => void;
  changed: () => void;
  locate: (unit: OcrUnit) => void;
  hover: (unit: OcrUnit | null) => void;
}) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.classList.add("ocr-image-overlay");
  svg.setAttribute("aria-hidden", "true");
  const labels = document.createElement("div");
  labels.className = "ocr-image-labels";
  const marquee = document.createElement("div");
  marquee.className = "ocr-marquee";
  marquee.hidden = true;
  options.stage.append(svg, labels, marquee);
  let session: OcrSession | undefined;
  let imagePath: string | undefined;
  const pathKey = (path: string) => path.replace(/\\/g, "/").toLowerCase();
  let byLine = false;
  let browsing = false;
  let visible = false;
  let space = false;
  let hovered: OcrUnit | null = null;
  const polygons = new Map<string, SVGPolygonElement>();
  let drag: {
    id: number;
    start: OcrPoint;
    end: OcrPoint;
    before: Set<string>;
    additive: boolean;
    unit?: OcrUnit;
    moved: boolean;
    transform: string;
  } | null = null;
  const selectable = () => !!session?.document?.lines.length && !browsing && !space && visible;
  const unitFor = (line: OcrLine) =>
    session && unitsFor(session, byLine).find((unit) => unit.lines.includes(line));
  const unitAt = (event: PointerEvent) => {
    const id = (event.target as Element).closest("[data-line]")?.getAttribute("data-line");
    const line = session?.document?.lines.find((line) => line.id === id);
    return line ? unitFor(line) : undefined;
  };
  const clearCapture = () => {
    const previous = drag;
    drag = null;
    marquee.hidden = true;
    if (previous && options.stage.hasPointerCapture(previous.id))
      options.stage.releasePointerCapture(previous.id);
  };
  const cancel = () => {
    if (!drag || !session) return false;
    session.selected = drag.before;
    clearCapture();
    options.changed();
    return true;
  };
  const point = (event: PointerEvent) => ({ x: event.clientX, y: event.clientY });
  const screenQuad = (line: OcrLine) => {
    const matrix = svg.getScreenCTM();
    return matrix ? line.quad.map((p) => new DOMPoint(p.x, p.y).matrixTransform(matrix)) : [];
  };
  const update = () => {
    const image = options.getImage();
    if (drag && drag.transform !== image.style.transform) cancel();
    const doc = session?.document;
    visible =
      !!doc &&
      image.naturalWidth === doc.imageWidth &&
      image.naturalHeight === doc.imageHeight &&
      (!imagePath || pathKey(image.dataset.imagePath ?? "") === pathKey(imagePath));
    svg.style.display = visible ? "" : "none";
    labels.hidden = !visible;
    options.stage.classList.toggle("ocr-selecting", selectable());
    if (!doc || !visible) return;
    svg.setAttribute("width", String(doc.imageWidth));
    svg.setAttribute("height", String(doc.imageHeight));
    svg.setAttribute("viewBox", `0 0 ${doc.imageWidth} ${doc.imageHeight}`);
    svg.style.transform = image.style.transform;
    for (const line of doc.lines) {
      const polygon = polygons.get(line.id);
      polygon?.classList.toggle("selected", !!session?.selected.has(line.id));
      polygon?.classList.toggle("hovered", !!hovered?.lines.includes(line));
    }
    labels.replaceChildren();
    const stageRect = options.stage.getBoundingClientRect();
    if (session)
      for (const [index, unit] of unitsFor(session, byLine).entries()) {
        if (
          !unit.lines.length ||
          (!keysFor(unit.block, unit.lines).some((key) => session?.selected.has(key)) &&
            hovered?.id !== unit.id)
        )
          continue;
        const points = unit.lines.flatMap(screenQuad);
        if (!points.length) continue;
        const bounds = boundsOf(points);
        const label = document.createElement("span");
        label.textContent = String(index + 1).padStart(2, "0");
        label.style.left = `${bounds.x - stageRect.left}px`;
        label.style.top = `${bounds.y - stageRect.top - 18}px`;
        labels.append(label);
      }
  };
  options.stage.addEventListener("pointerdown", (event) => {
    if (!selectable() || event.button !== 0 || (event.target as Element).closest("button")) return;
    if (drag) return;
    event.preventDefault();
    window.getSelection()?.removeAllRanges();
    options.stage.tabIndex = -1;
    options.stage.focus({ preventScroll: true });
    const start = point(event);
    drag = {
      id: event.pointerId,
      start,
      end: start,
      before: new Set(session?.selected),
      additive: event.ctrlKey || event.metaKey,
      unit: unitAt(event),
      moved: false,
      transform: options.getImage().style.transform,
    };
    options.stage.setPointerCapture(event.pointerId);
  });
  const move = (event: PointerEvent) => {
    if (!drag) {
      if (selectable()) options.hover(unitAt(event) ?? null);
      return;
    }
    if (drag.id !== event.pointerId || !session) return;
    drag.end = point(event);
    if (Math.hypot(drag.end.x - drag.start.x, drag.end.y - drag.start.y) > 4) drag.moved = true;
    if (!drag.moved) return;
    const rect = options.stage.getBoundingClientRect();
    marquee.hidden = false;
    Object.assign(marquee.style, {
      left: `${Math.min(drag.start.x, drag.end.x) - rect.left}px`,
      top: `${Math.min(drag.start.y, drag.end.y) - rect.top}px`,
      width: `${Math.abs(drag.end.x - drag.start.x)}px`,
      height: `${Math.abs(drag.end.y - drag.start.y)}px`,
    });
    session.selected = new Set(drag.additive ? drag.before : []);
    for (const line of session.document?.lines ?? []) {
      const quad = screenQuad(line);
      if (quad.length && intersectsRect(quad, drag.start, drag.end)) {
        const block = session.blocks.find((block) => block.lines.includes(line));
        for (const key of block && session.edits.has(block.id) ? keysFor(block) : [line.id])
          session.selected.add(key);
      }
    }
    options.changed();
  };
  options.stage.addEventListener("pointermove", move);
  options.stage.addEventListener("pointerup", (event) => {
    if (!drag || drag.id !== event.pointerId || !session) return;
    move(event);
    const ended = drag;
    if (!ended.moved) {
      if (ended.unit) {
        toggleUnit(session, ended.unit, ended.additive);
        options.locate(ended.unit);
      } else if (!ended.additive) session.selected.clear();
    }
    clearCapture();
    options.changed();
  });
  options.stage.addEventListener("pointercancel", (event) => {
    if (drag?.id === event.pointerId) cancel();
  });
  options.stage.addEventListener("lostpointercapture", (event) => {
    if (drag?.id === event.pointerId) cancel();
  });
  options.stage.addEventListener("pointerleave", () => {
    if (!drag) options.hover(null);
  });
  options.stage.addEventListener("wheel", cancel, { capture: true });
  options.stage.addEventListener(
    "dblclick",
    (event) => {
      if (selectable()) event.stopImmediatePropagation();
    },
    true,
  );
  window.addEventListener("keydown", (event) => {
    if (
      !session ||
      event.code !== "Space" ||
      (event.target as Element).closest("input,textarea,button,select")
    )
      return;
    cancel();
    space = true;
    update();
    event.preventDefault();
  });
  window.addEventListener("keyup", (event) => {
    if (event.code === "Space") {
      space = false;
      update();
    }
  });
  window.addEventListener("blur", () => {
    cancel();
    space = false;
    update();
  });
  return {
    show(next: OcrSession | undefined, path?: string) {
      cancel();
      session = next;
      imagePath = path;
      space = false;
      hovered = null;
      polygons.clear();
      svg.replaceChildren();
      for (const line of next?.document?.lines ?? []) {
        const polygon = document.createElementNS(ns, "polygon");
        polygon.dataset.line = line.id;
        polygon.setAttribute("points", line.quad.map((p) => `${p.x},${p.y}`).join(" "));
        polygon.setAttribute("vector-effect", "non-scaling-stroke");
        svg.append(polygon);
        polygons.set(line.id, polygon);
      }
      update();
    },
    setMode(lines: boolean, browse: boolean) {
      cancel();
      byLine = lines;
      browsing = browse;
      update();
    },
    hover(unit: OcrUnit | null) {
      hovered = unit;
      update();
    },
    canPan: (event: MouseEvent) => !selectable() || event.button === 1,
    allowFitPan: () => space && !!session,
    reveal(unit: OcrUnit) {
      if (!visible) return;
      const points = unit.lines.flatMap(screenQuad);
      if (!points.length) return;
      const bounds = boundsOf(points),
        stage = options.stage.getBoundingClientRect();
      const x = (bounds.x + bounds.right) / 2,
        y = (bounds.y + bounds.bottom) / 2;
      if (
        x < stage.left + 20 ||
        x > stage.right - 20 ||
        y < stage.top + 20 ||
        y > stage.bottom - 20
      )
        options.panImage(stage.left + stage.width / 2 - x, stage.top + stage.height / 2 - y);
    },
    update,
    cancel,
  };
}
