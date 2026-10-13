import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { Brain, CalendarClock, House, Monitor, Settings as SettingsIcon } from "lucide-react";
import { lazy, StrictMode, Suspense, useEffect, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, NavLink, Route, Routes, useLocation } from "react-router";
import { registerSW } from "virtual:pwa-register";
import { cx, Loading } from "./components/ui";
import "./index.css";
import { api, ApiError } from "./lib/api";
import { startLive } from "./lib/live";
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

function Shell({ children }: { children: ReactNode }) {
  const loc = useLocation();
  const hideNav = /^\/(c\/|agents\/[^/]+\/(chat|edit)|agents\/new|desktops\/.)/.test(loc.pathname);
  return (
    <div className="min-h-full flex flex-col max-w-2xl mx-auto">
      <main className={cx("flex-1", !hideNav && "pb-20")}>{children}</main>
      {!hideNav && (
        <nav className="fixed bottom-0 inset-x-0 z-30 bg-surface/95 backdrop-blur border-t border-line safe-bottom">
          <div className="max-w-2xl mx-auto grid grid-cols-5">
            {TABS.map((t) => (
              <NavLink key={t.to} to={t.to} end={t.end} className={({ isActive }) => cx("flex flex-col items-center gap-0.5 pt-2 pb-1.5 text-[11px]", isActive ? "text-accent" : "text-muted")}>
                <t.icon className="size-[22px]" strokeWidth={1.8} />
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
        <div key={t.id} className={cx("px-4 py-2.5 rounded-2xl shadow-lg text-sm max-w-[90vw]", t.tone === "danger" ? "bg-[var(--danger)] text-white" : "bg-[var(--text)] text-[var(--bg)]")}>
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
