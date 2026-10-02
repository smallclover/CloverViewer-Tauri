interface ImageEditorLoaderOptions {
  getSource: (path: string) => Promise<string>;
  createImage?: () => HTMLImageElement;
}

/** Decodes an editor source without changing the visible page; only the latest request can open. */
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
