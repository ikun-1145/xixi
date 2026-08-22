import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  buildVisionMessages,
  createVisionHistoryMessage,
  DEEPSEEK_VISION_MODEL,
  getVisionHistoryPreviews,
  MAX_CHAT_IMAGE_BYTES,
  MAX_CHAT_IMAGE_DIMENSION,
  MAX_CHAT_IMAGE_PREVIEW_BYTES,
  MAX_CHAT_IMAGE_PREVIEW_DIMENSION,
  MAX_PREPARED_CHAT_IMAGE_BYTES,
  prepareChatImage,
  validateChatImage,
} from "../ai/multimodal.js";

const VALID_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=";

function tinyPng(type = "image/png") {
  const bytes = Uint8Array.from(Buffer.from(VALID_PNG_BASE64, "base64"));
  return new File([bytes], "evidence.png", { type });
}

test("chat image preparation verifies the file signature and creates a bounded data URL", async () => {
  const image = await prepareChatImage(tinyPng());
  assert.equal(DEEPSEEK_VISION_MODEL, "deepseek-v4-flash-vision-exp");
  assert.equal(image.mimeType, "image/png");
  assert.equal(image.dataUrl, `data:image/png;base64,${VALID_PNG_BASE64}`);
  assert.equal(image.previewMimeType, "image/png");
  assert.equal(image.previewDataUrl, image.dataUrl);
  assert.ok(image.previewSize <= MAX_CHAT_IMAGE_PREVIEW_BYTES);
  await assert.rejects(
    () => prepareChatImage(tinyPng("image/jpeg")),
    error => error.code === "IMAGE_SIGNATURE_INVALID",
  );
});

test("large chat images are compressed below the request-safe limit before base64 encoding", async () => {
  const oversizedPng = new File([
    Uint8Array.from(Buffer.from(VALID_PNG_BASE64, "base64")),
    new Uint8Array(MAX_PREPARED_CHAT_IMAGE_BYTES),
  ], "large.png", { type: "image/png" });
  const compressedJpeg = new File([
    Uint8Array.of(0xff, 0xd8, 0xff, 0xd9),
  ], "large.jpg", { type: "image/jpeg" });
  let compressionOptions;

  const image = await prepareChatImage(oversizedPng, {
    compressImage: async (_file, options) => {
      compressionOptions = options;
      return compressedJpeg;
    },
  });

  assert.deepEqual(compressionOptions, {
    targetBytes: MAX_PREPARED_CHAT_IMAGE_BYTES,
    maxDimension: MAX_CHAT_IMAGE_DIMENSION,
  });
  assert.equal(image.mimeType, "image/jpeg");
  assert.equal(image.size, compressedJpeg.size);
  assert.equal(image.originalSize, oversizedPng.size);
  assert.equal(image.compressed, true);
  assert.equal(image.dataUrl, "data:image/jpeg;base64,/9j/2Q==");
  assert.equal(image.previewDataUrl, image.dataUrl);
});

test("conversation thumbnails are compressed separately from the model image", async () => {
  const mediumPng = new File([
    Uint8Array.from(Buffer.from(VALID_PNG_BASE64, "base64")),
    new Uint8Array(MAX_CHAT_IMAGE_PREVIEW_BYTES),
  ], "medium.png", { type: "image/png" });
  const previewJpeg = new File([
    Uint8Array.of(0xff, 0xd8, 0xff, 0xd9),
  ], "preview.jpg", { type: "image/jpeg" });
  let compressionOptions;

  const image = await prepareChatImage(mediumPng, {
    compressImage: async (_file, options) => {
      compressionOptions = options;
      return previewJpeg;
    },
  });

  assert.equal(image.mimeType, "image/png");
  assert.ok(image.size > MAX_CHAT_IMAGE_PREVIEW_BYTES);
  assert.deepEqual(compressionOptions, {
    targetBytes: MAX_CHAT_IMAGE_PREVIEW_BYTES,
    maxDimension: MAX_CHAT_IMAGE_PREVIEW_DIMENSION,
  });
  assert.equal(image.previewMimeType, "image/jpeg");
  assert.equal(image.previewDataUrl, "data:image/jpeg;base64,/9j/2Q==");
  assert.equal(image.previewSize, previewJpeg.size);
});

test("a thumbnail failure never blocks a valid model image upload", async () => {
  const mediumPng = new File([
    Uint8Array.from(Buffer.from(VALID_PNG_BASE64, "base64")),
    new Uint8Array(MAX_CHAT_IMAGE_PREVIEW_BYTES),
  ], "medium.png", { type: "image/png" });

  const image = await prepareChatImage(mediumPng, {
    compressImage: async () => {
      const error = new Error("preview failed");
      error.code = "IMAGE_COMPRESSION_FAILED";
      throw error;
    },
  });

  assert.equal(image.mimeType, "image/png");
  assert.match(image.dataUrl, /^data:image\/png;base64,/u);
  assert.equal(image.previewDataUrl, "");
  assert.deepEqual(createVisionHistoryMessage("仍可发送", [image]), {
    role: "user",
    content: "仍可发送",
  });
});

test("chat image preparation rejects compressor output that can still trigger a 413", async () => {
  const oversizedPng = new File([
    Uint8Array.from(Buffer.from(VALID_PNG_BASE64, "base64")),
    new Uint8Array(MAX_PREPARED_CHAT_IMAGE_BYTES),
  ], "large.png", { type: "image/png" });

  await assert.rejects(
    () => prepareChatImage(oversizedPng, {
      compressImage: async () => new File([
        Uint8Array.of(0xff, 0xd8, 0xff),
        new Uint8Array(MAX_PREPARED_CHAT_IMAGE_BYTES),
      ], "still-large.jpg", { type: "image/jpeg" }),
    }),
    error => error.code === "IMAGE_COMPRESSION_FAILED",
  );
});

test("chat image validation allows one supported image up to eight MiB", () => {
  assert.equal(validateChatImage(tinyPng()), "");
  assert.equal(validateChatImage(tinyPng(), 1), "IMAGE_COUNT_EXCEEDED");
  assert.equal(validateChatImage(new File(["x"], "note.txt", { type: "text/plain" })), "IMAGE_TYPE_INVALID");
  assert.equal(validateChatImage({
    arrayBuffer() {},
    type: "image/png",
    size: MAX_CHAT_IMAGE_BYTES + 1,
  }), "IMAGE_TOO_LARGE");
});

test("vision messages attach the image to the latest user turn without mutating history", async () => {
  const image = await prepareChatImage(tinyPng());
  const messages = [
    { role: "system", content: "Follow the system rules" },
    { role: "user", content: "old question" },
    { role: "assistant", content: "old answer" },
    { role: "user", content: "Describe this image" },
  ];
  const output = buildVisionMessages(messages, {
    images: [image],
    prompt: "Describe this image",
  });

  assert.equal(messages[3].content, "Describe this image");
  assert.equal(output[1].content, "old question");
  assert.deepEqual(output[3].content[0], { type: "text", text: "Describe this image" });
  assert.equal(output[3].content[1].type, "image_url");
  assert.equal(output[3].content[1].image_url.url, image.dataUrl);
  assert.equal(output[3].content[1].image_url.detail, "original");
});

test("conversation image previews survive JSON persistence but are stripped from model requests", async () => {
  const image = await prepareChatImage(tinyPng());
  const persisted = createVisionHistoryMessage("这是什么？", [image]);
  const restored = JSON.parse(JSON.stringify(persisted));

  assert.equal(restored.content, "这是什么？");
  assert.deepEqual(getVisionHistoryPreviews(restored), [{
    type: "image",
    name: "evidence.png",
    mimeType: "image/png",
    dataUrl: `data:image/png;base64,${VALID_PNG_BASE64}`,
  }]);

  const requestMessages = buildVisionMessages([
    { role: "system", content: "system" },
    restored,
  ]);
  assert.equal("imagePreviews" in requestMessages[1], false);
  assert.equal(requestMessages[1].content, "这是什么？");
  assert.equal("imagePreviews" in restored, true);
});

test("conversation history rejects untrusted or oversized image preview metadata", () => {
  const unsafe = {
    role: "user",
    imagePreviews: [{
      type: "image",
      name: "bad.svg",
      mimeType: "image/svg+xml",
      dataUrl: "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
    }],
  };
  assert.deepEqual(getVisionHistoryPreviews(unsafe), []);

  const oversized = {
    role: "user",
    imagePreviews: [{
      type: "image",
      name: "large.png",
      mimeType: "image/png",
      dataUrl: `data:image/png;base64,${"A".repeat(Math.ceil(MAX_CHAT_IMAGE_PREVIEW_BYTES * 4 / 3) + 256)}`,
    }],
  };
  assert.deepEqual(getVisionHistoryPreviews(oversized), []);
});

test("conversation image previews use the bounded image bubble styles", () => {
  const app = fs.readFileSync(new URL("../ai/app.js", import.meta.url), "utf8");
  const styles = fs.readFileSync(new URL("../ai/styles-1.css", import.meta.url), "utf8");

  assert.match(app, /img\.className = "chat-upload-image"/u);
  assert.match(app, /bubble\.classList\.add\("image-bubble"\)/u);
  assert.match(app, /getVisionHistoryPreviews\(m\)/u);
  assert.match(app, /createVisionHistoryMessage\(visionPrompt, visionImages\)/u);
  assert.doesNotMatch(app, /原图未写入对话历史/u);
  assert.match(app, /本地对话缓存保存失败/u);
  assert.match(styles, /\.bubble\.image-bubble\s*\{[^}]*max-width: min\(280px, 68vw\)/su);
  assert.match(styles, /\.chat-upload-image\s*\{[^}]*max-height: 320px/su);
  assert.match(styles, /@media \(max-width: 768px\)[\s\S]*max-width: min\(220px, 68vw\)[\s\S]*max-height: 280px/u);
});
