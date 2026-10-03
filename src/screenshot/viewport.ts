/** 截图根节点固定铺满窗口；布局变化时才重新读取，避免笔刷移动触发同步布局。 */
export function createViewportBounds(element: HTMLElement) {
  let bounds: DOMRect | null = null;
  const invalidate = () => {
    bounds = null;
  };
  new ResizeObserver(invalidate).observe(element);
  window.addEventListener("resize", invalidate);
  return { get: () => (bounds ??= element.getBoundingClientRect()), invalidate };
}
