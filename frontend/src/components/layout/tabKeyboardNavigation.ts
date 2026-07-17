/** Keys supported by horizontal WAI-ARIA tablists. */
export type HorizontalTabKey = 'ArrowLeft' | 'ArrowRight' | 'Home' | 'End';

/**
 * Return the next tab index for a horizontal, wrapping tablist.
 * `null` means the key belongs to the active panel rather than the tablist.
 */
export function nextHorizontalTabIndex(
  currentIndex: number,
  tabCount: number,
  key: string,
): number | null {
  if (!Number.isInteger(currentIndex) || currentIndex < 0 || tabCount < 1) return null;
  if (key === 'Home') return 0;
  if (key === 'End') return tabCount - 1;
  if (key === 'ArrowRight') return (currentIndex + 1) % tabCount;
  if (key === 'ArrowLeft') return (currentIndex - 1 + tabCount) % tabCount;
  return null;
}
