export const DEEPSEEK_VISION_MODEL = "deepseek-v4-flash-vision-exp";
export const MAX_CHAT_IMAGE_BYTES = 8 * 1024 * 1024;
// Base64 adds about one third to the binary size. Keep prepared images small
// enough to leave ample room for prompts and conversation history in the Worker request.
export const MAX_PREPARED_CHAT_IMAGE_BYTES = 1536 * 1024;
export const MAX_CHAT_IMAGE_DIMENSION = 2048;
// Conversation history stores a display-only thumbnail, never the full image
// sent to the vision model. 48 KiB keeps JSONB/localStorage growth bounded while
// still covering the 220px mobile bubble at roughly retina resolution.
export const MAX_CHAT_IMAGE_PREVIEW_BYTES = 48 * 1024;
export const MAX_CHAT_IMAGE_PREVIEW_DIMENSION = 480;
export const MAX_CHAT_IMAGES = 1;

export const SUPPORTED_CHAT_IMAGE_TYPES = Object.freeze([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

const SUPPORTED_TYPE_SET = new Set(SUPPORTED_CHAT_IMAGE_TYPES);
const SAFE_PREVIEW_DATA_URL_PATTERN = /^data:image\/(?:gif|jpeg|png|webp);base64,[a-z0-9+/]+={0,2}$/i;
const MAX_PREVIEW_DATA_URL_LENGTH = Math.ceil(MAX_CHAT_IMAGE_PREVIEW_BYTES * 4 / 3) + 128;

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

function imagePreparationError(code, cause) {
  const error = new Error(code);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

function fitImageDimensions(width, height, maxDimension) {
  const longestSide = Math.max(width, height);
  const scale = longestSide > maxDimension ? maxDimension / longestSide : 1;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const objectUrl = URL.createObjectURL(file);
    const cleanup = () => URL.revokeObjectURL(objectUrl);

    image.decoding = "async";
    image.onload = () => {
      cleanup();
      resolve(image);
    };
    image.onerror = () => {
      cleanup();
      reject(imagePreparationError("IMAGE_COMPRESSION_FAILED"));
    };
    image.src = objectUrl;
  });
}

function canvasToJpeg(canvas, quality) {
  return new Promise((resolve, reject) => {
    if (typeof canvas.toBlob !== "function") {
      reject(imagePreparationError("IMAGE_COMPRESSION_FAILED"));
      return;
    }
    canvas.toBlob(blob => {
      if (!blob) {
        reject(imagePreparationError("IMAGE_COMPRESSION_FAILED"));
        return;
      }
      resolve(blob);
    }, "image/jpeg", quality);
  });
}

export async function compressChatImage(
  file,
  {
    targetBytes = MAX_PREPARED_CHAT_IMAGE_BYTES,
    maxDimension = MAX_CHAT_IMAGE_DIMENSION,
  } = {},
) {
  try {
    const image = await loadImage(file);
    let dimensions = fitImageDimensions(
      image.naturalWidth || image.width,
      image.naturalHeight || image.height,
      maxDimension,
    );
    if (!dimensions.width || !dimensions.height) {
      throw imagePreparationError("IMAGE_COMPRESSION_FAILED");
    }

    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw imagePreparationError("IMAGE_COMPRESSION_FAILED");

    const qualitySteps = [0.86, 0.76, 0.66];
    for (let resizeAttempt = 0; resizeAttempt < 6; resizeAttempt += 1) {
      canvas.width = dimensions.width;
      canvas.height = dimensions.height;
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = "high";
      context.drawImage(image, 0, 0, canvas.width, canvas.height);

      for (const quality of qualitySteps) {
        const blob = await canvasToJpeg(canvas, quality);
        if (blob.size > 0 && blob.size <= targetBytes) return blob;
      }

      dimensions = {
        width: Math.max(1, Math.round(dimensions.width * 0.8)),
        height: Math.max(1, Math.round(dimensions.height * 0.8)),
      };
    }
  } catch (error) {
    if (error?.code === "IMAGE_COMPRESSION_FAILED") throw error;
    throw imagePreparationError("IMAGE_COMPRESSION_FAILED", error);
  }

  throw imagePreparationError("IMAGE_COMPRESSION_FAILED");
}

export async function prepareChatImage(
  file,
  { compressImage = compressChatImage } = {},
) {
  const validationError = validateChatImage(file);
  if (validationError) throw imagePreparationError(validationError);

  const headerSource = typeof file.slice === "function" ? file.slice(0, 12) : file;
  const header = new Uint8Array(await headerSource.arrayBuffer());
  if (detectImageMime(header) !== file.type) {
    throw imagePreparationError("IMAGE_SIGNATURE_INVALID");
  }

  let preparedFile = file;
  let compressed = false;
  if (file.size > MAX_PREPARED_CHAT_IMAGE_BYTES) {
    try {
      preparedFile = await compressImage(file, {
        targetBytes: MAX_PREPARED_CHAT_IMAGE_BYTES,
        maxDimension: MAX_CHAT_IMAGE_DIMENSION,
      });
      compressed = true;
    } catch (error) {
      if (error?.code === "IMAGE_COMPRESSION_FAILED") throw error;
      throw imagePreparationError("IMAGE_COMPRESSION_FAILED", error);
    }
  }

  if (
    !preparedFile
    || typeof preparedFile.arrayBuffer !== "function"
    || !SUPPORTED_TYPE_SET.has(preparedFile.type)
    || !Number.isFinite(preparedFile.size)
    || preparedFile.size <= 0
    || preparedFile.size > MAX_PREPARED_CHAT_IMAGE_BYTES
  ) {
    throw imagePreparationError("IMAGE_COMPRESSION_FAILED");
  }

  const bytes = new Uint8Array(await preparedFile.arrayBuffer());
  if (detectImageMime(bytes) !== preparedFile.type) {
    throw imagePreparationError(compressed ? "IMAGE_COMPRESSION_FAILED" : "IMAGE_SIGNATURE_INVALID");
  }

  let previewFile = preparedFile.size <= MAX_CHAT_IMAGE_PREVIEW_BYTES
    ? preparedFile
    : null;
  if (preparedFile.size > MAX_CHAT_IMAGE_PREVIEW_BYTES) {
    try {
      previewFile = await compressImage(preparedFile, {
        targetBytes: MAX_CHAT_IMAGE_PREVIEW_BYTES,
        maxDimension: MAX_CHAT_IMAGE_PREVIEW_DIMENSION,
      });
    } catch {
      // A display thumbnail is optional. Never fail a valid model upload only
      // because a browser cannot create the smaller persistence preview.
      previewFile = null;
    }
  }

  let previewBytes = null;
  if (
    previewFile
    && typeof previewFile.arrayBuffer === "function"
    && SUPPORTED_TYPE_SET.has(previewFile.type)
    && Number.isFinite(previewFile.size)
    && previewFile.size > 0
    && previewFile.size <= MAX_CHAT_IMAGE_PREVIEW_BYTES
  ) {
    const candidateBytes = previewFile === preparedFile
      ? bytes
      : new Uint8Array(await previewFile.arrayBuffer());
    if (detectImageMime(candidateBytes) === previewFile.type) {
      previewBytes = candidateBytes;
    }
  }

  const safeName = String(file.name || "image")
    .replace(/[\u0000-\u001f\u007f]+/gu, " ")
    .trim()
    .slice(0, 160) || "image";

  return {
    name: safeName,
    mimeType: preparedFile.type,
    dataUrl: `data:${preparedFile.type};base64,${bytesToBase64(bytes)}`,
    size: preparedFile.size,
    originalSize: file.size,
    compressed,
    previewMimeType: previewBytes ? previewFile.type : "",
    previewDataUrl: previewBytes
      ? `data:${previewFile.type};base64,${bytesToBase64(previewBytes)}`
      : "",
    previewSize: previewBytes ? previewFile.size : 0,
  };
}

export function getVisionHistoryPreviews(message) {
  if (message?.role !== "user" || !Array.isArray(message.imagePreviews)) return [];

  return message.imagePreviews.slice(0, MAX_CHAT_IMAGES).flatMap(preview => {
    const mimeType = String(preview?.mimeType || "").toLowerCase();
    const dataUrl = typeof preview?.dataUrl === "string" ? preview.dataUrl : "";
    if (
      !SUPPORTED_TYPE_SET.has(mimeType)
      || dataUrl.length > MAX_PREVIEW_DATA_URL_LENGTH
      || !SAFE_PREVIEW_DATA_URL_PATTERN.test(dataUrl)
      || !dataUrl.startsWith(`data:${mimeType};base64,`)
    ) return [];

    return [{
      type: "image",
      name: String(preview?.name || "image")
        .replace(/[\u0000-\u001f\u007f]+/gu, " ")
        .trim()
        .slice(0, 160) || "image",
      mimeType,
      dataUrl,
    }];
  });
}

export function createVisionHistoryMessage(content, images = []) {
  const message = {
    role: "user",
    content: String(content ?? ""),
  };
  const imagePreviews = images.slice(0, MAX_CHAT_IMAGES).map(image => ({
    type: "image",
    name: image?.name,
    mimeType: image?.previewMimeType,
    dataUrl: image?.previewDataUrl,
  }));
  const safePreviews = getVisionHistoryPreviews({ ...message, imagePreviews });
  if (safePreviews.length) message.imagePreviews = safePreviews;
  return message;
}

export function buildVisionMessages(messages, { images = [], prompt = "", detail = "original" } = {}) {
  const output = Array.isArray(messages)
    ? messages.map(message => {
      if (!message || typeof message !== "object") return message;
      // imagePreviews is client-only persistence metadata. Never send it to an
      // OpenAI-compatible upstream, which may reject unknown message fields.
      const { imagePreviews: _imagePreviews, ...modelMessage } = message;
      return modelMessage;
    })
    : [];
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
