(function (global) {
  const LANG_STORAGE_KEY = "lang";
  const SUPPORTED_LANGS = ["zh", "en", "ja"];
  const LEGACY_LANG_MAP = {
    jp: "ja",
    "zh-cn": "zh",
    "zh-hans": "zh",
    "zh-hant": "zh"
  };

  function normalizeLang(rawLang) {
    if (!rawLang) return "";
    const lower = String(rawLang).trim().toLowerCase();
    return LEGACY_LANG_MAP[lower] || lower;
  }

  function isSupportedLang(lang) {
    return SUPPORTED_LANGS.includes(lang);
  }

  function getBrowserLang() {
    const shortLang = normalizeLang((navigator.language || "zh").split("-")[0]);
    return isSupportedLang(shortLang) ? shortLang : "zh";
  }

  function getLang() {
    const stored = normalizeLang(localStorage.getItem(LANG_STORAGE_KEY));
    if (isSupportedLang(stored)) {
      if (stored !== localStorage.getItem(LANG_STORAGE_KEY)) {
        localStorage.setItem(LANG_STORAGE_KEY, stored);
      }
      return stored;
    }

    const fallback = getBrowserLang();
    localStorage.setItem(LANG_STORAGE_KEY, fallback);
    return fallback;
  }

  function setLang(lang) {
    const normalized = normalizeLang(lang);
    const next = isSupportedLang(normalized) ? normalized : "zh";
    localStorage.setItem(LANG_STORAGE_KEY, next);
    return next;
  }

  function initLanguage(options) {
    const { applyLang, switcherSelector } = options;
    if (typeof applyLang !== "function") {
      throw new Error("initLanguage 需要传入 applyLang 函数");
    }

    const current = getLang();
    applyLang(current);

    if (!switcherSelector) return current;

    const buttons = document.querySelectorAll(`${switcherSelector} [data-lang]`);
    buttons.forEach((button) => {
      button.classList.toggle("active", button.dataset.lang === current);
      button.addEventListener("click", () => {
        const nextLang = setLang(button.dataset.lang);
        buttons.forEach((btn) => btn.classList.toggle("active", btn.dataset.lang === nextLang));
        applyLang(nextLang);
      });
    });

    return current;
  }

  global.LangState = {
    SUPPORTED_LANGS,
    getLang,
    setLang,
    initLanguage
  };
})(window);
