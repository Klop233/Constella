import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { Brain, CalendarClock, ChevronsUpDown, ClipboardCheck, Gauge, House, Layers, LogOut, Monitor, Palette, Plus, Search, Settings as SettingsIcon, Shield, SlidersHorizontal, Sparkles, ExternalLink, X } from "lucide-react";
import { lazy, StrictMode, Suspense, useEffect, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, NavLink, Route, Routes, useLocation, useNavigate, useSearchParams } from "react-router";
import { registerSW } from "virtual:pwa-register";
import { cx, Loading, MenuDivider, MenuItem, navItemClass, Popover } from "./components/ui";
import "./index.css";
import "./lib/appearance";
import { api, ApiError, logout } from "./lib/api";
import { startLive } from "./lib/live";
import type { Approval, Overview } from "./lib/types";
import { ApprovalCard } from "./components/ApprovalCard";
import Home from "./pages/Home";
import Login from "./pages/Login";

const AgentDetail = lazy(() => import("./pages/AgentDetail"));
const AgentEdit = lazy(() => import("./pages/AgentEdit"));
const Chat = lazy(() => import("./pages/Chat"));
const Desktops = lazy(() => import("./pages/Desktops"));
const DesktopView = lazy(() => import("./pages/DesktopView"));
const Tasks = lazy(() => import("./pages/Tasks"));
const Learning = lazy(() => import("./pages/Learning"));
const Settings = lazy(() => import("./pages/Settings"));
const Reflect = lazy(() => import("./pages/Reflect"));
const Usage = lazy(() => import("./pages/Usage"));
const Audit = lazy(() => import("./pages/Audit"));
const Artifacts = lazy(() => import("./pages/Artifacts"));
const ArtifactViewer = lazy(() => import("./components/ArtifactViewer"));

const qc = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (n, err) => !(err instanceof ApiError && err.status < 500) && n < 2,
      staleTime: 10_000,
      refetchOnWindowFocus: true,
    },
  },
});

registerSW({ immediate: true });

interface AuthStatus {
  setupNeeded: boolean;
  loggedIn: boolean;
}

function Gate({ children }: { children: ReactNode }) {
  const status = useQuery({ queryKey: ["auth"], queryFn: () => api.get<AuthStatus>("/api/auth/status"), staleTime: 60_000 });
  useEffect(() => {
    const onUnauthorized = () => void qc.invalidateQueries({ queryKey: ["auth"] });
    window.addEventListener("constella:unauthorized", onUnauthorized);
    return () => window.removeEventListener("constella:unauthorized", onUnauthorized);
  }, []);
  const loggedIn = status.data?.loggedIn;
  useEffect(() => (loggedIn ? startLive(qc) : undefined), [loggedIn]);
  if (status.isLoading) return <Loading />;
  if (!status.data?.loggedIn) return <Login setupNeeded={!!status.data?.setupNeeded} onDone={() => qc.invalidateQueries()} />;
  return <>{children}</>;
}

const TABS = [
  { to: "/", label: "首页", icon: House, end: true },
  { to: "/desktops", label: "桌面", icon: Monitor },
  { to: "/tasks", label: "任务", icon: CalendarClock },
  { to: "/learning", label: "学习", icon: Brain },
  { to: "/settings", label: "设置", icon: SettingsIcon },
];

// Desktop sidebar: the mobile tabs minus 设置 (it lives in the account row), plus pages without a mobile tab.
const NAV = [
  ...TABS.filter((t) => t.to !== "/settings"),
  { to: "/artifacts", label: "成果", icon: Layers, end: false },
  { to: "/audit", label: "审计", icon: ClipboardCheck, end: false },
  { to: "/usage", label: "用量", icon: Gauge, end: false },
  { to: "/reflect", label: "回顾", icon: Sparkles, end: false },
];

/** Conversation bullet, like Claude Code's session dots: hollow when idle, colored while something is going on. */
function StatusDot({ status }: { status?: string | null }) {
  if (status === "running" || status === "queued") return <span className="size-2 rounded-full bg-accent pulse-dot shrink-0" />;
  if (status === "waiting_approval" || status === "paused_by_user") return <span className="size-2 rounded-full bg-[var(--warn)] shrink-0" />;
  if (status === "failed") return <span className="size-2 rounded-full bg-[var(--danger)] shrink-0" />;
  return <span className="size-2 rounded-full border border-[var(--muted)] opacity-60 shrink-0" />;
}

/** Account row at the bottom of the sidebar; opens a Claude Code-style menu upward. */
function AccountMenu({ name }: { name: string }) {
  const nav = useNavigate();
  return (
    <Popover
      label="账户菜单"
      side="top"
      align="left"
      className="w-60 p-1.5"
      triggerClassName="w-full flex items-center gap-2.5 h-9 px-2.5 rounded-md text-[13.5px] hover:bg-[color-mix(in_oklab,var(--text)_5%,transparent)] aria-expanded:bg-[color-mix(in_oklab,var(--text)_9%,transparent)]"
      trigger={
        <>
          <span className="size-5 rounded-full bg-[color-mix(in_oklab,var(--text)_14%,transparent)] grid place-items-center text-[11px] font-medium uppercase">{name.slice(0, 1)}</span>
          <span className="flex-1 truncate text-left">{name}</span>
          <ChevronsUpDown className="size-3.5 text-muted" />
        </>
      }
    >
      {(close) => {
        const go = (to: string) => () => {
          close();
          nav(to);
        };
        return (
          <>
            <div className="px-2.5 pt-1 pb-1.5 text-xs text-muted truncate">{name}</div>
            <MenuItem icon={<SettingsIcon />} label="设置" hint="Ctrl+," onClick={go("/settings")} />
            <MenuItem icon={<Layers />} label="成果" onClick={go("/artifacts")} />
            <MenuItem icon={<ClipboardCheck />} label="审计" onClick={go("/audit")} />
            <MenuItem icon={<Gauge />} label="用量" onClick={go("/usage")} />
            <MenuItem icon={<Sparkles />} label="回顾" onClick={go("/reflect")} />
            <MenuDivider />
            <MenuItem icon={<Palette />} label="外观" onClick={go("/settings?s=appearance")} />
            <MenuItem icon={<Shield />} label="安全与登录设备" onClick={go("/settings?s=security")} />
            <MenuDivider />
            <MenuItem
              icon={<LogOut />}
              label="退出登录"
              onClick={() => {
                close();
                logout(qc);
              }}
            />
          </>
        );
      }}
    </Popover>
  );
}

function Sidebar() {
  const overview = useQuery({ queryKey: ["overview"], queryFn: () => api.get<Overview>("/api/overview"), refetchInterval: 30_000 });
  const me = useQuery({ queryKey: ["me"], queryFn: () => api.get<{ name: string }>("/api/me"), staleTime: 300_000 });
  const [q, setQ] = useState("");
  const item = ({ isActive }: { isActive: boolean }) => cx(navItemClass(isActive), "h-7 text-[13px]");
  const needle = q.trim().toLowerCase();
  const groups = (overview.data?.agents ?? []).map((a) => ({
    agent: a,
    convs: (overview.data?.conversations ?? []).filter((c) => c.agent_id === a.id && (!needle || c.title.toLowerCase().includes(needle) || a.name.toLowerCase().includes(needle))),
  }));
  const name = me.data?.name ?? "";
  const toHandle = overview.data?.incidents?.length ?? 0;
  return (
    <aside className="hidden lg:flex fixed inset-y-0 left-0 z-30 w-64 flex-col border-r border-line bg-sidebar">
      <div className="px-2.5 pt-3 pb-1.5">
        <label className="flex items-center gap-2 h-7 px-2.5 rounded-lg border border-line bg-surface text-[13px] focus-within:border-[var(--color-accent)]">
          <Search className="size-3.5 text-muted shrink-0" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索对话" className="flex-1 min-w-0 bg-transparent outline-none placeholder:text-muted" />
        </label>
      </div>
      <nav className="px-2 space-y-px">
        <NavLink to="/agents/new" className={item}>
          <Plus className="size-4" strokeWidth={1.8} />
          新建 agent
        </NavLink>
        {NAV.map((t) => (
          <NavLink key={t.to} to={t.to} end={t.end} className={item}>
            <t.icon className="size-4" strokeWidth={1.8} />
            <span className="flex-1">{t.label}</span>
            {t.to === "/audit" && toHandle > 0 && <span className="text-[11px] text-warn tabular-nums">{toHandle}</span>}
          </NavLink>
        ))}
      </nav>
      <div className="flex-1 overflow-y-auto px-2 pt-3 pb-2 space-y-3">
        {groups.map(({ agent: a, convs }) =>
          needle && !convs.length ? null : (
            <div key={a.id}>
              <div className="group flex items-center h-7 pl-2.5 pr-1 text-[12.5px] text-muted">
                <NavLink to={`/agents/${a.id}`} className="flex-1 min-w-0 truncate hover:text-[var(--text)]">
                  {a.emoji} {a.name}
                </NavLink>
                <NavLink to={`/agents/${a.id}/chat`} aria-label={`和${a.name}开始新对话`} title="新对话" className="p-1 rounded hover:bg-[color-mix(in_oklab,var(--text)_7%,transparent)] hover:text-[var(--text)]">
                  <Plus className="size-3.5" />
                </NavLink>
                <NavLink to={`/agents/${a.id}/edit`} aria-label={`${a.name}设置`} title="设置" className="p-1 rounded hover:bg-[color-mix(in_oklab,var(--text)_7%,transparent)] hover:text-[var(--text)]">
                  <SlidersHorizontal className="size-3.5" />
                </NavLink>
              </div>
              <div className="space-y-px">
                {convs.slice(0, 8).map((c) => (
                  <NavLink key={c.id} to={`/c/${c.id}`} className={item}>
                    <StatusDot status={c.last_status} />
                    <span className="truncate">{c.title}</span>
                  </NavLink>
                ))}
                {!needle && convs.length > 8 && (
                  <NavLink to={`/agents/${a.id}`} className="block px-2.5 py-1 text-xs text-muted hover:text-[var(--text)]">
                    查看全部
                  </NavLink>
                )}
              </div>
            </div>
          ),
        )}
      </div>
      <div className="border-t border-line p-2">
        <AccountMenu name={name} />
      </div>
    </aside>
  );
}

/** The artifact viewer, on whichever page the URL names one (?artifact=…). */
function ArtifactPanel() {
  const [params] = useSearchParams();
  if (!params.get("artifact")) return null;
  return (
    <Suspense fallback={null}>
      <ArtifactViewer />
    </Suspense>
  );
}

function Shell({ children }: { children: ReactNode }) {
  const loc = useLocation();
  const nav = useNavigate();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === ",") {
        e.preventDefault();
        nav("/settings");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [nav]);
  const hideNav = /^\/(c\/|agents\/[^/]+\/(chat|edit)|agents\/new|desktops\/.)/.test(loc.pathname);
  return (
    <div className="min-h-full">
      <Sidebar />
      {/* While the artifact panel is open on a wide screen, the page makes room for it (--panel-w). */}
      <div className="min-h-full flex flex-col max-w-2xl lg:max-w-none mx-auto lg:pl-64 lg:pr-[var(--panel-w,0px)]">
        <main className={cx("flex-1 w-full lg:max-w-4xl lg:mx-auto lg:px-6", !hideNav && "pb-20 lg:pb-8")}>{children}</main>
      </div>
      {!hideNav && (
        <nav className="lg:hidden fixed bottom-0 inset-x-0 z-30 bg-sidebar/95 backdrop-blur border-t border-line safe-bottom">
          <div className="max-w-2xl mx-auto grid grid-cols-5">
            {TABS.map((t) => (
              <NavLink key={t.to} to={t.to} end={t.end} className={({ isActive }) => cx("flex flex-col items-center gap-0.5 pt-1.5 pb-1 text-[10.5px]", isActive ? "text-[var(--text)] font-medium" : "text-muted")}>
                <t.icon className="size-5" strokeWidth={1.8} />
                {t.label}
              </NavLink>
            ))}
          </div>
        </nav>
      )}
      <ArtifactPanel />
    </div>
  );
}

/**
 * Pending approvals float in from the corner on every page (push doesn't work on plain-HTTP entries),
 * except on the conversation that raised them, which shows the card inline.
 */
function ApprovalPopups() {
  const loc = useLocation();
  const nav = useNavigate();
  const pending = useQuery({ queryKey: ["approvals"], queryFn: () => api.get<Approval[]>("/api/approvals"), refetchInterval: 60_000 });
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const list = (pending.data ?? []).filter((a) => !hidden.has(a.id) && loc.pathname !== `/c/${a.conversation_id}`);
  const total = pending.data?.length ?? 0;
  useEffect(() => {
    const base = "Constella";
    document.title = total ? `(${total}) 待处理 · ${base}` : base;
  }, [total]);
  if (!list.length) return null;
  return (
    <div className="fixed z-[55] inset-x-3 top-3 sm:inset-x-auto sm:top-auto sm:right-4 sm:bottom-4 sm:w-96 space-y-2 safe-top">
      {list.slice(0, 3).map((a) => (
        <ApprovalCard
          key={a.id}
          approval={a}
          className="shadow-xl"
          extra={
            <span className="flex items-center gap-0.5 -mr-1.5">
              {a.conversation_id && (
                <button aria-label="查看对话" title="查看对话" onClick={() => nav(`/c/${a.conversation_id}`)} className="p-1 rounded-md text-muted hover:text-[var(--text)] hover:bg-surface-2">
                  <ExternalLink className="size-3.5" />
                </button>
              )}
              <button aria-label="稍后处理" title="稍后处理" onClick={() => setHidden((s) => new Set(s).add(a.id))} className="p-1 rounded-md text-muted hover:text-[var(--text)] hover:bg-surface-2">
                <X className="size-3.5" />
              </button>
            </span>
          }
        />
      ))}
      {list.length > 3 && <div className="text-xs text-muted text-right">还有 {list.length - 3} 个待审批</div>}
    </div>
  );
}

function Toasts() {
  const [items, setItems] = useState<{ id: number; message: string; tone: string }[]>([]);
  useEffect(() => {
    const on = (e: Event) => {
      const { message, tone } = (e as CustomEvent).detail as { message: string; tone: string };
      const id = Date.now() + Math.random();
      setItems((x) => [...x, { id, message, tone }]);
      setTimeout(() => setItems((x) => x.filter((i) => i.id !== id)), 3200);
    };
    window.addEventListener("constella:toast", on);
    return () => window.removeEventListener("constella:toast", on);
  }, []);
  return (
    <div className="fixed top-3 inset-x-0 z-[60] flex flex-col items-center gap-2 pointer-events-none safe-top">
      {items.map((t) => (
        <div key={t.id} className={cx("px-4 py-2.5 rounded-lg shadow-lg text-sm max-w-[90vw]", t.tone === "danger" ? "bg-[var(--danger)] text-white" : "bg-[var(--text)] text-[var(--bg)]")}>
          {t.message}
        </div>
      ))}
    </div>
  );
}

function App() {
  return (
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        <Toasts />
        <Gate>
          <ApprovalPopups />
          <Shell>
            <Suspense fallback={<Loading />}>
              <Routes>
                <Route path="/" element={<Home />} />
                <Route path="/agents/new" element={<AgentEdit />} />
                <Route path="/agents/:id" element={<AgentDetail />} />
                <Route path="/agents/:id/edit" element={<AgentEdit />} />
                <Route path="/agents/:id/chat" element={<Chat />} />
                <Route path="/c/:conversationId" element={<Chat />} />
                <Route path="/desktops" element={<Desktops />} />
                <Route path="/desktops/:id" element={<DesktopView />} />
                <Route path="/tasks" element={<Tasks />} />
                <Route path="/learning" element={<Learning />} />
                <Route path="/settings" element={<Settings />} />
                <Route path="/reflect" element={<Reflect />} />
                <Route path="/usage" element={<Usage />} />
                <Route path="/audit" element={<Audit />} />
                <Route path="/artifacts" element={<Artifacts />} />
                <Route path="*" element={<Home />} />
              </Routes>
            </Suspense>
          </Shell>
        </Gate>
      </BrowserRouter>
    </QueryClientProvider>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
