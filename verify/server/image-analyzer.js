import { ALLOWED_IMAGE_MIME_TYPES, VERIFY_LIMITS } from "./constants.js";
import { VerifyError } from "./errors.js";
import { cleanText } from "./json-utils.js";

function detectMime(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return "image/png";
  if (String.fromCharCode(...bytes.slice(0, 4)) === "RIFF"
    && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP") return "image/webp";
  return "";
}

function pngDimensions(view) {
  if (view.byteLength < 24) return {};
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

function jpegDimensions(view) {
  let offset = 2;
  while (offset + 9 < view.byteLength) {
    if (view.getUint8(offset) !== 0xff) break;
    const marker = view.getUint8(offset + 1);
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      return { height: view.getUint16(offset + 5), width: view.getUint16(offset + 7) };
    }
    const length = view.getUint16(offset + 2);
    if (length < 2) break;
    offset += 2 + length;
  }
  return {};
}

function webpDimensions(view, bytes) {
  if (view.byteLength < 30 || String.fromCharCode(...bytes.slice(12, 16)) !== "VP8X") return {};
  const width = 1 + view.getUint8(24) + (view.getUint8(25) << 8) + (view.getUint8(26) << 16);
  const height = 1 + view.getUint8(27) + (view.getUint8(28) << 8) + (view.getUint8(29) << 16);
  return { width, height };
}

export async function analyzeImage(file, ocrText, ocrStatus = "complete") {
  if (!file || typeof file.arrayBuffer !== "function") {
    throw new VerifyError("IMAGE_REQUIRED", "请选择需要核验的图片。", 400);
  }
  if (file.size <= 0 || file.size > VERIFY_LIMITS.maxImageBytes) {
    throw new VerifyError("IMAGE_TOO_LARGE", "图片必须小于 5 MB。", 413);
  }
  if (!ALLOWED_IMAGE_MIME_TYPES.includes(file.type)) {
    throw new VerifyError("IMAGE_TYPE_INVALID", "仅支持 JPG、JPEG、PNG 和 WEBP 图片。", 415);
  }

  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const actualMime = detectMime(bytes);
  if (!actualMime || actualMime !== file.type) {
    throw new VerifyError("IMAGE_SIGNATURE_INVALID", "图片内容与声明的文件类型不一致。", 415);
  }
  const view = new DataView(buffer);
  const dimensions = actualMime === "image/png" ? pngDimensions(view)
    : actualMime === "image/jpeg" ? jpegDimensions(view)
      : webpDimensions(view, bytes);
  const content = typeof ocrText === "string" ? cleanText(ocrText, VERIFY_LIMITS.maxOcrChars) : "";
  const limitations = ["图片文字由浏览器端 OCR 提取，可能存在漏字、错字或排版丢失。"];
  if (ocrStatus === "failed") limitations.push("浏览器端 OCR 运行失败，系统未让 DeepSeek 猜测图片内容。");
  if (!dimensions.width || !dimensions.height) limitations.push("未能从文件头可靠读取图片尺寸。");
  if (content.length < 3) limitations.push("OCR 未提取到足够文字，不足以判断图片中的事实内容。");

  return {
    content,
    metadata: {
      fileName: cleanText(file.name, 240) || "image",
      size: file.size,
      mimeType: actualMime,
      ...(dimensions.width ? { width: dimensions.width } : {}),
      ...(dimensions.height ? { height: dimensions.height } : {}),
      extractionMethod: "tesseract.js-browser-ocr",
    },
    limitations,
  };
}

// 预留统一媒体入口；视频第一版明确拒绝，不做伪分析。
export async function analyzeMedia(type, payload) {
  if (type === "image") return analyzeImage(payload.file, payload.ocrText, payload.ocrStatus);
  if (type === "video") {
    throw new VerifyError("VIDEO_NOT_SUPPORTED", "当前版本尚未开放视频核验。", 501);
  }
  throw new VerifyError("INPUT_TYPE_INVALID", "不支持的媒体类型。", 400);
}
