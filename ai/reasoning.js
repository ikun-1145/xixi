export function getAssistantReasoning(message) {
  if (message?.role !== "assistant" || typeof message.reasoningContent !== "string") {
    return "";
  }
  return message.reasoningContent.trim() ? message.reasoningContent : "";
}

export function createAssistantHistoryMessage(content, reasoningContent = "") {
  const message = {
    role: "assistant",
    content: String(content ?? ""),
  };
  const reasoning = typeof reasoningContent === "string" ? reasoningContent : "";
  if (reasoning.trim()) message.reasoningContent = reasoning;
  return message;
}
