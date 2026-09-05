import { supabase } from "../p/js/supabaseClient.js";

const CONFIG_FIELDS = "maintenance_enabled,maintenance_title,maintenance_message,maintenance_estimated_end";

function uiText(value) {
  return typeof window.SiteI18n?.translate === "function" ? window.SiteI18n.translate(value) : value;
}

export async function getMaintenanceConfig(client = supabase) {
  const timeout = new Promise((resolve) => setTimeout(() => resolve(null), 7000));
  const result = await Promise.race([
    client.from("app_config").select(CONFIG_FIELDS).eq("config_key", "global").maybeSingle(),
    timeout,
  ]);
  return result?.data?.maintenance_enabled === true ? result.data : null;
}

export function showMaintenanceOverlay(config) {
  if (!config || document.getElementById("aiMaintenanceOverlay")) return false;

  const overlay = document.createElement("main");
  overlay.id = "aiMaintenanceOverlay";
  overlay.setAttribute("role", "alertdialog");
  overlay.setAttribute("aria-modal", "true");
  Object.assign(overlay.style, {
    position: "fixed", inset: "0", zIndex: "100001", display: "grid",
    placeItems: "center", padding: "24px", background: "linear-gradient(135deg,#020617,#0f172a)",
    color: "#e2e8f0", textAlign: "center",
  });

  const panel = document.createElement("section");
  Object.assign(panel.style, {
    maxWidth: "440px", padding: "28px", borderRadius: "20px",
    background: "rgba(15,23,42,.92)", border: "1px solid rgba(103,232,249,.3)",
  });
  const title = document.createElement("h1");
  title.textContent = config.maintenance_title || uiText("服务器维护中");
  const message = document.createElement("p");
  message.textContent = config.maintenance_message || uiText("服务器正在进行维护，请稍后再试。");
  Object.assign(message.style, { margin: "14px 0", lineHeight: "1.7", whiteSpace: "pre-wrap" });
  panel.append(title, message);

  if (config.maintenance_estimated_end) {
    const date = new Date(config.maintenance_estimated_end);
    if (!Number.isNaN(date.getTime())) {
      const estimated = document.createElement("p");
      estimated.textContent = `${uiText("预计恢复时间：")}${date.toLocaleString()}`;
      Object.assign(estimated.style, { color: "#94a3b8", fontSize: "13px" });
      panel.append(estimated);
    }
  }

  const links = document.createElement("p");
  Object.assign(links.style, { margin: "22px 0 0" });
  for (const [label, href] of [["设置", "ai_settings.html"], ["公告", "announcements.html"]]) {
    const link = document.createElement("a");
    link.href = href;
    link.textContent = uiText(label);
    Object.assign(link.style, { color: "#67e8f9", margin: "0 10px" });
    links.append(link);
  }
  panel.append(links);
  overlay.append(panel);
  document.body.append(overlay);
  return true;
}

export async function holdForMaintenanceIfEnabled(client = supabase) {
  try {
    return showMaintenanceOverlay(await getMaintenanceConfig(client));
  } catch (error) {
    console.warn("维护状态检查失败，继续加载页面:", error);
    return false;
  }
}

void holdForMaintenanceIfEnabled();
