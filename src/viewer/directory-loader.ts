import type { ImageEntry } from "../api";

/** 目录和指定文件打开共用序号，失败或过期都不能提交旧目录。 */
export function createDirectoryLoader(options: {
  load: (dir: string) => Promise<ImageEntry[]>;
  commit: (dir: string, entries: ImageEntry[], refresh: boolean) => void;
  onError: (error: unknown) => void;
}) {
  let revision = 0;
  const load = async (dir: string, refresh: boolean) => {
    const current = ++revision;
    try {
      const entries = await options.load(dir);
      if (current !== revision) return false;
      options.commit(dir, entries, refresh);
      return true;
    } catch (error) {
      if (current === revision) options.onError(error);
      return false;
    }
  };
  return {
    open: (dir: string) => load(dir, false),
    refresh: (dir: string) => load(dir, true),
    cancel: () => {
      revision++;
    },
  };
}
