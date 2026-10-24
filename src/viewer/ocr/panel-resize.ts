/** Session-only panel width; pointer cancellation restores the starting width. */
export function createOcrPanelResize(panel: HTMLElement, layout: () => void) {
  const handle = document.createElement("div");
  handle.className = "ocr-panel-resize";
  handle.tabIndex = 0;
  handle.setAttribute("role", "separator");
  handle.setAttribute("aria-orientation", "vertical");
  handle.setAttribute("aria-valuemin", "300");
  handle.setAttribute("aria-valuemax", "440");
  let width = 340;
  let drag: { id: number; x: number; width: number } | null = null;
  const set = (next: number) => {
    width = Math.min(440, Math.max(300, next));
    panel.style.setProperty("--ocr-panel-width", `${width}px`);
    handle.setAttribute("aria-valuenow", String(Math.round(width)));
    layout();
  };
  const end = () => {
    const previous = drag;
    drag = null;
    if (previous && handle.hasPointerCapture(previous.id))
      handle.releasePointerCapture(previous.id);
  };
  const cancel = () => {
    if (!drag) return false;
    const before = drag.width;
    end();
    set(before);
    return true;
  };
  handle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || drag) return;
    event.preventDefault();
    drag = { id: event.pointerId, x: event.clientX, width };
    handle.setPointerCapture(event.pointerId);
  });
  handle.addEventListener("pointermove", (event) => {
    if (drag?.id === event.pointerId) set(drag.width + drag.x - event.clientX);
  });
  handle.addEventListener("pointerup", (event) => {
    if (drag?.id !== event.pointerId) return;
    set(drag.width + drag.x - event.clientX);
    end();
  });
  handle.addEventListener("pointercancel", cancel);
  handle.addEventListener("lostpointercapture", cancel);
  handle.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    set(
      event.key === "Home"
        ? 300
        : event.key === "End"
          ? 440
          : width + (event.key === "ArrowLeft" ? 10 : -10),
    );
  });
  window.addEventListener("blur", cancel);
  handle.setAttribute("aria-valuenow", String(width));
  panel.prepend(handle);
  return { cancel, setLabel: (label: string) => handle.setAttribute("aria-label", label) };
}
