/**
 * App shell — the four-panel "reasoning machine" layout.
 *
 * Panels are placeholders in Stage 1; each becomes its own component under
 * `ui/panels` in later stages:
 *   1. Chat / Input           (Stage 7)
 *   2. Reasoning Process      (Stage 4 + 7)
 *   3. Knowledge Graph        (Stage 6)
 *   4. Knowledge Editor       (Stage 3 + 7)
 */
import { useEffect, useState } from "react";

import { cn } from "@/lib/utils";

type SiteLanguage = "zh" | "zh-Hant" | "en" | "ja" | "ko" | "es";

const copy = {
  zh: {
    title: "Symbolic AI · 可解释推理机",
    pipeline: "输入 → 语言解析 → 知识图谱 → 推理引擎 → 学习 → 答案（无 LLM）",
    stage: "Stage 1 · 脚手架",
    pending: "待实现（后续阶段）",
    panels: [
      ["① 对话 / 输入", "Chat / Input"],
      ["② 推理过程", "Reasoning Process"],
      ["③ 知识图谱", "Knowledge Graph"],
      ["④ 知识编辑器", "Knowledge Editor"],
    ],
  },
  en: {
    title: "Symbolic AI · Explainable Reasoning Engine",
    pipeline: "Input → Language Parsing → Knowledge Graph → Reasoning Engine → Learning → Answer (No LLM)",
    stage: "Stage 1 · Scaffold",
    pending: "Planned for a later stage",
    panels: [
      ["① Chat / Input", "Conversation input"],
      ["② Reasoning Process", "Explainable reasoning"],
      ["③ Knowledge Graph", "Structured facts"],
      ["④ Knowledge Editor", "Edit knowledge"],
    ],
  },
  ja: {
    title: "Symbolic AI · 説明可能な推論エンジン",
    pipeline: "入力 → 言語解析 → 知識グラフ → 推論エンジン → 学習 → 回答（LLMなし）",
    stage: "Stage 1 · スキャフォールド",
    pending: "今後の段階で実装予定",
    panels: [
      ["① 対話 / 入力", "会話入力"],
      ["② 推論過程", "説明可能な推論"],
      ["③ 知識グラフ", "構造化された事実"],
      ["④ 知識エディター", "知識を編集"],
    ],
  },
  "zh-Hant": {
    title: "Symbolic AI · 可解釋推理機",
    pipeline: "輸入 → 語言解析 → 知識圖譜 → 推理引擎 → 學習 → 答案（無 LLM）",
    stage: "Stage 1 · 腳手架",
    pending: "待實現（後續階段）",
    panels: [
      ["① 對話 / 輸入", "對話輸入"],
      ["② 推理過程", "可解釋推理"],
      ["③ 知識圖譜", "結構化事實"],
      ["④ 知識編輯器", "編輯知識"],
    ],
  },
  ko: {
    title: "Symbolic AI · 설명 가능한 추론 엔진",
    pipeline: "입력 → 언어 분석 → 지식 그래프 → 추론 엔진 → 학습 → 답변(LLM 없음)",
    stage: "Stage 1 · 스캐폴드",
    pending: "후속 단계에서 구현 예정",
    panels: [
      ["① 대화 / 입력", "대화 입력"],
      ["② 추론 과정", "설명 가능한 추론"],
      ["③ 지식 그래프", "구조화된 사실"],
      ["④ 지식 편집기", "지식 편집"],
    ],
  },
  es: {
    title: "Symbolic AI · Motor de razonamiento explicable",
    pipeline: "Entrada → Análisis del lenguaje → Grafo de conocimiento → Motor de razonamiento → Aprendizaje → Respuesta (sin LLM)",
    stage: "Stage 1 · Estructura inicial",
    pending: "Previsto para una fase posterior",
    panels: [
      ["① Conversación / Entrada", "Entrada de conversación"],
      ["② Proceso de razonamiento", "Razonamiento explicable"],
      ["③ Grafo de conocimiento", "Hechos estructurados"],
      ["④ Editor de conocimiento", "Editar conocimiento"],
    ],
  },
} as const;

function readSiteLanguage(): SiteLanguage {
  try {
    const stored = window.localStorage.getItem("lang");
    if (["zh", "zh-Hant", "en", "ja", "ko", "es"].includes(stored || "")) {
      return stored as SiteLanguage;
    }
  } catch {
    // Storage can be unavailable in private or restricted browser contexts.
  }

  const browserLanguage = window.navigator.language.toLowerCase();
  if (/^zh-(hant|tw|hk|mo)/u.test(browserLanguage)) return "zh-Hant";
  if (browserLanguage.startsWith("zh")) return "zh";
  if (browserLanguage.startsWith("ja")) return "ja";
  if (browserLanguage.startsWith("ko")) return "ko";
  if (browserLanguage.startsWith("es")) return "es";
  return "en";
}

interface PanelProps {
  title: string;
  subtitle: string;
  pending: string;
  className?: string;
}

function PanelPlaceholder({ title, subtitle, pending, className }: PanelProps) {
  return (
    <section
      className={cn(
        "flex flex-col rounded-lg border border-border bg-card p-4 shadow-sm",
        className,
      )}
    >
      <header className="mb-2 border-b border-border pb-2">
        <h2 className="text-sm font-semibold tracking-wide text-foreground">{title}</h2>
        <p className="text-xs text-muted-foreground">{subtitle}</p>
      </header>
      <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
        {pending}
      </div>
    </section>
  );
}

export default function App() {
  const [language, setLanguage] = useState<SiteLanguage>(readSiteLanguage);
  const text = copy[language];

  useEffect(() => {
    document.documentElement.lang = language === "zh" ? "zh-Hans" : language;
  }, [language]);

  useEffect(() => {
    const handleStorage = (event: StorageEvent) => {
      if (event.key === "lang") setLanguage(readSiteLanguage());
    };
    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, []);

  return (
    <div className="flex h-screen flex-col bg-background">
      <header className="flex items-center justify-between border-b border-border px-6 py-3">
        <div>
          <h1 className="text-base font-bold tracking-tight">{text.title}</h1>
          <p className="text-xs text-muted-foreground">
            {text.pipeline}
          </p>
        </div>
        <span className="rounded-full border border-border px-3 py-1 text-xs text-muted-foreground">
          {text.stage}
        </span>
      </header>

      <main className="grid flex-1 grid-cols-1 gap-3 overflow-hidden p-3 md:grid-cols-2 md:grid-rows-2">
        {text.panels.map(([title, subtitle]) => (
          <PanelPlaceholder key={title} title={title} subtitle={subtitle} pending={text.pending} />
        ))}
      </main>
    </div>
  );
}
