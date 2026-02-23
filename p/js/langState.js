(function (global) {
  const LANG_STORAGE_KEY = "lang";
  const LANG_QUERY_KEY = "lang";
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

  function safeReadStorage(key) {
    try {
      return localStorage.getItem(key);
    } catch (_error) {
      return null;
    }
  }

  function safeWriteStorage(key, value) {
    try {
      localStorage.setItem(key, value);
      return true;
    } catch (_error) {
      return false;
    }
  }

  function readLangFromQuery() {
    const url = new URL(global.location.href);
    const queryLang = normalizeLang(url.searchParams.get(LANG_QUERY_KEY));
    return isSupportedLang(queryLang) ? queryLang : "";
  }

  function writeLangToQuery(lang) {
    const url = new URL(global.location.href);
    url.searchParams.set(LANG_QUERY_KEY, lang);
    global.history.replaceState(null, "", url.toString());
  }

  function getBrowserLang() {
    const shortLang = normalizeLang((navigator.language || "zh").split("-")[0]);
    return isSupportedLang(shortLang) ? shortLang : "zh";
  }

  function getLang() {
    const queryLang = readLangFromQuery();
    if (queryLang) {
      safeWriteStorage(LANG_STORAGE_KEY, queryLang);
      return queryLang;
    }

    const stored = normalizeLang(safeReadStorage(LANG_STORAGE_KEY));
    if (isSupportedLang(stored)) {
      safeWriteStorage(LANG_STORAGE_KEY, stored);
    const stored = normalizeLang(localStorage.getItem(LANG_STORAGE_KEY));
    if (isSupportedLang(stored)) {
      if (stored !== localStorage.getItem(LANG_STORAGE_KEY)) {
        localStorage.setItem(LANG_STORAGE_KEY, stored);
      }
      return stored;
    }

    const fallback = getBrowserLang();
    safeWriteStorage(LANG_STORAGE_KEY, fallback);
    localStorage.setItem(LANG_STORAGE_KEY, fallback);
    return fallback;
  }

  function setLang(lang) {
    const normalized = normalizeLang(lang);
    const next = isSupportedLang(normalized) ? normalized : "zh";
    safeWriteStorage(LANG_STORAGE_KEY, next);
    writeLangToQuery(next);
    return next;
  }

  function syncLinks(lang) {
    const links = document.querySelectorAll("a[href]");
    links.forEach((link) => {
      const href = link.getAttribute("href");
      if (!href || href.startsWith("#") || href.startsWith("javascript:") || href.startsWith("mailto:") || href.startsWith("tel:")) {
        return;
      }

      const url = new URL(href, global.location.href);
      if (url.origin !== global.location.origin) return;
      url.searchParams.set(LANG_QUERY_KEY, lang);
      link.setAttribute("href", `${url.pathname}${url.search}${url.hash}`);
    });
  }

    localStorage.setItem(LANG_STORAGE_KEY, next);
    return next;
  }

  function initLanguage(options) {
    const { applyLang, switcherSelector } = options;
    if (typeof applyLang !== "function") {
      throw new Error("initLanguage 需要传入 applyLang 函数");
    }

    const current = getLang();
    writeLangToQuery(current);
    applyLang(current);
    syncLinks(current);
    applyLang(current);

    if (!switcherSelector) return current;

    const buttons = document.querySelectorAll(`${switcherSelector} [data-lang]`);
    buttons.forEach((button) => {
      button.classList.toggle("active", button.dataset.lang === current);
      button.addEventListener("click", () => {
        const nextLang = setLang(button.dataset.lang);
        buttons.forEach((btn) => btn.classList.toggle("active", btn.dataset.lang === nextLang));
        applyLang(nextLang);
        syncLinks(nextLang);
      });
    });

    return current;
  }

  function autoInit() {
    const lang = getLang();
    writeLangToQuery(lang);
    syncLinks(lang);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", autoInit, { once: true });
  } else {
    autoInit();
  }

  global.LangState = {
    SUPPORTED_LANGS,
    getLang,
    setLang,
    initLanguage,
    syncLinks
    initLanguage
  };
})(window);
