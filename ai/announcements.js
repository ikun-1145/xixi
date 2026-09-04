const ANNOUNCEMENTS_URL = "https://api.sunland.dev/v1/announcements";

function text(value) {
  return typeof window.SiteI18n?.translate === "function"
    ? window.SiteI18n.translate(value)
    : value;
}

function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString();
}

function messageState(container, message, retry = false) {
  container.replaceChildren(document.createTextNode(text(message)));
  if (!retry) return;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "retry";
  button.textContent = text("重试");
  button.addEventListener("click", () => void loadAnnouncements(container));
  container.append(document.createElement("br"), button);
}

export function renderAnnouncements(container, items) {
  container.replaceChildren();
  if (!items.length) {
    messageState(container, "当前没有有效公告。");
    return;
  }
  for (const item of items) {
    const article = document.createElement("article");
    article.className = "notice";
    const title = document.createElement("h2");
    const content = document.createElement("p");
    title.textContent = item.title;
    content.textContent = item.content;
    article.append(title);
    if (item.publishedAt) {
      const published = formatDate(item.publishedAt);
      if (published) {
        const time = document.createElement("time");
        time.dateTime = item.publishedAt;
        time.textContent = `${text("发布时间：")}${published}`;
        article.append(time);
      }
    }
    article.append(content);
    container.append(article);
  }
}

export async function loadAnnouncements(container) {
  messageState(container, "正在加载公告…");
  try {
    const response = await fetch(ANNOUNCEMENTS_URL, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error(`announcement request failed: ${response.status}`);
    const payload = await response.json();
    if (!payload || !Array.isArray(payload.items)) throw new Error("invalid announcement response");
    const items = payload.items.filter((item) => (
      item && typeof item.title === "string" && typeof item.content === "string"
    ));
    renderAnnouncements(container, items);
  } catch (_) {
    messageState(container, "公告暂时无法加载，请稍后重试。", true);
  }
}

const container = document.getElementById("announcements");
if (container) void loadAnnouncements(container);
