import {
  formatFurryEventDateRange,
  normalizeFurryEvents,
  safeHttpUrl,
} from "./furry-events.js";

function externalLink(documentRef, url, label, className) {
  const safeUrl = safeHttpUrl(url);
  if (!safeUrl) return null;
  const link = documentRef.createElement("a");
  link.href = safeUrl;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.className = className;
  link.textContent = label;
  return link;
}

function weatherText(weather) {
  if (!weather) return "天气待临近活动时更新";
  const temperatures = weather.tempMin != null && weather.tempMax != null
    ? ` ${Math.round(weather.tempMin)}~${Math.round(weather.tempMax)}°C`
    : "";
  return `${weather.label || "天气"}${temperatures}`;
}

function eventLocation(event) {
  return [event.city, event.address].filter(Boolean).join(" · ") || "地点待公布";
}

function createEventCard(documentRef, event) {
  const card = documentRef.createElement("article");
  card.className = "furry-event-card";

  const coverLink = externalLink(
    documentRef,
    event.source_url,
    "",
    "furry-event-cover-link",
  );
  const coverHost = coverLink || documentRef.createElement("div");
  if (!coverLink) coverHost.className = "furry-event-cover-link";

  if (event.cover) {
    const image = documentRef.createElement("img");
    image.className = "furry-event-cover";
    image.src = event.cover;
    image.alt = `${event.name}活动封面`;
    image.loading = "lazy";
    image.decoding = "async";
    image.referrerPolicy = "no-referrer";
    image.addEventListener("error", () => {
      image.remove();
      coverHost.classList.add("is-placeholder");
      coverHost.textContent = "🐾";
    }, { once: true });
    coverHost.appendChild(image);
  } else {
    coverHost.classList.add("is-placeholder");
    coverHost.textContent = "🐾";
  }
  card.appendChild(coverHost);

  const body = documentRef.createElement("div");
  body.className = "furry-event-card-body";

  const titleLink = externalLink(
    documentRef,
    event.source_url,
    event.name,
    "furry-event-title",
  );
  if (titleLink) {
    body.appendChild(titleLink);
  } else {
    const title = documentRef.createElement("div");
    title.className = "furry-event-title";
    title.textContent = event.name;
    body.appendChild(title);
  }

  const meta = documentRef.createElement("div");
  meta.className = "furry-event-meta";
  const date = documentRef.createElement("span");
  date.textContent = `📅 ${formatFurryEventDateRange(event)}`;
  const location = documentRef.createElement("span");
  location.textContent = `📍 ${eventLocation(event)}`;
  meta.append(date, location);
  body.appendChild(meta);

  const details = documentRef.createElement("div");
  details.className = "furry-event-details";
  if (event.raw_status) {
    const status = documentRef.createElement("span");
    status.className = "furry-event-status";
    status.textContent = event.raw_status;
    details.appendChild(status);
  }
  const weather = documentRef.createElement("span");
  weather.className = "furry-event-weather";
  weather.textContent = `🌤 ${weatherText(event.weather)}`;
  details.appendChild(weather);
  body.appendChild(details);

  const actions = documentRef.createElement("div");
  actions.className = "furry-event-actions";
  const detailLink = externalLink(
    documentRef,
    event.source_url,
    "活动详情",
    "furry-event-action detail",
  );
  const ctripLink = externalLink(
    documentRef,
    event.hotels?.ctripUrl,
    "携程住宿",
    "furry-event-action ctrip",
  );
  const meituanLink = externalLink(
    documentRef,
    event.hotels?.meituanUrl,
    "美团住宿",
    "furry-event-action meituan",
  );
  [detailLink, ctripLink, meituanLink].filter(Boolean).forEach(link => {
    actions.appendChild(link);
  });
  if (actions.childElementCount) body.appendChild(actions);

  card.appendChild(body);
  return card;
}

function renderLoading(documentRef, content) {
  const label = documentRef.createElement("div");
  label.className = "furry-event-loading-label";
  label.textContent = "🐾 正在获取兽聚活动…";
  content.appendChild(label);

  const track = documentRef.createElement("div");
  track.className = "furry-event-track furry-event-skeleton-track";
  for (let index = 0; index < 2; index += 1) {
    const skeleton = documentRef.createElement("div");
    skeleton.className = "furry-event-skeleton";
    track.appendChild(skeleton);
  }
  content.appendChild(track);
}

function renderResult(documentRef, content, message) {
  const events = normalizeFurryEvents(message?.furryEvents);
  if (message?.furryError) {
    const error = documentRef.createElement("div");
    error.className = "furry-event-empty";
    error.textContent = "🐾 兽聚信息暂时获取失败，请稍后再试";
    content.appendChild(error);
    return;
  }
  if (!events.length) {
    const empty = documentRef.createElement("div");
    empty.className = "furry-event-empty";
    empty.textContent = "🐾 没有找到相关兽聚活动";
    content.appendChild(empty);
    return;
  }

  const header = documentRef.createElement("div");
  header.className = "furry-event-header";
  const title = documentRef.createElement("span");
  title.textContent = "🐾 相关兽聚活动";
  const count = documentRef.createElement("span");
  count.className = "furry-event-count";
  count.textContent = `${events.length} 场 · 横向滑动查看更多`;
  header.append(title, count);
  content.appendChild(header);

  const track = documentRef.createElement("div");
  track.className = "furry-event-track";
  track.tabIndex = 0;
  track.setAttribute("aria-label", `相关兽聚活动，共 ${events.length} 场`);
  events.forEach(event => track.appendChild(createEventCard(documentRef, event)));
  content.appendChild(track);
}

export function appendFurryEventMessage({ target, message = null, loading = false }) {
  if (!target?.ownerDocument) return null;
  const documentRef = target.ownerDocument;
  const wrapper = documentRef.createElement("div");
  wrapper.className = "message ai furry-event-message";
  const content = documentRef.createElement("section");
  content.className = "furry-event-results";
  content.setAttribute("aria-live", "polite");
  wrapper.appendChild(content);
  target.appendChild(wrapper);

  const render = (nextMessage, options = {}) => {
    content.replaceChildren();
    if (options.loading === true) {
      wrapper.classList.add("is-loading");
      renderLoading(documentRef, content);
    } else {
      wrapper.classList.remove("is-loading");
      renderResult(documentRef, content, nextMessage);
    }
  };

  render(message, { loading });
  return {
    element: wrapper,
    update(nextMessage) {
      render(nextMessage);
    },
  };
}
