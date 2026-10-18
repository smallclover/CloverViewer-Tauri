import {
  initializeWindowDecoration,
  listenWindowShellLayout,
  windowShellCaptureReady,
  type WindowShellLayout,
} from "../api";

/** 与原生端只交换物理像素；WebView 的 DPI 和界面缩放统一在这里换算。 */
export function shellCssValues(layout: WindowShellLayout, density: number) {
  const ratio = Number.isFinite(density) && density > 0 ? density : 1;
  return {
    "--shell-left": `${layout.insets.left / ratio}px`,
    "--shell-top": `${layout.insets.top / ratio}px`,
    "--shell-right": `${layout.insets.right / ratio}px`,
    "--shell-bottom": `${layout.insets.bottom / ratio}px`,
    "--art-width": `${layout.artworkWidth / ratio}px`,
    "--art-height": `${layout.artworkHeight / ratio}px`,
    "--shell-controls": `${layout.controlsWidth / ratio}px`,
  };
}

export async function initializeWindowShell(onError: (error: unknown) => void) {
  const root = document.documentElement;
  const images = ["back", "front"].map((layer) => {
    const image = document.createElement("img");
    image.id = `window-character-${layer}`;
    image.alt = "";
    image.draggable = false;
    image.setAttribute("aria-hidden", "true");
    document.body.append(image);
    return image;
  });
  const shadow = document.createElement("div");
  shadow.id = "window-contact-shadow";
  shadow.setAttribute("aria-hidden", "true");
  document.body.append(shadow);
  let current: WindowShellLayout | undefined;
  let captureRevision = 0;
  const render = (layout: WindowShellLayout) => {
    current = layout;
    root.dataset.shellStyle = layout.style;
    for (const [name, value] of Object.entries(shellCssValues(layout, window.devicePixelRatio))) {
      root.style.setProperty(name, value);
    }
    if (layout.style !== "off") {
      const src = `/window-decorations/${layout.style}.png`;
      for (const image of images) if (image.getAttribute("src") !== src) image.src = src;
    }
    const revision = ++captureRevision;
    if (layout.captureId !== null) {
      // 同一 WebView 完成绘制后才回执，后台不再与前端抢截图时机。
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          if (revision === captureRevision) {
            void windowShellCaptureReady(layout.captureId as number).catch(onError);
          }
        }),
      );
    }
  };
  const unlisten = await listenWindowShellLayout(render);
  const onResize = () => {
    if (current) render(current);
  };
  window.addEventListener("resize", onResize);
  window.addEventListener("beforeunload", () => {
    unlisten();
    window.removeEventListener("resize", onResize);
  });
  // 两种样式预解码；切换时不会先显示空挂件或错误的旧姿势。
  await Promise.all(
    ["lean", "peek"].map(async (style) => {
      const image = new Image();
      image.src = `/window-decorations/${style}.png`;
      await image.decode();
    }),
  );
  render(await initializeWindowDecoration());
}
