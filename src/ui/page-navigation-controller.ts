type PageLocation =
  | { page: "viewer"; imageIndex: number | null }
  | { page: "settings" }
  | { page: "about" };

interface PageNavigationOptions {
  showViewer: (imageIndex: number | null) => void;
  showSettings: () => void;
  showAbout: () => void;
}

const element = <T extends HTMLElement = HTMLElement>(id: string) => {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing page navigation element: ${id}`);
  return found as T;
};

/** 让整页工作区共享一份浏览器式的小型前进后退历史。 */
export function createPageNavigationController(options: PageNavigationOptions) {
  const backButton = element<HTMLButtonElement>("page-back");
  const forwardButton = element<HTMLButtonElement>("page-forward");
  const history: PageLocation[] = [{ page: "viewer", imageIndex: null }];
  let index = 0;

  const sameLocation = (left: PageLocation, right: PageLocation) =>
    left.page === right.page &&
    (left.page !== "viewer" || right.page !== "viewer" || left.imageIndex === right.imageIndex);

  const showCurrent = () => {
    const location = history[index];
    if (location.page === "settings") options.showSettings();
    else if (location.page === "about") options.showAbout();
    else options.showViewer(location.imageIndex);
    backButton.disabled = index === 0;
    forwardButton.disabled = index === history.length - 1;
  };

  const navigate = (location: PageLocation) => {
    if (sameLocation(history[index], location)) return;
    history.splice(index + 1);
    history.push(location);
    index = history.length - 1;
    showCurrent();
  };

  const back = () => {
    if (index === 0) return false;
    index -= 1;
    showCurrent();
    return true;
  };

  const forward = () => {
    if (index === history.length - 1) return false;
    index += 1;
    showCurrent();
    return true;
  };

  backButton.addEventListener("click", back);
  forwardButton.addEventListener("click", forward);

  return {
    showSettings: () => navigate({ page: "settings" }),
    showAbout: () => navigate({ page: "about" }),
    showImage: (imageIndex: number) => navigate({ page: "viewer", imageIndex }),
    replaceCurrentImage: (imageIndex: number) => {
      if (history[index].page !== "viewer") return;
      history[index] = { page: "viewer", imageIndex };
    },
    resetViewer: () => {
      history.splice(0, history.length, { page: "viewer", imageIndex: null });
      index = 0;
      showCurrent();
    },
    back,
    forward,
  };
}
