/**
 * Live2D Cubism 5 renderer for the desktop pet.
 *
 * Draws the exported model, plays its PSD2Live motion exports, and evaluates
 * physics through the official Live2D Web Framework.
 */
import { PetMotionPlayer } from "./motion-player";

const CORE_GLOBAL = "Live2DCubismCore";
const CORE_URL = "/live2d/live2dcubismcore.min.js";
const MODEL_URL = "/pet-model/clover-girl-2/clovergirl-2_v1.model3.json";
const SHADER_URL = "/live2d/shaders/";
// PSD2Live keeps broad invisible geometry around this character. Filling those
// raw bounds makes the visible pet much smaller than its window, so compensate
// at render time instead of expanding the transparent native window further.
const VISIBLE_MODEL_SCALE = 2;

type ModelDefinition = {
  FileReferences?: {
    Moc?: unknown;
    Textures?: unknown;
    Physics?: unknown;
    Motions?: Record<string, Array<{ File?: unknown }>>;
  };
};

type CubismModel = {
  getCanvasWidth(): number;
  getCanvasHeight(): number;
  getDrawableCount(): number;
  getDrawableVertices(index: number): Float32Array;
  setParameterValueById(id: unknown, value: number): void;
  update(): void;
  release(): void;
};

type CubismMoc = {
  createModel(): CubismModel | null;
  release(): void;
};

type CubismPhysics = {
  evaluate(model: CubismModel, deltaTimeSeconds: number): void;
  release(): void;
};

type CubismRenderer = {
  initialize(model: CubismModel): void;
  startUp(gl: WebGLRenderingContext | WebGL2RenderingContext): void;
  bindTexture(index: number, texture: WebGLTexture): void;
  setIsPremultipliedAlpha(enabled: boolean): void;
  setMvpMatrix(matrix: CubismMatrix): void;
  setRenderTargetSize(width: number, height: number): void;
  drawModel(shaderPath: string): void;
  release(): void;
};

type CubismMatrix = {
  scale(x: number, y: number): void;
  translate(x: number, y: number): void;
};

type ModelBounds = {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
};

type ActiveMotion = { name: string; beganAt: number };

type FrameworkModules = {
  createMoc(bytes: ArrayBuffer): CubismMoc | null;
  createPhysics(bytes: ArrayBuffer): CubismPhysics;
  createRenderer(width: number, height: number): CubismRenderer;
  createMatrix(): CubismMatrix;
  getId(id: string): unknown;
};

/** Manages one self-contained official Cubism Web Framework canvas. */
export class Live2DPetRenderer {
  private host?: HTMLElement;
  private canvas?: HTMLCanvasElement;
  private gl?: WebGLRenderingContext | WebGL2RenderingContext;
  private moc?: CubismMoc;
  private model?: CubismModel;
  private physics?: CubismPhysics;
  private renderer?: CubismRenderer;
  private texture?: WebGLTexture;
  private modules?: FrameworkModules;
  private motionPlayer?: PetMotionPlayer;
  private bounds?: ModelBounds;
  private resizeObserver?: ResizeObserver;
  private frameHandle?: number;
  private paused = false;
  private animationStartedAt = 0;
  private previousFrameAt = 0;
  private elapsedSeconds = 0;
  private celebrateUntil = 0;
  private activeMotion?: ActiveMotion;
  private nextNodAt = 0;
  private gazeTarget?: { x: number; y: number };
  private gaze = { x: 0, y: 0 };
  private firstFrameRendered = false;

  constructor(
    private readonly onFirstFrame?: () => void,
    private readonly onRenderFailure?: () => void,
  ) {}

  async mount(host: HTMLElement): Promise<boolean> {
    const definition = await loadModelDefinition();
    if (!definition || !(await resourceExists(CORE_URL)) || !(await loadCubismCore())) return false;

    try {
      const modules = await loadFramework();
      const mocUrl = resolveModelFile(definition, "Moc");
      const textureUrl = resolveFirstTexture(definition);
      const physicsUrl = resolveModelFile(definition, "Physics");
      if (!mocUrl || !textureUrl) return false;

      const [mocBytes, image, physicsBytes] = await Promise.all([
        fetchArrayBuffer(mocUrl),
        loadImage(textureUrl),
        physicsUrl ? fetchArrayBuffer(physicsUrl) : undefined,
      ]);
      const canvas = document.createElement("canvas");
      const gl = canvas.getContext("webgl", {
        alpha: true,
        premultipliedAlpha: true,
        preserveDrawingBuffer: false,
      });
      if (!gl) return false;

      const moc = modules.createMoc(mocBytes);
      const model = moc?.createModel();
      if (!moc || !model) {
        moc?.release();
        return false;
      }

      const renderer = modules.createRenderer(1, 1);
      renderer.initialize(model);
      renderer.startUp(gl);
      renderer.setIsPremultipliedAlpha(true);

      const texture = createTexture(gl, image);
      renderer.bindTexture(0, texture);

      this.host = host;
      this.canvas = canvas;
      this.gl = gl;
      this.moc = moc;
      this.model = model;
      this.renderer = renderer;
      this.texture = texture;
      this.modules = modules;
      this.motionPlayer = await PetMotionPlayer.load(definition.FileReferences?.Motions, (path) =>
        resolveReferencedFile(path),
      );
      this.physics = physicsBytes ? modules.createPhysics(physicsBytes) : undefined;
      this.bounds = getModelBounds(model);
      host.replaceChildren(canvas);
      this.resizeObserver = new ResizeObserver(() => this.resizeCanvas());
      this.resizeObserver.observe(host);
      this.animationStartedAt = performance.now();
      this.previousFrameAt = this.animationStartedAt;
      this.elapsedSeconds = 0;
      this.nextNodAt = this.animationStartedAt + 7_000 + Math.random() * 5_000;
      this.resizeCanvas();
      this.requestFrame();
      return true;
    } catch {
      this.destroy();
      return false;
    }
  }

  async celebrate(): Promise<void> {
    if (!this.model) return;
    this.celebrateUntil = performance.now() + 1_100;
    this.playMotion("Shake");
  }

  /** Receives the current system cursor relative to the pet window's centre. */
  setGazeTarget(position: { x: number; y: number } | undefined): void {
    this.gazeTarget = position;
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
    if (paused && this.frameHandle) {
      window.cancelAnimationFrame(this.frameHandle);
      this.frameHandle = undefined;
    }
    if (!paused) {
      this.previousFrameAt = performance.now();
      this.requestFrame();
    }
  }

  /** Re-check dimensions after the initially hidden host becomes visible. */
  refreshLayout(): void {
    this.resizeCanvas();
    this.requestFrame();
  }

  destroy(): void {
    if (this.frameHandle) window.cancelAnimationFrame(this.frameHandle);
    this.frameHandle = undefined;
    this.resizeObserver?.disconnect();
    this.resizeObserver = undefined;
    if (this.gl && this.texture) this.gl.deleteTexture(this.texture);
    this.texture = undefined;
    this.renderer?.release();
    this.renderer = undefined;
    this.physics?.release();
    this.physics = undefined;
    this.model?.release();
    this.model = undefined;
    this.moc?.release();
    this.moc = undefined;
    this.bounds = undefined;
    this.modules = undefined;
    this.motionPlayer = undefined;
    this.activeMotion = undefined;
    this.gazeTarget = undefined;
    this.gaze = { x: 0, y: 0 };
    this.gl = undefined;
    this.canvas?.remove();
    this.canvas = undefined;
    this.host = undefined;
  }

  private requestFrame(): void {
    if (this.paused || this.frameHandle || !this.model) return;
    this.frameHandle = window.requestAnimationFrame((now) => {
      this.frameHandle = undefined;
      try {
        this.draw(now);
      } catch {
        this.destroy();
        this.onRenderFailure?.();
        return;
      }
      if (!this.firstFrameRendered) {
        this.firstFrameRendered = true;
        this.onFirstFrame?.();
      }
      this.requestFrame();
    });
  }

  private draw(now: number): void {
    const { gl, canvas, model, renderer, modules } = this;
    if (!gl || !canvas || !model || !renderer || !modules) return;

    const deltaSeconds = Math.min(Math.max((now - this.previousFrameAt) / 1_000, 0), 0.05);
    this.previousFrameAt = now;
    this.elapsedSeconds += deltaSeconds;
    const seconds = this.elapsedSeconds;
    const celebrating = now < this.celebrateUntil;
    const set = (id: string, value: number) =>
      model.setParameterValueById(modules.getId(id), value);
    const motionPlayer = this.motionPlayer;
    if (motionPlayer?.has("Idle")) {
      motionPlayer.sample("Idle", seconds, set);
    } else {
      this.applyProceduralIdle(seconds, set);
    }
    this.updateActionMotion(now, set);
    this.applyGaze(deltaSeconds, set);
    set("ParamMouthForm", celebrating ? 0.6 : 0);
    set("ParamMouthOpenY", celebrating ? 0.5 : 0);
    this.physics?.evaluate(model, deltaSeconds);
    model.update();

    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    renderer.setMvpMatrix(this.createMvpMatrix(modules, canvas));
    renderer.drawModel(SHADER_URL);
  }

  private applyProceduralIdle(seconds: number, set: (id: string, value: number) => void): void {
    set("ParamBreath", 0.5 + Math.sin(seconds * 2.1) * 0.5);
    set("ParamAngleX", Math.sin(seconds * 0.7) * 6);
    set("ParamAngleY", Math.sin(seconds * 0.9) * 2);
    set("ParamAngleZ", Math.sin(seconds * 1.35) * 3);
    set("ParamBodyAngleX", Math.sin(seconds * 0.7) * 2);
    set("ParamBodyAngleZ", Math.sin(seconds * 1.35));
    const blinkPhase = seconds % 4.6;
    const eyeOpen = blinkPhase < 0.24 ? Math.abs(blinkPhase - 0.12) / 0.12 : 1;
    set("ParamEyeLOpen", eyeOpen);
    set("ParamEyeROpen", eyeOpen);
  }

  private updateActionMotion(now: number, set: (id: string, value: number) => void): void {
    const motionPlayer = this.motionPlayer;
    if (!motionPlayer) return;
    if (this.activeMotion) {
      const elapsed = (now - this.activeMotion.beganAt) / 1_000;
      if (motionPlayer.isFinished(this.activeMotion.name, elapsed)) {
        this.activeMotion = undefined;
      } else {
        motionPlayer.sample(this.activeMotion.name, elapsed, set);
        return;
      }
    }
    if (now >= this.nextNodAt && motionPlayer.has("Nod")) {
      this.playMotion("Nod", now);
      this.nextNodAt = now + 10_000 + Math.random() * 7_000;
    }
  }

  private playMotion(name: string, beganAt = performance.now()): void {
    if (this.motionPlayer?.has(name)) this.activeMotion = { name, beganAt };
  }

  private applyGaze(deltaSeconds: number, set: (id: string, value: number) => void): void {
    if (!this.gazeTarget) return;
    const width = Math.max(window.innerWidth * (window.devicePixelRatio || 1), 1);
    const height = Math.max(window.innerHeight * (window.devicePixelRatio || 1), 1);
    const targetX = clamp(this.gazeTarget.x / (width * 0.75), -1, 1);
    const targetY = clamp(this.gazeTarget.y / (height * 0.75), -1, 1);
    const smoothing = Math.min(deltaSeconds * 9, 1);
    this.gaze.x += (targetX - this.gaze.x) * smoothing;
    this.gaze.y += (targetY - this.gaze.y) * smoothing;
    set("ParamEyeBallX", this.gaze.x);
    set("ParamEyeBallY", -this.gaze.y);
    if (!this.activeMotion) {
      set("ParamAngleX", this.gaze.x * 12);
      set("ParamAngleY", -this.gaze.y * 8);
      set("ParamBodyAngleX", this.gaze.x * 3);
      set("ParamBodyAngleY", -this.gaze.y * 1.5);
    }
  }

  private createMvpMatrix(modules: FrameworkModules, canvas: HTMLCanvasElement): CubismMatrix {
    const bounds = this.bounds;
    const matrix = modules.createMatrix();
    if (!bounds || canvas.width === 0 || canvas.height === 0) return matrix;

    const width = Math.max(bounds.maxX - bounds.minX, 1);
    const height = Math.max(bounds.maxY - bounds.minY, 1);
    const pixelScale =
      Math.min(canvas.width / width, canvas.height / height) * 0.96 * VISIBLE_MODEL_SCALE;
    const scaleX = (2 * pixelScale) / canvas.width;
    const scaleY = (2 * pixelScale) / canvas.height;
    matrix.scale(scaleX, scaleY);
    matrix.translate(
      -(bounds.minX + bounds.maxX) * scaleX * 0.5,
      -(bounds.minY + bounds.maxY) * scaleY * 0.5,
    );
    return matrix;
  }

  private resizeCanvas(): void {
    const { host, canvas, renderer } = this;
    if (!host || !canvas || !renderer) return;
    // Windows often reports 1.25 or 1.5 on a 2K display. Rendering at that
    // exact density leaves diagonal line art with too few samples, so retain
    // at least 2× supersampling before WebView composites the transparent canvas.
    const density = Math.min(Math.max(window.devicePixelRatio || 1, 2), 3);
    const width = Math.max(1, Math.round(host.clientWidth * density));
    const height = Math.max(1, Math.round(host.clientHeight * density));
    if (canvas.width === width && canvas.height === height) return;
    canvas.width = width;
    canvas.height = height;
    renderer.setRenderTargetSize(width, height);
  }
}

async function loadFramework(): Promise<FrameworkModules> {
  const [framework, mocModule, rendererModule, matrixModule, physicsModule] = await Promise.all([
    import("../live2d-framework/live2dcubismframework"),
    import("../live2d-framework/model/cubismmoc"),
    import("../live2d-framework/rendering/cubismrenderer_webgl"),
    import("../live2d-framework/math/cubismmatrix44"),
    import("../live2d-framework/physics/cubismphysics"),
  ]);
  framework.CubismFramework.startUp();
  framework.CubismFramework.initialize();
  return {
    createMoc: (bytes) => mocModule.CubismMoc.create(bytes, false) as unknown as CubismMoc | null,
    createPhysics: (bytes) =>
      physicsModule.CubismPhysics.create(bytes, bytes.byteLength) as unknown as CubismPhysics,
    createRenderer: (width, height) =>
      new rendererModule.CubismRenderer_WebGL(width, height) as unknown as CubismRenderer,
    createMatrix: () => new matrixModule.CubismMatrix44() as unknown as CubismMatrix,
    getId: (id) => framework.CubismFramework.getIdManager().getId(id),
  };
}

function getModelBounds(model: CubismModel): ModelBounds {
  const bounds: ModelBounds = {
    minX: Number.POSITIVE_INFINITY,
    maxX: Number.NEGATIVE_INFINITY,
    minY: Number.POSITIVE_INFINITY,
    maxY: Number.NEGATIVE_INFINITY,
  };
  for (let index = 0; index < model.getDrawableCount(); index++) {
    const vertices = model.getDrawableVertices(index);
    for (let vertex = 0; vertex < vertices.length; vertex += 2) {
      bounds.minX = Math.min(bounds.minX, vertices[vertex]);
      bounds.maxX = Math.max(bounds.maxX, vertices[vertex]);
      bounds.minY = Math.min(bounds.minY, vertices[vertex + 1]);
      bounds.maxY = Math.max(bounds.maxY, vertices[vertex + 1]);
    }
  }
  if (!Number.isFinite(bounds.minX)) {
    return { minX: 0, maxX: model.getCanvasWidth(), minY: 0, maxY: model.getCanvasHeight() };
  }
  return bounds;
}

function createTexture(gl: WebGLRenderingContext, image: HTMLImageElement): WebGLTexture {
  const texture = gl.createTexture();
  if (!texture) throw new Error("Unable to allocate the Live2D texture.");
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
  gl.bindTexture(gl.TEXTURE_2D, null);
  return texture;
}

function resolveModelFile(definition: ModelDefinition, key: "Moc" | "Physics"): string | undefined {
  const path = definition.FileReferences?.[key];
  return typeof path === "string" ? resolveReferencedFile(path) : undefined;
}

function resolveFirstTexture(definition: ModelDefinition): string | undefined {
  const [path] = Array.isArray(definition.FileReferences?.Textures)
    ? definition.FileReferences.Textures
    : [];
  return typeof path === "string" ? resolveReferencedFile(path) : undefined;
}

function resolveReferencedFile(path: string): string {
  return new URL(path, location.origin + MODEL_URL).toString();
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

function hasCubismCore(): boolean {
  return CORE_GLOBAL in window;
}

async function loadCubismCore(): Promise<boolean> {
  if (hasCubismCore()) return true;
  return new Promise((resolve) => {
    const script = document.createElement("script");
    script.async = true;
    script.src = CORE_URL;
    script.addEventListener("load", () => resolve(hasCubismCore()), { once: true });
    script.addEventListener("error", () => resolve(false), { once: true });
    document.head.append(script);
  });
}

async function loadModelDefinition(): Promise<ModelDefinition | undefined> {
  try {
    const response = await fetch(MODEL_URL);
    if (!response.ok || !response.headers.get("content-type")?.includes("application/json"))
      return undefined;
    const definition = (await response.json()) as ModelDefinition;
    return typeof definition.FileReferences?.Moc === "string" ? definition : undefined;
  } catch {
    return undefined;
  }
}

async function resourceExists(url: string): Promise<boolean> {
  try {
    return (await fetch(url, { method: "HEAD" })).ok;
  } catch {
    return false;
  }
}

async function fetchArrayBuffer(url: string): Promise<ArrayBuffer> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Unable to load ${url}.`);
  return response.arrayBuffer();
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.addEventListener("load", () => resolve(image), { once: true });
    image.addEventListener("error", () => reject(new Error(`Unable to load ${url}.`)), {
      once: true,
    });
    image.src = url;
  });
}
