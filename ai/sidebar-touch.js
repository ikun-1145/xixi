const DEFAULT_TOUCH_MOVE_THRESHOLD = 8;

export function installSidebarTouchScrollGuard(
  sidebar,
  { moveThreshold = DEFAULT_TOUCH_MOVE_THRESHOLD } = {},
) {
  if (!sidebar) return;

  let touchStart = null;
  let touchMoved = false;

  sidebar.addEventListener("touchstart", (event) => {
    if (event.touches?.length !== 1) {
      touchStart = null;
      touchMoved = false;
      return;
    }

    const touch = event.touches[0];
    touchStart = { x: touch.clientX, y: touch.clientY };
    touchMoved = false;
  }, { passive: true });

  sidebar.addEventListener("touchmove", (event) => {
    if (!touchStart || event.touches?.length !== 1) return;

    const touch = event.touches[0];
    if (
      Math.abs(touch.clientX - touchStart.x) >= moveThreshold
      || Math.abs(touch.clientY - touchStart.y) >= moveThreshold
    ) {
      touchMoved = true;
    }
  }, { passive: true });

  sidebar.addEventListener("touchcancel", () => {
    touchStart = null;
    touchMoved = false;
  }, { passive: true });

  sidebar.addEventListener("touchend", () => {
    touchStart = null;
  }, { passive: true });

  sidebar.addEventListener("click", (event) => {
    if (!touchMoved) return;

    touchStart = null;
    touchMoved = false;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);
}
