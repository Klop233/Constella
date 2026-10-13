import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { Brain, CalendarClock, House, Monitor, Plus, Search, Settings as SettingsIcon, SlidersHorizontal, Sparkles } from "lucide-react";
import { lazy, StrictMode, Suspense, useEffect, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, NavLink, Route, Routes, useLocation } from "react-router";
import { registerSW } from "virtual:pwa-register";
import { cx, Loading } from "./components/ui";
import "./index.css";
import "./lib/appearance";
import { api, ApiError } from "./lib/api";
import { startLive } from "./lib/live";
import type { Overview } from "./lib/types";
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
const NAV = [...TABS.filter((t) => t.to !== "/settings"), { to: "/reflect", label: "回顾", icon: Sparkles, end: false }];

/** Conversation bullet, like Claude Code's session dots: hollow when idle, colored while something is going on. */
function StatusDot({ status }: { status?: string | null }) {
  if (status === "running" || status === "queued") return <span className="size-2 rounded-full bg-accent pulse-dot shrink-0" />;
  if (status === "waiting_approval" || status === "paused_by_user") return <span className="size-2 rounded-full bg-[var(--warn)] shrink-0" />;
  if (status === "failed") return <span className="size-2 rounded-full bg-[var(--danger)] shrink-0" />;
  return <span className="size-2 rounded-full border border-[var(--muted)] opacity-60 shrink-0" />;
}

function Sidebar() {
  const overview = useQuery({ queryKey: ["overview"], queryFn: () => api.get<Overview>("/api/overview"), refetchInterval: 30_000 });
  const me = useQuery({ queryKey: ["me"], queryFn: () => api.get<{ name: string }>("/api/me"), staleTime: 300_000 });
  const [q, setQ] = useState("");
  const item = ({ isActive }: { isActive: boolean }) =>
    cx(
      "flex items-center gap-2.5 h-8 px-2.5 rounded-md text-[13.5px] transition-colors",
      isActive ? "bg-[color-mix(in_oklab,var(--text)_9%,transparent)] text-[var(--text)]" : "text-[color-mix(in_oklab,var(--text)_80%,transparent)] hover:bg-[color-mix(in_oklab,var(--text)_5%,transparent)]",
    );
  const needle = q.trim().toLowerCase();
  const groups = (overview.data?.agents ?? []).map((a) => ({
    agent: a,
    convs: (overview.data?.conversations ?? []).filter((c) => c.agent_id === a.id && (!needle || c.title.toLowerCase().includes(needle) || a.name.toLowerCase().includes(needle))),
  }));
  const name = me.data?.name ?? "";
  return (
    <aside className="hidden lg:flex fixed inset-y-0 left-0 z-30 w-64 flex-col border-r border-line bg-sidebar">
      <div className="px-2.5 pt-3 pb-1.5">
        <label className="flex items-center gap-2 h-8 px-2.5 rounded-md border border-line bg-surface text-[13px] focus-within:border-[var(--color-accent)]">
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
            {t.label}
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
        <NavLink to="/settings" className={item}>
          <span className="size-5 rounded-full bg-[color-mix(in_oklab,var(--text)_14%,transparent)] grid place-items-center text-[11px] font-medium uppercase">{name.slice(0, 1)}</span>
          <span className="flex-1 truncate">{name}</span>
          <SettingsIcon className="size-4 text-muted" strokeWidth={1.8} />
        </NavLink>
      </div>
    </aside>
  );
}

function Shell({ children }: { children: ReactNode }) {
  const loc = useLocation();
  const hideNav = /^\/(c\/|agents\/[^/]+\/(chat|edit)|agents\/new|desktops\/.)/.test(loc.pathname);
  return (
    <div className="min-h-full">
      <Sidebar />
      <div className="min-h-full flex flex-col max-w-2xl lg:max-w-none mx-auto lg:pl-64">
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
