interface ImageEditorLoaderOptions {
  getSource: (path: string) => Promise<string>;
  createImage?: () => HTMLImageElement;
}

/** 在后台解码编辑器用的图像，不打断当前页面；只有最新一次请求的结果会被采纳。 */
export function createImageEditorLoader(options: ImageEditorLoaderOptions) {
  let revision = 0;
  let loading = false;
  const load = async (path: string): Promise<HTMLImageElement | null> => {
    const request = ++revision;
    loading = true;
    try {
      const source = await options.getSource(path);
      if (request !== revision) return null;
      const image = options.createImage?.() ?? new Image();
      image.src = source;
      await image.decode();
      return request === revision ? image : null;
    } catch (error) {
      if (request === revision) throw error;
      return null;
    } finally {
      if (request === revision) loading = false;
    }
  };
  return {
    load,
    isLoading: () => loading,
    cancel: () => {
      revision++;
      loading = false;
    },
  };
}
