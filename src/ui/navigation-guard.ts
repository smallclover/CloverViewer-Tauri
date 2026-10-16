/** 合并同一次离开确认，等待期间只有最后一次导航意图可以提交。 */
export function createNavigationGuard(canLeave: () => Promise<boolean>) {
  let pending: Promise<boolean> | null = null;
  let revision = 0;
  return {
    async run(action: () => unknown) {
      const current = ++revision;
      pending ??= canLeave().finally(() => {
        pending = null;
      });
      if (!(await pending) || current !== revision) return false;
      await action();
      return true;
    },
  };
}
