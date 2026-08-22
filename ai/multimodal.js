export const DEEPSEEK_VISION_MODEL = "deepseek-v4-flash-vision-exp";
export const MAX_CHAT_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_CHAT_IMAGES = 1;

export const SUPPORTED_CHAT_IMAGE_TYPES = Object.freeze([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

const SUPPORTED_TYPE_SET = new Set(SUPPORTED_CHAT_IMAGE_TYPES);

export function validateChatImage(file, currentCount = 0) {
  if (!file || typeof file.arrayBuffer !== "function") return "IMAGE_REQUIRED";
  if (currentCount >= MAX_CHAT_IMAGES) return "IMAGE_COUNT_EXCEEDED";
  if (!SUPPORTED_TYPE_SET.has(file.type)) return "IMAGE_TYPE_INVALID";
  if (!Number.isFinite(file.size) || file.size <= 0) return "IMAGE_EMPTY";
  if (file.size > MAX_CHAT_IMAGE_BYTES) return "IMAGE_TOO_LARGE";
  return "";
}

function detectImageMime(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return "image/png";
  const ascii = (start, end) => String.fromCharCode(...bytes.slice(start, end));
  if (["GIF87a", "GIF89a"].includes(ascii(0, 6))) return "image/gif";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  return "";
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

export async function prepareChatImage(file) {
  const validationError = validateChatImage(file);
  if (validationError) throw Object.assign(new Error(validationError), { code: validationError });

  const bytes = new Uint8Array(await file.arrayBuffer());
  if (detectImageMime(bytes) !== file.type) {
    throw Object.assign(new Error("IMAGE_SIGNATURE_INVALID"), { code: "IMAGE_SIGNATURE_INVALID" });
  }

  return {
    name: String(file.name || "image").replace(/[\u0000-\u001f\u007f]+/gu, " ").trim().slice(0, 160) || "image",
    mimeType: file.type,
    dataUrl: `data:${file.type};base64,${bytesToBase64(bytes)}`,
  };
}

export function buildVisionMessages(messages, { images = [], prompt = "", detail = "original" } = {}) {
  const output = Array.isArray(messages) ? messages.map(message => ({ ...message })) : [];
  if (!images.length) return output;

  let userIndex = -1;
  for (let index = output.length - 1; index >= 0; index -= 1) {
    if (output[index]?.role === "user") {
      userIndex = index;
      break;
    }
  }
  if (userIndex < 0) throw new TypeError("Vision input requires a user message");

  const content = [{
    type: "text",
    text: String(prompt || "请描述并分析这张图片。"),
  }];
  for (const image of images.slice(0, MAX_CHAT_IMAGES)) {
    if (!SUPPORTED_TYPE_SET.has(image?.mimeType)) throw new TypeError("Unsupported image type");
    const expectedPrefix = `data:${image.mimeType};base64,`;
    if (typeof image.dataUrl !== "string" || !image.dataUrl.startsWith(expectedPrefix)) {
      throw new TypeError("Invalid image data URL");
    }
    content.push({
      type: "image_url",
      image_url: { url: image.dataUrl, detail },
    });
  }

  output[userIndex] = { ...output[userIndex], content };
  return output;
}
