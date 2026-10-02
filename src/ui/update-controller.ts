import type { AppUpdate, DownloadEvent } from "../api";

export const UPDATE_CHECK_TIMEOUT_MS = 15_000;
export const UPDATE_DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
const DOWNLOAD_ATTEMPTS = 3;
const NETWORK_ERROR =
  /timed?\s*out|network|fetch|connect|dns|resolve|socket|request|response\s*body|body.*error|error.*body|stream|unexpected\s*eof/i;
const VERIFICATION_ERROR = /signature|verify|verification|checksum|certificate|invalid\s*url/i;

export type UpdatePhase =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "retrying"
  | "verifying"
  | "installing"
  | "installed"
  | "latest"
  | "error";
export type UpdateErrorStage = "checking" | "downloading" | "installing";
export interface UpdateState {
  phase: UpdatePhase;
  downloaded?: number;
  total?: number;
  percent?: number;
  attempt?: number;
  attempts?: number;
  error?: string;
  errorStage?: UpdateErrorStage;
  networkError?: boolean;
}
interface UpdateControllerOptions {
  check: (timeout: number) => Promise<AppUpdate | null>;
  confirm: (update: AppUpdate) => Promise<boolean>;
  onState: (state: UpdateState) => void;
  yieldUi: () => Promise<void>;
  wait: (milliseconds: number) => Promise<void>;
}

/** 把检查、下载、安装拆分开来，这样只重试下载环节。 */
export function createUpdateController(options: UpdateControllerOptions) {
  let busy = false;
  let state: UpdateState = { phase: "idle" };
  const publish = (next: UpdateState) => {
    state = next;
    options.onState(next);
  };
  const download = async (update: AppUpdate) => {
    for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt++) {
      let downloaded = 0;
      let total = 0;
      let lastPercent = -1;
      let lastBytes = 0;
      let active = true;
      publish({ phase: "downloading", downloaded, total, attempt, attempts: DOWNLOAD_ATTEMPTS });
      const receive = (event: DownloadEvent) => {
        if (!active) return;
        if (event.event === "Started") {
          total = event.data.contentLength ?? 0;
        } else if (event.event === "Progress") {
          downloaded += event.data.chunkLength;
          const percent =
            total > 0 ? Math.min(100, Math.floor((downloaded / total) * 100)) : undefined;
          if (percent === undefined ? downloaded - lastBytes < 64 * 1024 : percent === lastPercent)
            return;
          lastPercent = percent ?? -1;
          lastBytes = downloaded;
          publish({
            phase: "downloading",
            downloaded,
            total,
            percent,
            attempt,
            attempts: DOWNLOAD_ATTEMPTS,
          });
        } else {
          // 插件先发出 Finished，之后才校验安装包签名。
          publish({ phase: "verifying", downloaded, total });
        }
      };
      try {
        await update.download(receive, { timeout: UPDATE_DOWNLOAD_TIMEOUT_MS });
        return;
      } catch (error) {
        active = false;
        const message = String(error);
        if (
          attempt === DOWNLOAD_ATTEMPTS ||
          !NETWORK_ERROR.test(message) ||
          VERIFICATION_ERROR.test(message)
        )
          throw error;
        publish({ phase: "retrying", attempt: attempt + 1, attempts: DOWNLOAD_ATTEMPTS });
        await options.wait(attempt * 1000);
      } finally {
        active = false;
      }
    }
  };
  const run = async () => {
    if (busy) return;
    busy = true;
    let update: AppUpdate | null = null;
    let stage: UpdateErrorStage = "checking";
    publish({ phase: "checking" });
    try {
      // 先让加载动画与状态文字渲染一帧，再开始原生工作。
      await options.yieldUi();
      update = await options.check(UPDATE_CHECK_TIMEOUT_MS);
      if (!update) {
        publish({ phase: "latest" });
        return;
      }
      publish({ phase: "available" });
      if (!(await options.confirm(update))) {
        publish({ phase: "idle" });
        return;
      }
      stage = "downloading";
      await download(update);
      stage = "installing";
      publish({ phase: "installing" });
      await options.yieldUi();
      // Windows 上更新器会启动 NSIS、退出本应用，并在安装完成后重启。
      await update.install();
      publish({ phase: "installed" });
    } catch (error) {
      const message = String(error);
      console.warn(`Update ${stage} failed`, error);
      publish({
        phase: "error",
        error: message,
        errorStage: stage,
        networkError: NETWORK_ERROR.test(message) && !VERIFICATION_ERROR.test(message),
      });
    } finally {
      if (update) {
        try {
          await update.close();
        } catch (error) {
          console.warn("Releasing updater resources failed", error);
        }
      }
      busy = false;
      // 清理完成之后才重新启用各项操作。
      options.onState(state);
    }
  };
  const dismiss = () => {
    if (!busy) publish({ phase: "idle" });
  };
  return { run, dismiss, isBusy: () => busy, getState: () => state };
}
