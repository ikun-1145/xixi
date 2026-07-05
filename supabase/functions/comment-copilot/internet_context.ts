// internet_context.ts
// 中国互联网评论区语境知识库 —— 数据全部存放在同目录的 slang-dictionary.json 里，
// 本文件只负责“读取 JSON + 拼装成一段供模型参考的文字”，不再写死任何黑话内容。
// 想给 AI 增加新的黑话/梗/攻击方式：直接编辑 slang-dictionary.json，无需改动这个文件。
// 用途：让模型理解评论的“真实语义/意图”，而非仅字面意思，从而给出更聪明、更高情商的回复建议。

export interface Entry {
  term: string;    // 黑话/梗/攻击句式的名字或说法
  meaning: string;  // 对应的人话解释（真实含义、使用场景或攻击性质）
}

export interface Category {
  id: string;
  title: string;
  description?: string;
  entries: Entry[];
}

export interface SlangDictionary {
  categories: Category[];
  intentTypes: { description: string; options: string[] };
}

const EMPTY_DICT: SlangDictionary = { categories: [], intentTypes: { description: "", options: [] } };

// 从同目录读取 JSON 数据（仅在模块初次加载/初始脚本求值阶段调用，允许使用同步文件 API）。
// 读取失败时（例如文件缺失/格式错误）优雅降级为空知识库，不影响 Edge Function 正常启动与其余功能。
function loadDictionary(): SlangDictionary {
  try {
    const url = new URL("./slang-dictionary.json", import.meta.url);
    const raw = Deno.readTextFileSync(url);
    const data = JSON.parse(raw);
    const categories = Array.isArray(data?.categories) ? data.categories : [];
    const intentTypes = data?.intentTypes && Array.isArray(data.intentTypes.options)
      ? data.intentTypes
      : EMPTY_DICT.intentTypes;
    return { categories, intentTypes };
  } catch (e) {
    console.error("加载 slang-dictionary.json 失败，将不带互联网黑话语境知识运行：", e);
    return EMPTY_DICT;
  }
}

const DICTIONARY: SlangDictionary = loadDictionary();

// 中文数字（分类数量在合理范围内足够用；超出范围回退为阿拉伯数字，不影响可读性）
const CHINESE_NUMERALS = ["一", "二", "三", "四", "五", "六", "七", "八", "九", "十", "十一", "十二", "十三", "十四", "十五"];
function numeral(n: number): string {
  return CHINESE_NUMERALS[n - 1] ?? String(n);
}

function renderEntries(entries: Entry[]): string {
  return entries.map((x) => `  · ${x.term} —— ${x.meaning}`).join("\n");
}

// 动态渲染为一段供模型参考的中文语境知识（SYSTEM_PROMPT 通过拼接引用本块，自身不写死这些内容）
export function buildContextBlock(): string {
  const lines: string[] = [
    "【中国互联网评论区语境补充知识】",
    "（用于更准确理解评论的真实语义与意图，尤其抖音/快手/B站/小红书/微博评论区；很多话不能只看字面。请把以下知识用于‘分析’与‘意图判断’；是否回复/如何回复仍遵循前述系统规则与所选语气。）",
    "",
  ];

  DICTIONARY.categories.forEach((cat, idx) => {
    const head = cat.description ? `${cat.title}（${cat.description}）` : cat.title;
    lines.push(`${numeral(idx + 1)}、${head}：`);
    lines.push(renderEntries(cat.entries || []));
    lines.push("");
  });

  if (DICTIONARY.intentTypes.options.length) {
    const n = numeral(DICTIONARY.categories.length + 1);
    lines.push(`${n}、意图判断：${DICTIONARY.intentTypes.description || "请结合上述知识推测评论者真实意图"}，从【${DICTIONARY.intentTypes.options.join(" / ")}】中选最贴切的。`);
    lines.push("");
  }

  lines.push("提醒：以上仅为帮助理解语境的背景知识；不要因此降低判断标准、也不要无中生有；信息不足时请在分析中说明。");
  return lines.join("\n");
}
