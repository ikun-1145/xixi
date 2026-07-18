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
import { cn } from "@/lib/utils";

interface PanelProps {
  title: string;
  subtitle: string;
  className?: string;
}

function PanelPlaceholder({ title, subtitle, className }: PanelProps) {
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
        待实现（后续阶段）
      </div>
    </section>
  );
}

export default function App() {
  return (
    <div className="flex h-screen flex-col bg-background">
      <header className="flex items-center justify-between border-b border-border px-6 py-3">
        <div>
          <h1 className="text-base font-bold tracking-tight">Symbolic AI · 可解释推理机</h1>
          <p className="text-xs text-muted-foreground">
            输入 → 语言解析 → 知识图谱 → 推理引擎 → 学习 → 答案（无 LLM）
          </p>
        </div>
        <span className="rounded-full border border-border px-3 py-1 text-xs text-muted-foreground">
          Stage 1 · 脚手架
        </span>
      </header>

      <main className="grid flex-1 grid-cols-1 gap-3 overflow-hidden p-3 md:grid-cols-2 md:grid-rows-2">
        <PanelPlaceholder title="① 对话 / 输入" subtitle="Chat / Input" />
        <PanelPlaceholder title="② 推理过程" subtitle="Reasoning Process" />
        <PanelPlaceholder title="③ 知识图谱" subtitle="Knowledge Graph" />
        <PanelPlaceholder title="④ 知识编辑器" subtitle="Knowledge Editor" />
      </main>
    </div>
  );
}
