export default {
  async scheduled(event, env, ctx) {
    await checkOrders(env);
  },

  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/test") {
      await checkOrders(env);
      return new Response("手动执行完成");
    }

    return new Response("ok");
  }
};

async function checkOrders(env) {
  const ts = Math.floor(Date.now() / 1000);

  const params = JSON.stringify({ page: 1 });

  const raw = `params${params}ts${ts}user_id${env.USER_ID}`;
  const sign = await md5(env.TOKEN + raw);

  const res = await fetch("https://ifdian.net/api/open/query-order", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      user_id: env.USER_ID,
      params: params,
      ts: ts,
      sign: sign
    })
  });

  const data = await res.json();

  if (!data || !data.data || !Array.isArray(data.data.list)) {
    console.log("⚠️ query-order 返回异常:", JSON.stringify(data));
    return;
  }

  for (const order of data.data.list) {
    if (order.status !== 2) continue;

    const orderId = order.out_trade_no;

    // 🧱 幂等：已处理过的订单直接跳过
    const existed = await env.ORDERS.get(orderId);
    if (existed) continue;

    // ✅ 绑定键：前端通过爱发电 ?remark= 传入 Supabase userId。
    //    优先读 remark，其次 custom_order_id（两种绑定方式都兼容）。
    const userId = (order.remark || order.custom_order_id || "").trim();

    if (!userId) {
      console.log("⚠️ 订单无 remark/custom_order_id，跳过:", orderId);
      continue;
    }

    // 🚀 写入 Supabase（永久 Pro），service_role key 绕过 RLS。
    //    用 upsert（merge-duplicates）：用户 user_profiles 行不存在时自动创建，
    //    避免「付款用户尚无 profile 行 → PATCH 命中 0 行 → 漏开 Pro」。
    const updateRes = await fetch(
      `${env.SUPABASE_URL}/rest/v1/user_profiles`,
      {
        method: "POST",
        headers: {
          "apikey": env.SUPABASE_KEY,
          "Authorization": `Bearer ${env.SUPABASE_KEY}`,
          "Content-Type": "application/json",
          "Prefer": "resolution=merge-duplicates,return=representation"
        },
        body: JSON.stringify({ user_id: userId, pro: true })
      }
    );

    const text = await updateRes.text();

    // ❗只有写库成功才落幂等键；失败则不落键，下次 cron 自动重试，
    //   避免"已付款但因临时故障漏开 Pro 且永不重试"。
    if (!updateRes.ok) {
      console.log("❌ Supabase 更新失败，保留待重试:", orderId, updateRes.status, text);
      continue;
    }

    await env.ORDERS.put(orderId, "1");

    let matched = 0;
    try { matched = JSON.parse(text).length; } catch {}
    if (matched === 0) {
      console.log("⚠️ 写库成功但未匹配到用户(请核对 userId):", userId, "order:", orderId);
    } else {
      console.log("✅ 已开通永久Pro:", userId, "order:", orderId);
    }
  }
}

// MD5函数
async function md5(str) {
  return md5Hex(str);
}

function md5Hex(input) {
  const bytes = new TextEncoder().encode(input);
  const words = bytesToWords(bytes);
  const bitLength = bytes.length * 8;

  words[bitLength >> 5] |= 0x80 << (bitLength % 32);
  words[(((bitLength + 64) >>> 9) << 4) + 14] = bitLength;

  let a = 1732584193;
  let b = -271733879;
  let c = -1732584194;
  let d = 271733878;

  for (let i = 0; i < words.length; i += 16) {
    const oldA = a;
    const oldB = b;
    const oldC = c;
    const oldD = d;

    a = ff(a, b, c, d, words[i], 7, -680876936);
    d = ff(d, a, b, c, words[i + 1], 12, -389564586);
    c = ff(c, d, a, b, words[i + 2], 17, 606105819);
    b = ff(b, c, d, a, words[i + 3], 22, -1044525330);
    a = ff(a, b, c, d, words[i + 4], 7, -176418897);
    d = ff(d, a, b, c, words[i + 5], 12, 1200080426);
    c = ff(c, d, a, b, words[i + 6], 17, -1473231341);
    b = ff(b, c, d, a, words[i + 7], 22, -45705983);
    a = ff(a, b, c, d, words[i + 8], 7, 1770035416);
    d = ff(d, a, b, c, words[i + 9], 12, -1958414417);
    c = ff(c, d, a, b, words[i + 10], 17, -42063);
    b = ff(b, c, d, a, words[i + 11], 22, -1990404162);
    a = ff(a, b, c, d, words[i + 12], 7, 1804603682);
    d = ff(d, a, b, c, words[i + 13], 12, -40341101);
    c = ff(c, d, a, b, words[i + 14], 17, -1502002290);
    b = ff(b, c, d, a, words[i + 15], 22, 1236535329);

    a = gg(a, b, c, d, words[i + 1], 5, -165796510);
    d = gg(d, a, b, c, words[i + 6], 9, -1069501632);
    c = gg(c, d, a, b, words[i + 11], 14, 643717713);
    b = gg(b, c, d, a, words[i], 20, -373897302);
    a = gg(a, b, c, d, words[i + 5], 5, -701558691);
    d = gg(d, a, b, c, words[i + 10], 9, 38016083);
    c = gg(c, d, a, b, words[i + 15], 14, -660478335);
    b = gg(b, c, d, a, words[i + 4], 20, -405537848);
    a = gg(a, b, c, d, words[i + 9], 5, 568446438);
    d = gg(d, a, b, c, words[i + 14], 9, -1019803690);
    c = gg(c, d, a, b, words[i + 3], 14, -187363961);
    b = gg(b, c, d, a, words[i + 8], 20, 1163531501);
    a = gg(a, b, c, d, words[i + 13], 5, -1444681467);
    d = gg(d, a, b, c, words[i + 2], 9, -51403784);
    c = gg(c, d, a, b, words[i + 7], 14, 1735328473);
    b = gg(b, c, d, a, words[i + 12], 20, -1926607734);

    a = hh(a, b, c, d, words[i + 5], 4, -378558);
    d = hh(d, a, b, c, words[i + 8], 11, -2022574463);
    c = hh(c, d, a, b, words[i + 11], 16, 1839030562);
    b = hh(b, c, d, a, words[i + 14], 23, -35309556);
    a = hh(a, b, c, d, words[i + 1], 4, -1530992060);
    d = hh(d, a, b, c, words[i + 4], 11, 1272893353);
    c = hh(c, d, a, b, words[i + 7], 16, -155497632);
    b = hh(b, c, d, a, words[i + 10], 23, -1094730640);
    a = hh(a, b, c, d, words[i + 13], 4, 681279174);
    d = hh(d, a, b, c, words[i], 11, -358537222);
    c = hh(c, d, a, b, words[i + 3], 16, -722521979);
    b = hh(b, c, d, a, words[i + 6], 23, 76029189);
    a = hh(a, b, c, d, words[i + 9], 4, -640364487);
    d = hh(d, a, b, c, words[i + 12], 11, -421815835);
    c = hh(c, d, a, b, words[i + 15], 16, 530742520);
    b = hh(b, c, d, a, words[i + 2], 23, -995338651);

    a = ii(a, b, c, d, words[i], 6, -198630844);
    d = ii(d, a, b, c, words[i + 7], 10, 1126891415);
    c = ii(c, d, a, b, words[i + 14], 15, -1416354905);
    b = ii(b, c, d, a, words[i + 5], 21, -57434055);
    a = ii(a, b, c, d, words[i + 12], 6, 1700485571);
    d = ii(d, a, b, c, words[i + 3], 10, -1894986606);
    c = ii(c, d, a, b, words[i + 10], 15, -1051523);
    b = ii(b, c, d, a, words[i + 1], 21, -2054922799);
    a = ii(a, b, c, d, words[i + 8], 6, 1873313359);
    d = ii(d, a, b, c, words[i + 15], 10, -30611744);
    c = ii(c, d, a, b, words[i + 6], 15, -1560198380);
    b = ii(b, c, d, a, words[i + 13], 21, 1309151649);
    a = ii(a, b, c, d, words[i + 4], 6, -145523070);
    d = ii(d, a, b, c, words[i + 11], 10, -1120210379);
    c = ii(c, d, a, b, words[i + 2], 15, 718787259);
    b = ii(b, c, d, a, words[i + 9], 21, -343485551);

    a = add32(a, oldA);
    b = add32(b, oldB);
    c = add32(c, oldC);
    d = add32(d, oldD);
  }

  return [a, b, c, d].map(toHexLE).join("");
}

function bytesToWords(bytes) {
  const words = [];
  for (let i = 0; i < bytes.length; i += 1) {
    words[i >> 2] = (words[i >> 2] || 0) | (bytes[i] << ((i % 4) * 8));
  }
  return words;
}

function cmn(q, a, b, x, s, t) {
  return add32(rotl(add32(add32(a, q), add32(x, t)), s), b);
}

function ff(a, b, c, d, x, s, t) {
  return cmn((b & c) | (~b & d), a, b, x, s, t);
}

function gg(a, b, c, d, x, s, t) {
  return cmn((b & d) | (c & ~d), a, b, x, s, t);
}

function hh(a, b, c, d, x, s, t) {
  return cmn(b ^ c ^ d, a, b, x, s, t);
}

function ii(a, b, c, d, x, s, t) {
  return cmn(c ^ (b | ~d), a, b, x, s, t);
}

function rotl(value, shift) {
  return (value << shift) | (value >>> (32 - shift));
}

function add32(a, b) {
  return (a + b) | 0;
}

function toHexLE(value) {
  const normalized = value >>> 0;
  return [
    normalized & 0xff,
    (normalized >>> 8) & 0xff,
    (normalized >>> 16) & 0xff,
    (normalized >>> 24) & 0xff
  ].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
