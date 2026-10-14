import { useQuery } from "@tanstack/react-query";
import { Layers } from "lucide-react";
import { api } from "../lib/api";
import { artifactMeta, kindIcon, useArtifactPanel } from "../lib/artifacts";
import { timeAgo } from "../lib/format";
import type { Artifact } from "../lib/types";
import { Card, Popover, cx } from "./ui";

function ArtifactIcon({ a }: { a: Artifact }) {
  const Icon = kindIcon(a.kind, a.filename);
  return (
    <span className="size-8 shrink-0 grid place-items-center rounded-lg bg-[color-mix(in_oklab,var(--text)_6%,transparent)] text-muted">
      <Icon className="size-4" strokeWidth={1.8} />
    </span>
  );
}

/** Artifacts as list rows; a row opens the viewer. */
export function ArtifactRows({ items, showAgent = true }: { items: Artifact[]; showAgent?: boolean }) {
  const { open, openId } = useArtifactPanel();
  return (
    <Card className="divide-y divide-[var(--border)] overflow-hidden">
      {items.map((a) => (
        <button key={a.id} onClick={() => open(a.id)} className={cx("w-full flex items-center gap-3 px-3.5 py-2.5 text-left hover:bg-surface-2", openId === a.id && "bg-surface-2")}>
          <ArtifactIcon a={a} />
          <span className="flex-1 min-w-0">
            <span className="block truncate">{a.title}</span>
            <span className="block truncate text-xs text-muted mt-0.5 tabular-nums">
              {[showAgent && a.agent_name ? `${a.agent_emoji ?? ""} ${a.agent_name}` : null, artifactMeta(a), timeAgo(a.updated_at)].filter(Boolean).join(" · ")}
            </span>
          </span>
        </button>
      ))}
    </Card>
  );
}

/** Header button on a conversation: what it delivered so far, one click from the viewer. Hidden until there is something. */
export function ConversationArtifacts({ conversationId }: { conversationId: string }) {
  const { open } = useArtifactPanel();
  const q = useQuery({ queryKey: ["artifacts", { conversationId }], queryFn: () => api.get<Artifact[]>(`/api/artifacts?conversationId=${conversationId}`) });
  const list = q.data ?? [];
  if (!list.length) return null;
  return (
    <Popover
      label="这个对话的成果"
      side="bottom"
      className="w-80 max-h-[60dvh] overflow-y-auto p-1.5"
      trigger={
        <>
          <Layers className="size-4" strokeWidth={1.8} />
          {list.length}
        </>
      }
    >
      {(close) => (
        <>
          <div className="px-2.5 pt-1 pb-1.5 text-xs text-muted">这个对话的成果</div>
          {list.map((a) => (
            <button
              key={a.id}
              onClick={() => {
                close();
                open(a.id);
              }}
              className="w-full flex items-center gap-2.5 px-2 py-1.5 rounded-md text-left hover:bg-surface-2"
            >
              <ArtifactIcon a={a} />
              <span className="flex-1 min-w-0">
                <span className="block truncate text-[13.5px]">{a.title}</span>
                <span className="block truncate text-xs text-muted tabular-nums">{artifactMeta(a)}</span>
              </span>
            </button>
          ))}
        </>
      )}
    </Popover>
  );
}
