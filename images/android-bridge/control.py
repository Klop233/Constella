"""Control API for an Android instance (stdlib only; drives the device through adb).

Same endpoints as the desktop image's control.py (/health, /screenshot, /action, /clipboard, /launch) so the hub
treats every instance alike, plus Android-only ones: /ui, /apps, /apps/install, /gsf-id.
Only reachable on the internal network; the hub enforces leases and auth in front of it.
"""
import base64
import json
import os
import re
import struct
import subprocess
import tempfile
import threading
import time
import xml.etree.ElementTree as ET
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

SERIAL = os.environ.get("ANDROID_ADB", "localhost:5555")
KEYBOARD_APK = "/opt/constella/ADBKeyboard.apk"
KEYBOARD_IME = "com.android.adbkeyboard/.AdbIME"
KEYCODES = {
    "back": 4, "home": 3, "recents": 187, "app_switch": 187, "menu": 82, "enter": 66, "return": 66,
    "delete": 67, "backspace": 67, "del": 112, "forward_delete": 112, "tab": 61, "escape": 111, "esc": 111,
    "space": 62, "up": 19, "down": 20, "left": 21, "right": 22, "pageup": 92, "pagedown": 93,
    "home_key": 122, "end": 123, "power": 26, "volume_up": 24, "volume_down": 25, "search": 84,
    "ctrl": 113, "control": 113, "alt": 57, "shift": 59, "meta": 117, "super": 117,
}
PACKAGE = re.compile(r"^[A-Za-z0-9_.]+(/[A-Za-z0-9_.$]+)?$")

state = {"ready": False, "reason": "正在连接安卓设备", "keyboard": False}


def adb(*args, input_bytes=None, timeout=30, check=True):
    p = subprocess.run(["adb", "-s", SERIAL, *args], input=input_bytes, capture_output=True, timeout=timeout)
    if check and p.returncode != 0:
        raise RuntimeError((p.stderr or p.stdout).decode(errors="replace").strip() or f"adb {args[0]} failed")
    return p.stdout


def shell(cmd, timeout=30, check=True):
    return adb("shell", cmd, timeout=timeout, check=check).decode(errors="replace")


def keeper():
    """Keep adb connected; when the device (re)boots, set it up and mark ready."""
    while True:
        try:
            devices = subprocess.run(["adb", "devices"], capture_output=True, timeout=10).stdout.decode()
            if f"{SERIAL}\tdevice" not in devices:
                state.update(ready=False, reason="正在连接安卓设备")
                subprocess.run(["adb", "connect", SERIAL], capture_output=True, timeout=10)
            elif shell("getprop sys.boot_completed", timeout=10, check=False).strip() != "1":
                state.update(ready=False, reason="安卓正在启动")
            elif not state["ready"]:
                setup()
                state.update(ready=True, reason="")
        except Exception as e:  # noqa: BLE001 - keep trying
            state.update(ready=False, reason=str(e)[:200])
        time.sleep(2)


def setup():
    """Install the keyboard that lets adb type any text and keep the screen on (the emulator would sleep)."""
    try:
        if "com.android.adbkeyboard" not in shell("pm list packages com.android.adbkeyboard", check=False):
            adb("install", "-r", KEYBOARD_APK, timeout=120)
        shell(f"ime enable {KEYBOARD_IME}", check=False)
        shell(f"ime set {KEYBOARD_IME}", check=False)
        state["keyboard"] = KEYBOARD_IME in shell("settings get secure default_input_method", check=False)
    except Exception:  # noqa: BLE001 - typing falls back to `input text`
        state["keyboard"] = False
    shell("svc power stayon true", check=False)
    shell("settings put system screen_off_timeout 2147483647", check=False)


def png_size(png):
    w, h = struct.unpack(">II", png[16:24])
    return w, h


def screenshot(width=None, quality=70, fmt="jpeg"):
    png = adb("exec-out", "screencap", "-p", timeout=20)
    w, h = png_size(png)
    args = ["convert", "png:-"]
    if width:
        args += ["-resize", f"{int(width)}x"]
    args += ["-quality", str(quality), "jpeg:-"] if fmt == "jpeg" else ["png:-"]
    out = subprocess.run(args, input=png, capture_output=True, timeout=20, check=True).stdout
    return out, w, h


def type_text(text):
    if state["keyboard"]:
        b64 = base64.b64encode(text.encode()).decode()
        shell(f"am broadcast -a ADB_INPUT_B64 --es msg {b64}", timeout=60)
        return
    if not text.isascii():
        raise ValueError("输入法不可用，只能输入英文和数字")
    escaped = text.replace("\\", "\\\\").replace(" ", "%s")
    for ch in "\"'`$&|;<>()*~?!#[]{}":
        escaped = escaped.replace(ch, "\\" + ch)
    shell(f"input text {escaped}", timeout=60)


def keycode(name):
    n = name.strip()
    if n.lower() in KEYCODES:
        return str(KEYCODES[n.lower()])
    if re.fullmatch(r"[A-Za-z]", n):
        return f"KEYCODE_{n.upper()}"
    if re.fullmatch(r"[0-9]", n):
        return f"KEYCODE_{n}"
    if re.fullmatch(r"(KEYCODE_)?[A-Z0-9_]+", n):
        return n if n.startswith("KEYCODE_") else f"KEYCODE_{n}"
    raise ValueError(f"不认识的按键：{name}")


def press(combo):
    parts = [p for p in combo.replace(" ", "").split("+") if p]
    codes = [keycode(p) for p in parts]
    if len(codes) == 1:
        shell(f"input keyevent {codes[0]}")
    else:
        shell("input keycombination " + " ".join(codes))


def act(a):
    t = a.get("type")
    x, y = a.get("x"), a.get("y")
    if t in ("click", "double_click"):
        tap = f"input tap {int(x)} {int(y)}"
        shell(f"{tap}; {tap}" if t == "double_click" else tap)
    elif t == "right_click":
        shell("input keyevent 4")
    elif t == "middle_click":
        shell("input keyevent 3")
    elif t == "move":
        pass  # no hover on a touch screen
    elif t == "drag":
        shell(f"input swipe {int(x)} {int(y)} {int(a['x2'])} {int(a['y2'])} 400")
    elif t == "type":
        type_text(a.get("text", ""))
    elif t == "key":
        press(a["keys"])
    elif t == "scroll":
        w, h = size()
        cx, cy = (int(x), int(y)) if x is not None and y is not None else (w // 2, h // 2)
        d = min(int(a.get("amount", 3)) * 150, max(w, h) // 2)
        dx, dy = {"down": (0, -d), "up": (0, d), "left": (d, 0), "right": (-d, 0)}[a.get("direction", "down")]
        clamp = lambda v, m: max(1, min(m - 2, v))  # noqa: E731
        shell(f"input swipe {cx} {cy} {clamp(cx + dx, w)} {clamp(cy + dy, h)} 300")
    elif t == "wait":
        time.sleep(min(float(a.get("seconds", 1)), 30))
    else:
        raise ValueError(f"unknown action type: {t}")
    return {"ok": True}


def size():
    """Effective screen size (an override wins over the physical size; it is listed last)."""
    lines = shell("wm size", check=False).strip().splitlines()
    m = re.search(r"(\d+)x(\d+)", lines[-1]) if lines else None
    return (int(m.group(1)), int(m.group(2))) if m else (720, 1280)


def launch(app):
    if not PACKAGE.match(app):
        raise ValueError(f"不是有效的包名：{app}")
    if "/" in app:
        shell(f"am start -n {app}")
    else:
        out = shell(f"monkey -p {app} -c android.intent.category.LAUNCHER 1", check=False)
        if "No activities found" in out or "monkey aborted" in out:
            raise ValueError(f"没有找到可以启动的 App：{app}")


CLASS = {"Button": "按钮", "ImageButton": "按钮", "EditText": "输入框", "TextView": "文字", "ImageView": "图片",
         "CheckBox": "复选框", "Switch": "开关", "RadioButton": "单选", "ToggleButton": "开关", "WebView": "网页"}


def ui_text():
    xml = shell("uiautomator dump /data/local/tmp/ui.xml >/dev/null 2>&1; cat /data/local/tmp/ui.xml", timeout=30)
    start = xml.find("<?xml")
    if start < 0:
        raise RuntimeError("读取界面失败（界面可能在动画中，稍后重试）")
    root = ET.fromstring(xml[start:])
    focus = re.search(r"mCurrentFocus=Window\{[^ ]+ [^ ]+ ([^}]+)\}", shell("dumpsys window | grep mCurrentFocus", check=False))
    lines = [f"当前窗口：{focus.group(1) if focus else '未知'}"]
    for n in root.iter("node"):
        g = n.get
        text, desc, rid = g("text", ""), g("content-desc", ""), g("resource-id", "")
        flags = [f for f, k in (("可点", "clickable"), ("可滚动", "scrollable"), ("已选中", "checked"), ("焦点", "focused")) if g(k) == "true"]
        if g("enabled") == "false":
            flags.append("不可用")
        if not (text or desc or "可点" in flags or "可滚动" in flags):
            continue
        m = re.match(r"\[(\d+),(\d+)\]\[(\d+),(\d+)\]", g("bounds", ""))
        if not m:
            continue
        x1, y1, x2, y2 = map(int, m.groups())
        if x2 <= x1 or y2 <= y1:
            continue
        cls = g("class", "").split(".")[-1]
        label = CLASS.get(cls, cls)
        parts = [f"[{label}]"]
        if g("password") == "true":
            parts.append("（密码框）")
        if text:
            parts.append(json.dumps(text[:120], ensure_ascii=False))
        if desc and desc != text:
            parts.append(f"描述={json.dumps(desc[:120], ensure_ascii=False)}")
        if rid:
            parts.append(f"id={rid.split(':id/')[-1]}")
        parts += flags
        parts.append(f"({(x1 + x2) // 2},{(y1 + y2) // 2})")
        lines.append("- " + " ".join(parts))
        if len(lines) > 400:
            lines.append("…（元素过多已截断）")
            break
    return "\n".join(lines)


def apps():
    pkgs = sorted(line.split(":", 1)[1].strip() for line in shell("pm list packages -3").splitlines() if ":" in line)
    return [{"package": p} for p in pkgs if p != "com.android.adbkeyboard"]


def install(apk):
    before = {a["package"] for a in apps()}
    with tempfile.NamedTemporaryFile(suffix=".apk") as f:
        f.write(apk)
        f.flush()
        out = adb("install", "-r", "-g", f.name, timeout=600, check=False).decode(errors="replace")
    if "Success" not in out:
        raise RuntimeError(out.strip()[-500:] or "安装失败")
    new = [a["package"] for a in apps() if a["package"] not in before]
    return {"ok": True, "package": new[0] if new else "", "output": out.strip()[-200:]}


def gsf_id():
    out = shell("content query --uri content://com.google.android.gsf.gservices --where \"name='android_id'\"", check=False)
    m = re.search(r"value=(\d+)", out)
    if not m:
        return {"id": None, "error": out.strip()[-200:] or "没有 Google 服务，或还没有生成设备 ID"}
    return {"id": m.group(1), "hex": format(int(m.group(1)), "x")}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def send_json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def raw_body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(n) if n else b""

    def do_GET(self):
        u = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(u.query).items()}
        try:
            if u.path == "/health":
                return self.send_json(200 if state["ready"] else 503, {"ok": state["ready"], **state})
            if not state["ready"]:
                return self.send_json(503, {"error": state["reason"] or "安卓还没有准备好"})
            if u.path == "/screenshot":
                fmt = q.get("format", "jpeg")
                img, w, h = screenshot(q.get("width"), int(q.get("quality", 70)), fmt)
                self.send_response(200)
                self.send_header("Content-Type", "image/jpeg" if fmt == "jpeg" else "image/png")
                self.send_header("X-Screen-Size", f"{w}x{h}")
                self.send_header("Content-Length", str(len(img)))
                self.end_headers()
                return self.wfile.write(img)
            if u.path == "/clipboard":
                return self.send_json(400, {"error": "安卓实例不支持读取剪贴板"})
            if u.path == "/ui":
                return self.send_json(200, {"text": ui_text()})
            if u.path == "/apps":
                return self.send_json(200, {"apps": apps()})
            if u.path == "/gsf-id":
                return self.send_json(200, gsf_id())
            return self.send_json(404, {"error": "not found"})
        except Exception as e:  # noqa: BLE001 - report every failure to the hub
            return self.send_json(500, {"error": str(e)})

    def do_POST(self):
        path = urlparse(self.path).path
        try:
            if not state["ready"]:
                return self.send_json(503, {"error": state["reason"] or "安卓还没有准备好"})
            if path == "/apps/install":
                return self.send_json(200, install(self.raw_body()))
            a = json.loads(self.raw_body() or b"{}")
            if path == "/action":
                return self.send_json(200, act(a))
            if path == "/clipboard":
                type_text(a.get("text", ""))
                return self.send_json(200, {"ok": True})
            if path == "/launch":
                launch(a.get("app", "").strip())
                return self.send_json(200, {"ok": True})
            if path == "/browser/ensure":
                return self.send_json(400, {"error": "安卓实例没有 browser_* 浏览器"})
            return self.send_json(404, {"error": "not found"})
        except (ValueError, KeyError) as e:
            return self.send_json(400, {"error": str(e)})
        except Exception as e:  # noqa: BLE001
            return self.send_json(500, {"error": str(e)})


if __name__ == "__main__":
    threading.Thread(target=keeper, daemon=True).start()
    ThreadingHTTPServer(("0.0.0.0", 8000), Handler).serve_forever()
