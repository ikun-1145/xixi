import assert from "node:assert/strict";
import test from "node:test";

import { onRequestGet, onRequestPost } from "../functions/api/verify.js";

const VALID_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=";

function tinyPng() {
  const bytes = Uint8Array.from(Buffer.from(VALID_PNG_BASE64, "base64"));
  return new File([bytes], "claim.png", { type: "image/png" });
}

test("verify capability advertises server-side vision support", async () => {
  const response = await onRequestGet({ env: {} });
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.capabilities.vision, true);
  assert.deepEqual(payload.capabilities.inputTypes, ["text", "image"]);
});

test("verify multipart API forwards a validated image to the vision model without echoing it", async () => {
  let modelRequest = null;
  const gateway = {
    async fetch(request) {
      modelRequest = await request.json();
      return Response.json({ choices: [{ message: { content: '{"claims":[]}' } }] });
    },
  };
  const form = new FormData();
  form.set("type", "image");
  form.set("stage", "extract");
  form.set("locale", "zh");
  form.set("file", tinyPng(), "claim.png");
  form.set("ocrText", "");
  form.set("ocrStatus", "failed");
  const request = new Request("https://sunland.dev/api/verify", {
    method: "POST",
    headers: { authorization: "Bearer valid-test-token" },
    body: form,
  });

  const response = await onRequestPost({ request, env: { AI_GATEWAY: gateway } });
  const body = await response.text();

  assert.equal(response.status, 200);
  assert.equal(modelRequest.model, "deepseek-v4-flash-vision-exp");
  assert.equal(
    modelRequest.messages[1].content[1].image_url.url,
    `data:image/png;base64,${VALID_PNG_BASE64}`,
  );
  assert.doesNotMatch(body, /data:image\/png;base64/u);
  assert.equal(JSON.parse(body).inputMetadata.extractionMethod, "deepseek-vision+browser-ocr");
});
