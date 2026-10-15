import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Layers, Search } from "lucide-react";
import { useDeferredValue, useState } from "react";
import { useSearchParams } from "react-router";
import { ArtifactRows } from "../components/ArtifactList";
import { Empty, Header, Loading, Select } from "../components/ui";
import { api } from "../lib/api";
import { KIND_GROUPS } from "../lib/artifacts";
import type { Agent, Artifact } from "../lib/types";

/** The library: every file and document agents delivered, newest first. */
export default function Artifacts() {
  const [params, setParams] = useSearchParams();
  const agentId = params.get("agent") ?? "";
  const group = params.get("type") ?? "all";
  const [q, setQ] = useState("");
  const query = useDeferredValue(q.trim());
  const agents = useQuery({ queryKey: ["agents"], queryFn: () => api.get<Agent[]>("/api/agents") });
  const kinds = KIND_GROUPS.find((g) => g.value === group)?.kinds ?? [];
  const search = new URLSearchParams({ ...(agentId ? { agentId } : {}), ...(kinds.length ? { kinds: kinds.join(",") } : {}), ...(query ? { q: query } : {}) });
  const list = useQuery({ queryKey: ["artifacts", { agentId, group, query }], queryFn: () => api.get<Artifact[]>(`/api/artifacts?${search}`), placeholderData: keepPreviousData });
  // Filters live in the URL next to the open artifact, so they survive opening one.
  const setFilter = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };
  const filtered = !!(agentId || kinds.length || query);
  return (
    <div>
      <Header title="成果" sub="agent 交给你的文件和文档" />
      <div className="px-4 pb-8 space-y-3">
        <div className="flex flex-wrap gap-2">
          <label className="flex-1 min-w-44 flex items-center gap-2 h-8 px-2.5 rounded-lg border border-line bg-surface text-[13px] focus-within:border-[var(--color-accent)]">
            <Search className="size-3.5 text-muted shrink-0" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索标题或文件名" className="flex-1 min-w-0 bg-transparent outline-none placeholder:text-muted" />
          </label>
          <Select label="类型" className="w-32 shrink-0" value={group} options={KIND_GROUPS} onChange={(v) => setFilter("type", v === "all" ? "" : v)} />
          <Select
            label="agent"
            className="w-32 shrink-0"
            value={agentId}
            options={[{ value: "", label: "全部 agent" }, ...(agents.data ?? []).map((a) => ({ value: a.id, label: `${a.emoji} ${a.name}` }))]}
            onChange={(v) => setFilter("agent", v)}
          />
        </div>
        {list.isLoading ? (
          <Loading />
        ) : !list.data?.length ? (
          filtered ? (
            <Empty title="没有符合条件的成果" hint="换个关键词或筛选条件试试" />
          ) : (
            <Empty icon={<Layers className="size-6" strokeWidth={1.8} />} title="还没有成果" hint="agent 发给你的文件，和它写的文档、网页、代码，都会收在这里" />
          )
        ) : (
          <>
            <ArtifactRows items={list.data} />
            <div className="px-1 text-xs text-muted tabular-nums">共 {list.data.length} 个</div>
          </>
        )}
      </div>
    </div>
  );
}
