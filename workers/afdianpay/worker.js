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

    // 🚀 更新 Supabase（永久 Pro），service_role key 绕过 RLS
    const updateRes = await fetch(
      `${env.SUPABASE_URL}/rest/v1/user_profiles?user_id=eq.${encodeURIComponent(userId)}`,
      {
        method: "PATCH",
        headers: {
          "apikey": env.SUPABASE_KEY,
          "Authorization": `Bearer ${env.SUPABASE_KEY}`,
          "Content-Type": "application/json",
          "Prefer": "return=representation"
        },
        body: JSON.stringify({ pro: true })
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
  const data = new TextEncoder().encode(str);
  const hash = await crypto.subtle.digest("MD5", data);
  return [...new Uint8Array(hash)]
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}
