function createNoticeRow(documentRef) {
  const row = documentRef.createElement("div");
  row.className = "message ai chat-error";

  const bubble = documentRef.createElement("div");
  bubble.className = "bubble chat-error-notice";
  row.appendChild(bubble);

  return { row, bubble };
}

function populateNotice(bubble, message) {
  const documentRef = bubble.ownerDocument;
  const icon = documentRef.createElement("span");
  icon.className = "ui-svg-icon icon-error chat-error-icon";
  icon.setAttribute("aria-hidden", "true");

  const text = documentRef.createElement("span");
  text.className = "chat-error-text";
  text.textContent = String(message ?? "");

  bubble.className = "bubble chat-error-notice";
  bubble.removeAttribute("style");
  bubble.setAttribute("role", "alert");
  bubble.setAttribute("aria-live", "assertive");
  bubble.replaceChildren(icon, text);
  return bubble;
}

export function showChatErrorNotice({ target, bubble = null, message, preserveBubble = false }) {
  if (!target) return null;

  const existingRow = bubble?.closest?.(".message") ?? null;
  if (!preserveBubble && existingRow && target.contains(existingRow)) {
    existingRow.className = "message ai chat-error";
    return populateNotice(bubble, message);
  }

  const notice = createNoticeRow(target.ownerDocument);
  if (preserveBubble && existingRow && target.contains(existingRow)) {
    existingRow.after(notice.row);
  } else {
    target.appendChild(notice.row);
  }
  return populateNotice(notice.bubble, message);
}

export function clearChatErrorNotices(target) {
  target?.querySelectorAll?.(".message.chat-error").forEach(element => element.remove());
}
