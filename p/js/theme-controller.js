(function (global) {
  const THEME_KEY = 'theme';
  const NIGHT_CLASS = 'night';
  const TRANSITION_MS = 400;

  function getStoredTheme() {
    const value = localStorage.getItem(THEME_KEY);
    return value === 'dark' || value === 'light' ? value : null;
  }

  function applyTheme(theme) {
    document.body.classList.toggle(NIGHT_CLASS, theme === 'dark');
    updateButton(theme, true);
  }

  function getCurrentTheme() {
    return document.body.classList.contains(NIGHT_CLASS) ? 'dark' : 'light';
  }

  function setManualTheme(theme) {
    localStorage.setItem(THEME_KEY, theme);
    applyTheme(theme);
  }

  function clearManualTheme() {
    localStorage.removeItem(THEME_KEY);
  }

  function ensureThemeTransitionStyle() {
    if (document.getElementById('theme-controller-style')) return;
    const style = document.createElement('style');
    style.id = 'theme-controller-style';
    style.textContent = `
      body,
      .container,
      .card,
      .panel,
      .modal-content,
      .lang-switcher,
      #loading,
      footer,
      .theme-toggle-btn {
        transition: background-color ${TRANSITION_MS}ms ease, color ${TRANSITION_MS}ms ease,
          border-color ${TRANSITION_MS}ms ease, box-shadow ${TRANSITION_MS}ms ease,
          opacity ${TRANSITION_MS}ms ease;
      }

      .theme-toggle-btn {
        position: fixed;
        top: 14px;
        left: 14px;
        width: 42px;
        height: 42px;
        border: none;
        border-radius: 50%;
        cursor: pointer;
        font-size: 18px;
        line-height: 1;
        display: grid;
        place-items: center;
        background: rgba(255, 255, 255, 0.62);
        color: #1a1a1a;
        backdrop-filter: blur(10px);
        -webkit-backdrop-filter: blur(10px);
        box-shadow: 0 8px 22px rgba(0, 0, 0, 0.18);
        z-index: 25;
      }

      body.night .theme-toggle-btn {
        background: rgba(22, 24, 35, 0.9);
        color: #e8ffff;
      }

      .theme-toggle-btn:hover {
        transform: translateY(-1px) scale(1.03);
      }

      @media (max-width: 480px) {
        .theme-toggle-btn {
          top: 8px;
          left: 8px;
          width: 38px;
          height: 38px;
          font-size: 16px;
        }
      }
    `;
    document.head.appendChild(style);
  }

  function updateButton(theme, isAutoMode) {
    const button = document.getElementById('themeToggleBtn');
    if (!button) return;
    button.textContent = theme === 'dark' ? '🌙' : '☀️';
    button.title = isAutoMode
      ? '当前自动模式，单击切换手动主题，双击恢复自动'
      : '当前手动模式，单击切换主题，双击恢复自动';
    button.setAttribute('aria-label', button.title);
  }

  function ensureThemeToggleButton(onToggle, onResetAuto) {
    if (document.getElementById('themeToggleBtn')) return;
    const button = document.createElement('button');
    button.id = 'themeToggleBtn';
    button.className = 'theme-toggle-btn';
    button.type = 'button';
    button.textContent = '☀️';
    button.addEventListener('click', onToggle);
    button.addEventListener('dblclick', onResetAuto);
    document.body.appendChild(button);
  }

  function initThemeController(options) {
    const applyAutoTheme = options && options.applyAutoTheme;
    const intervalMs = (options && options.intervalMs) || 10 * 60 * 1000;

    if (typeof applyAutoTheme !== 'function') {
      throw new Error('initThemeController 需要传入 applyAutoTheme 函数');
    }

    ensureThemeTransitionStyle();

    const storedTheme = getStoredTheme();
    if (storedTheme) {
      applyTheme(storedTheme);
    } else {
      applyAutoTheme();
    }

    ensureThemeToggleButton(() => {
      const nextTheme = getCurrentTheme() === 'dark' ? 'light' : 'dark';
      setManualTheme(nextTheme);
      updateButton(nextTheme, false);
    }, () => {
      clearManualTheme();
      applyAutoTheme();
      updateButton(getCurrentTheme(), true);
    });

    updateButton(getCurrentTheme(), !getStoredTheme());

    setInterval(() => {
      if (getStoredTheme()) {
        return;
      }
      applyAutoTheme();
      updateButton(getCurrentTheme(), true);
    }, intervalMs);
  }

  global.initThemeController = initThemeController;
})(window);
