import { startAuthentication } from "@simplewebauthn/browser";
import { Fingerprint } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Button, Field, inputClass } from "../components/ui";
import { api, ApiError } from "../lib/api";

export default function Login({ setupNeeded, onDone }: { setupNeeded: boolean; onDone: () => void }) {
  const [password, setPassword] = useState("");
  const [totp, setTotp] = useState("");
  const [needTotp, setNeedTotp] = useState(false);
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
      onDone();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) setNeedTotp(true);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (setupNeeded) void run(() => api.post("/api/auth/setup", { code, name, password }));
    else void run(() => api.post("/api/auth/login", { password, totp: needTotp ? totp : undefined }));
  };

  const passkey = () =>
    run(async () => {
      const { key, options } = await api.post<{ key: string; options: any }>("/api/auth/passkey/login/options");
      const response = await startAuthentication({ optionsJSON: options });
      await api.post("/api/auth/passkey/login/verify", { key, response });
    });

  return (
    <div className="min-h-full flex items-center justify-center px-6 py-10 safe-top">
      <div className="w-full max-w-sm space-y-8">
        <div className="text-center space-y-3">
          <img src="/icon.svg" alt="" className="size-20 mx-auto rounded-[22px] shadow-lg" />
          <div>
            <h1 className="text-2xl font-semibold">Constella</h1>
            <p className="text-muted text-sm mt-1">{setupNeeded ? "第一次使用：设置你的账号" : "你的 agent 星座"}</p>
          </div>
        </div>
        <form onSubmit={submit} className="space-y-4">
          {setupNeeded && (
            <>
              <Field label="初始化码" hint="在服务器的 deploy/.env 里（CONSTELLA_SETUP_CODE）">
                <input className={inputClass} value={code} onChange={(e) => setCode(e.target.value)} autoComplete="off" required />
              </Field>
              <Field label="你的名字">
                <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} required maxLength={40} />
              </Field>
            </>
          )}
          <Field label="密码" hint={setupNeeded ? "至少 10 位。登录后可以再添加通行密钥（指纹 / 面容）" : undefined}>
            <input
              className={inputClass}
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={setupNeeded ? "new-password" : "current-password"}
              required
            />
          </Field>
          {needTotp && (
            <Field label="两步验证码">
              <input className={inputClass} inputMode="numeric" value={totp} onChange={(e) => setTotp(e.target.value)} autoComplete="one-time-code" autoFocus />
            </Field>
          )}
          {error && <div className="text-sm text-danger">{error}</div>}
          <Button type="submit" variant="primary" size="lg" className="w-full" loading={busy}>
            {setupNeeded ? "创建账号" : "登录"}
          </Button>
        </form>
        {!setupNeeded && (
          <Button variant="secondary" size="lg" className="w-full" onClick={passkey} disabled={busy}>
            <Fingerprint className="size-5" /> 用通行密钥登录
          </Button>
        )}
      </div>
    </div>
  );
}
