import { useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { useEffect, useState } from "react";
import { NavLink } from "react-router";
import { api } from "../lib/api";
import { timeAgo } from "../lib/format";
import { AgentAvatar } from "./AgentBits";
import { Sheet, Spinner, cx } from "./ui";

interface SearchHit {
  conversationId: string;
  title: string;
  agentName: string;
  agentEmoji: string;
  archived: boolean;
  updatedAt: string;
  where: "title" | "you" | "agent";
  snippet: string;
}

const WHERE: Record<SearchHit["where"], string> = { title: "标题", you: "你说", agent: "回复" };

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** Conversations whose title, your messages or the agent's replies contain the query. */
export function SearchResults({ q, onPick, dense }: { q: string; onPick?: () => void; dense?: boolean }) {
  const needle = useDebounced(q.trim(), 250);
  const res = useQuery({ queryKey: ["search", needle], queryFn: () => api.get<SearchHit[]>(`/api/search?${new URLSearchParams({ q: needle })}`), enabled: !!needle, staleTime: 10_000 });
  if (!needle) return null;
  if (res.isLoading)
    return (
      <div className="flex justify-center py-3">
        <Spinner />
      </div>
    );
  if (!res.data?.length) return <div className={cx("text-muted py-3", dense ? "px-2.5 text-xs" : "text-center text-[13px]")}>没有找到包含「{needle}」的对话</div>;
  return (
    <div className="space-y-px">
      {res.data.map((h) => (
        <NavLink
          key={h.conversationId}
          to={`/c/${h.conversationId}`}
          onClick={onPick}
          className={({ isActive }) =>
            cx("flex items-start gap-2.5 rounded-md", dense ? "px-2.5 py-1.5" : "px-2 py-2", isActive ? "bg-[color-mix(in_oklab,var(--text)_9%,transparent)]" : "hover:bg-[color-mix(in_oklab,var(--text)_5%,transparent)]")
          }
        >
          {!dense && <AgentAvatar emoji={h.agentEmoji} size="sm" />}
          <span className="flex-1 min-w-0">
            <span className={cx("block truncate", dense ? "text-[13px]" : "text-sm")}>{h.title}</span>
            <span className="block text-xs text-muted truncate">
              {h.where !== "title" && `${WHERE[h.where]}：${h.snippet}`}
              {h.where === "title" && `${h.agentName} · ${timeAgo(h.updatedAt)}${h.archived ? " · 已归档" : ""}`}
            </span>
          </span>
        </NavLink>
      ))}
    </div>
  );
}

/** Phone: a sheet with a search field over all conversations. */
export function SearchSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [q, setQ] = useState("");
  return (
    <Sheet open={open} onClose={onClose} title="搜索对话">
      <div className="space-y-3">
        <label className="flex items-center gap-2 h-8 px-2.5 rounded-lg border border-line bg-surface focus-within:border-[var(--color-accent)]">
          <Search className="size-4 text-muted shrink-0" />
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="标题、你说过的话、agent 的回复" className="flex-1 min-w-0 bg-transparent outline-none text-[13.5px] placeholder:text-muted" />
        </label>
        <SearchResults q={q} onPick={onClose} />
      </div>
    </Sheet>
  );
}
