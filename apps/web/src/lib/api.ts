/** Where a failed request broke: before the app (offline), in front of it (gateway / timeout), or in the app itself. */
export type ApiErrorKind = "network" | "gateway" | "timeout" | "app";

export class ApiError extends Error {
  status: number;
  code?: string;
  kind: ApiErrorKind;
  constructor(status: number, message: string, code?: string, kind: ApiErrorKind = "app") {
    super(message);
    this.status = status;
    this.code = code;
    this.kind = kind;
  }
}

/** Plain-language text for a response that isn't the app's own JSON error (a proxy's HTML page, a bare status). */
function proxyError(status: number): { message: string; kind: ApiErrorKind } {
  if (status === 504 || status === 524 || status === 408) return { message: "请求超时，操作可能仍在后台进行，稍后刷新看看", kind: "timeout" };
  if (status === 502 || status === 503 || (status >= 520 && status <= 530)) return { message: "服务暂时连不上，稍后再试", kind: "gateway" };
  return { message: `请求失败（${status}）`, kind: "app" };
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      credentials: "same-origin",
      headers: { "X-Constella": "1", ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, "网络不通，检查一下连接", undefined, "network");
  }
  if (res.status === 401 && !url.startsWith("/api/auth/")) {
    window.dispatchEvent(new Event("constella:unauthorized"));
  }
  const text = await res.text();
  const data = text ? safeJson(text) : null;
  if (!res.ok) {
    const own = data as { error?: string; code?: string } | null;
    // Only the app's own JSON carries a message worth showing; anything else (an HTML error page from the proxy) gets plain text.
    if (typeof own?.error === "string" && own.error) throw new ApiError(res.status, own.error, own.code);
    const p = proxyError(res.status);
    throw new ApiError(res.status, p.message, own?.code, p.kind);
  }
  return data as T;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** The message to show for anything a request (or the code around it) threw. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export const api = {
  get: <T,>(url: string) => request<T>("GET", url),
  post: <T,>(url: string, body: unknown = {}) => request<T>("POST", url, body),
  patch: <T,>(url: string, body: unknown) => request<T>("PATCH", url, body),
  put: <T,>(url: string, body: unknown) => request<T>("PUT", url, body),
  del: <T,>(url: string) => request<T>("DELETE", url),
};

export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

/** End this session and let the auth gate show the login screen. */
export function logout(qc: { invalidateQueries: () => Promise<unknown> }): void {
  void api.post("/api/auth/logout").then(() => qc.invalidateQueries());
}
