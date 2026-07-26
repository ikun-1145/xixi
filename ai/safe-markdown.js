const ALLOWED_MARKDOWN_TAGS = [
  "a", "blockquote", "br", "code", "del", "em", "h1", "h2", "h3",
  "h4", "h5", "h6", "hr", "li", "ol", "p", "pre", "s", "strong",
  "table", "tbody", "td", "th", "thead", "tr", "ul",
];

const ALLOWED_MARKDOWN_ATTRIBUTES = [
  "align", "class", "colspan", "href", "rowspan", "start", "title",
];

const FORBIDDEN_EXECUTABLE_TAGS = [
  "base", "button", "canvas", "embed", "form", "iframe", "input", "link",
  "math", "meta", "object", "script", "select", "style", "svg", "textarea",
];

function getRendererDependencies() {
  const markdownParser = window.marked;
  const sanitizer = window.DOMPurify;

  if (!markdownParser?.parse || !sanitizer?.sanitize) {
    console.error("安全 Markdown 渲染器未能初始化，已降级为纯文本显示");
    return null;
  }

  return { markdownParser, sanitizer };
}

function isSafeLink(href) {
  if (!href) return false;

  try {
    const url = new URL(href, window.location.href);
    return ["http:", "https:", "mailto:", "tel:"].includes(url.protocol);
  } catch {
    return false;
  }
}

function hardenLinks(root) {
  root.querySelectorAll("a").forEach(link => {
    const href = link.getAttribute("href") || "";
    if (!isSafeLink(href)) {
      link.removeAttribute("href");
      link.removeAttribute("target");
      link.removeAttribute("rel");
      return;
    }

    link.setAttribute("rel", "noopener noreferrer");

    const url = new URL(href, window.location.href);
    if (["http:", "https:"].includes(url.protocol) && url.origin !== window.location.origin) {
      link.setAttribute("target", "_blank");
    } else {
      link.removeAttribute("target");
    }
  });
}

function wrapTextForTypingAnimation(root) {
  if (root.querySelector("pre, code")) return false;

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const textNodes = [];
  while (walker.nextNode()) textNodes.push(walker.currentNode);

  let wrapped = false;
  textNodes.forEach(textNode => {
    if (!textNode.data) return;

    const fragment = document.createDocumentFragment();
    Array.from(textNode.data).forEach(character => {
      const span = document.createElement("span");
      span.textContent = character;
      fragment.appendChild(span);
    });
    textNode.replaceWith(fragment);
    wrapped = true;
  });

  if (wrapped) root.classList.add("typing");
  return wrapped;
}

/**
 * 所有 AI Markdown（实时流、完整回复与历史恢复）都必须经过此入口。
 * 依赖缺失时安全失败为纯文本，绝不回退到未经清洗的 innerHTML。
 */
export function renderSafeMarkdown(target, markdown, options = {}) {
  if (!target) return { animated: false, sanitized: false };

  const source = String(markdown ?? "");
  const dependencies = getRendererDependencies();
  target.classList.remove("typing");

  if (!dependencies) {
    target.textContent = source;
    return { animated: false, sanitized: false };
  }

  let parsed;
  let fragment;
  try {
    parsed = dependencies.markdownParser.parse(source);
    if (typeof parsed !== "string") throw new TypeError("Markdown parser returned a non-string value");

    fragment = dependencies.sanitizer.sanitize(parsed, {
      ALLOWED_TAGS: ALLOWED_MARKDOWN_TAGS,
      ALLOWED_ATTR: ALLOWED_MARKDOWN_ATTRIBUTES,
      ALLOW_ARIA_ATTR: false,
      ALLOW_DATA_ATTR: false,
      FORBID_TAGS: FORBIDDEN_EXECUTABLE_TAGS,
      FORBID_ATTR: ["style", "src", "srcset", "xlink:href"],
      RETURN_DOM_FRAGMENT: true,
      SANITIZE_DOM: true,
    });
  } catch (error) {
    console.error("安全 Markdown 渲染失败，已降级为纯文本显示", error);
    target.textContent = source;
    return { animated: false, sanitized: false };
  }

  hardenLinks(fragment);
  target.replaceChildren(fragment);

  const animated = options.animateText === true
    ? wrapTextForTypingAnimation(target)
    : false;

  return { animated, sanitized: true };
}
