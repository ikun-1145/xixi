const PROVIDERS = new Set(["deepseek", "sunland"]);

function text(row, key) {
  const value = row?.[key];
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`Invalid model ${key}`);
  return value.trim();
}

function toModel(row) {
  const provider = text(row, "provider");
  if (!PROVIDERS.has(provider)) throw new TypeError("Unsupported model provider");
  if (!["free_enabled", "pro_enabled", "enabled"].every(key => typeof row[key] === "boolean")) {
    throw new TypeError("Invalid model access flags");
  }
  if (!Number.isInteger(row.sort_order)) throw new TypeError("Invalid model sort order");
  return {
    id: text(row, "id"), provider, displayName: text(row, "display_name"),
    modelName: text(row, "model_name"), freeEnabled: row.free_enabled,
    proEnabled: row.pro_enabled, enabled: row.enabled, sortOrder: row.sort_order,
  };
}

export async function loadModelCatalog(supabase) {
  const { data, error } = await supabase
    .from("ai_models")
    .select("id,provider,display_name,model_name,free_enabled,pro_enabled,enabled,sort_order")
    .eq("enabled", true)
    .order("sort_order")
    .order("id");
  if (error || !Array.isArray(data)) throw error || new TypeError("Invalid model catalogue");
  return data.map(toModel).filter(model => model.enabled).sort(
    (left, right) => left.sortOrder - right.sortOrder || left.id.localeCompare(right.id),
  );
}

export function availableFor(model, isPro) {
  return Boolean(model?.enabled && (isPro ? model.proEnabled : model.freeEnabled));
}

export function findModel(models, provider, modelName) {
  return models.find(model => model.provider === provider && model.modelName === modelName) || null;
}
