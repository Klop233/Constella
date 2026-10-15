import { ArrowUp, Hand, Monitor } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router";
import { api, errorMessage } from "../lib/api";
import { openInstanceWindow } from "../lib/instanceWindow";
import { Button, Card, cx, toast } from "./ui";

export interface DesktopHelp {
  desktopId: string;
  helpId: string;
  reason: string;
  state: "requested" | "taken" | "returned" | "expired";
  note?: string;
}

/**
 * The agent's request to take over its desktop, in the chat: peek in the floating window, take over right here (then operate on the desktop page),
 * and hand it back from here too, with a note for the agent.
 */
export function DesktopHelpCard({ help }: { help: DesktopHelp }) {
  const nav = useNavigate();
  const [busy, setBusy] = useState<"takeover" | "handback" | null>(null);
  const [note, setNote] = useState("");
  const open = () => nav(`/instances/${help.desktopId}`);
  const peek = () => openInstanceWindow(help.desktopId);
  const takeover = async () => {
    setBusy("takeover");
    try {
      await api.post(`/api/desktops/${help.desktopId}/takeover`);
      open();
    } catch (err) {
      toast(errorMessage(err), "danger");
    } finally {
      setBusy(null);
    }
  };
  const handback = async () => {
    setBusy("handback");
    try {
      await api.post(`/api/desktops/${help.desktopId}/handback`, { note: note.trim() });
      toast("已交还，agent 继续操作");
    } catch (err) {
      toast(errorMessage(err), "danger");
    } finally {
      setBusy(null);
    }
  };
  const taken = help.state === "taken";
  return (
    <Card className="p-3.5 border-[color-mix(in_oklab,var(--warn)_45%,transparent)]">
      <div className="flex items-center gap-2 text-sm">
        <Hand className="size-4 text-warn" />
        <span className="font-medium">{taken ? "你正在操作实例" : "需要你接管实例"}</span>
      </div>
      <div className="mt-2 text-sm whitespace-pre-wrap">{help.reason}</div>
      {!taken && (
        <button type="button" onClick={peek} className="mt-2.5 block w-full overflow-hidden rounded-lg border border-line bg-surface-2" aria-label="小窗查看实例">
          <img src={`/api/desktops/${help.desktopId}/screenshot?width=640&h=${help.helpId}`} alt="" className="w-full max-h-56 object-cover object-top" onError={(e) => (e.currentTarget.parentElement!.style.display = "none")} />
        </button>
      )}
      {taken ? (
        <div className="mt-2.5 space-y-2">
          <form
            className="flex items-center gap-1 rounded-lg border border-line bg-surface pl-3 pr-1 focus-within:border-[var(--color-accent)]"
            onSubmit={(e) => {
              e.preventDefault();
              void handback();
            }}
          >
            <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} placeholder="给它留句话（可选），如：已登录" className="flex-1 min-w-0 h-8 bg-transparent text-[13.5px] outline-none placeholder:text-muted" />
            <button type="submit" aria-label="交还并留言" disabled={!note.trim() || !!busy} className={cx("size-6 grid place-items-center rounded-md shrink-0", note.trim() ? "bg-accent text-white" : "bg-surface-2 text-muted")}>
              <ArrowUp className="size-3.5" strokeWidth={2.4} />
            </button>
          </form>
          <div className="grid grid-cols-2 gap-2">
            <Button variant="secondary" onClick={open}>
              <Monitor className="size-4" /> 回到实例
            </Button>
            <Button variant="primary" loading={busy === "handback"} disabled={!!busy} onClick={() => void handback()}>
              交还
            </Button>
          </div>
        </div>
      ) : (
        <div className="mt-2.5 grid grid-cols-2 gap-2">
          <Button variant="secondary" onClick={peek}>
            <Monitor className="size-4" /> 先看看
          </Button>
          <Button variant="primary" loading={busy === "takeover"} disabled={!!busy} onClick={() => void takeover()}>
            <Hand className="size-4" /> 接管
          </Button>
        </div>
      )}
    </Card>
  );
}
