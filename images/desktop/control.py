"""Desktop control API for constella-desktop (stdlib only; drives X via xdotool/xclip/ImageMagick).

Only reachable on the internal constella-net network; the hub enforces leases and auth in front of it.
"""
import json
import os
import shutil
import subprocess
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

CHROME_PROFILE = os.path.expanduser("~/.config/constella-chromium")
KEY_ALIASES = {"enter": "Return", "esc": "Escape", "backspace": "BackSpace", "tab": "Tab", "space": "space",
               "up": "Up", "down": "Down", "left": "Left", "right": "Right", "delete": "Delete",
               "home": "Home", "end": "End", "pageup": "Prior", "pagedown": "Next",
               "ctrl": "ctrl", "control": "ctrl", "alt": "alt", "shift": "shift", "super": "super", "cmd": "super"}


def run(*args, input_bytes=None, timeout=20):
    return subprocess.run(args, input=input_bytes, capture_output=True, timeout=timeout, check=True).stdout


def screen_size():
    w, h = run("xdotool", "getdisplaygeometry").decode().split()
    return int(w), int(h)


def screenshot(fmt="jpeg", width=None, quality=70):
    png = run("import", "-window", "root", "-silent", "png:-")
    args = ["convert", "png:-"]
    if width:
        args += ["-resize", f"{int(width)}x"]
    if fmt == "jpeg":
        args += ["-quality", str(quality), "jpeg:-"]
    else:
        args += ["png:-"]
    return run(*args, input_bytes=png)


def normalize_keys(combo):
    """'ctrl+L' / 'Enter' / 'ctrl+shift+t' -> xdotool key syntax."""
    parts = [p.strip() for p in combo.replace(" ", "").split("+") if p.strip()]
    return "+".join(KEY_ALIASES.get(p.lower(), p) for p in parts)


def chromium_running():
    return subprocess.run(["pgrep", "-f", "chromium.*remote-debugging-port=9222"], capture_output=True).returncode == 0


def ensure_browser(url=None):
    if not chromium_running():
        args = ["chromium", "--no-sandbox", "--disable-dev-shm-usage", "--no-first-run", "--no-default-browser-check",
                "--password-store=basic", "--test-type", "--remote-debugging-port=9222", "--remote-debugging-address=127.0.0.1",
                f"--user-data-dir={CHROME_PROFILE}", "--start-maximized"]
        subprocess.Popen(args + ([url] if url else []), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                         start_new_session=True)
        for _ in range(50):
            try:
                run("curl", "-fs", "http://127.0.0.1:9222/json/version", timeout=2)
                break
            except Exception:
                time.sleep(0.2)
    elif url:
        subprocess.Popen(["chromium", f"--user-data-dir={CHROME_PROFILE}", url], stdout=subprocess.DEVNULL,
                         stderr=subprocess.DEVNULL, start_new_session=True)
    return {"running": chromium_running()}


def act(a):
    t = a.get("type")
    x, y = a.get("x"), a.get("y")
    move = ["mousemove", "--sync", str(int(x)), str(int(y))] if x is not None and y is not None else []
    if t in ("click", "double_click", "right_click", "middle_click"):
        button = {"click": "1", "double_click": "1", "right_click": "3", "middle_click": "2"}[t]
        repeat = ["--repeat", "2", "--delay", "80"] if t == "double_click" else []
        run("xdotool", *move, "click", *repeat, button)
    elif t == "move":
        run("xdotool", *move)
    elif t == "drag":
        run("xdotool", *move, "mousedown", "1", "mousemove", "--sync", str(int(a["x2"])), str(int(a["y2"])), "mouseup", "1")
    elif t == "type":
        run("xdotool", "type", "--delay", "12", "--", a["text"], timeout=120)
    elif t == "key":
        run("xdotool", "key", "--clearmodifiers", normalize_keys(a["keys"]))
    elif t == "scroll":
        amount = int(a.get("amount", 3))
        direction = a.get("direction", "down")
        button = {"up": "4", "down": "5", "left": "6", "right": "7"}[direction]
        run("xdotool", *move, "click", "--repeat", str(max(1, amount)), "--delay", "30", button)
    elif t == "wait":
        time.sleep(min(float(a.get("seconds", 1)), 30))
    else:
        raise ValueError(f"unknown action type: {t}")
    return {"ok": True}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def send_json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(n) or b"{}")

    def do_GET(self):
        u = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(u.query).items()}
        try:
            if u.path == "/health":
                w, h = screen_size()
                return self.send_json(200, {"ok": True, "width": w, "height": h, "browser": chromium_running()})
            if u.path == "/screenshot":
                fmt = q.get("format", "jpeg")
                img = screenshot(fmt, q.get("width"), int(q.get("quality", 70)))
                w, h = screen_size()
                self.send_response(200)
                self.send_header("Content-Type", "image/jpeg" if fmt == "jpeg" else "image/png")
                self.send_header("X-Screen-Size", f"{w}x{h}")
                self.send_header("Content-Length", str(len(img)))
                self.end_headers()
                return self.wfile.write(img)
            if u.path == "/clipboard":
                text = run("xclip", "-o", "-selection", "clipboard", timeout=5).decode(errors="replace")
                return self.send_json(200, {"text": text})
            return self.send_json(404, {"error": "not found"})
        except Exception as e:  # noqa: BLE001 - report every failure to the hub
            return self.send_json(500, {"error": str(e)})

    def do_POST(self):
        path = urlparse(self.path).path
        try:
            a = self.body()
            if path == "/action":
                return self.send_json(200, act(a))
            if path == "/browser/ensure":
                return self.send_json(200, ensure_browser(a.get("url")))
            if path == "/clipboard":
                # xclip keeps serving the selection in the background, so don't wait on its stdout.
                subprocess.run(["xclip", "-i", "-selection", "clipboard"], input=a.get("text", "").encode(),
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5, check=True)
                return self.send_json(200, {"ok": True})
            if path == "/launch":
                app = a.get("app", "")
                if not shutil.which(app.split()[0] if app else ""):
                    return self.send_json(400, {"error": f"app not found: {app}"})
                subprocess.Popen(app.split(), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
                return self.send_json(200, {"ok": True})
            return self.send_json(404, {"error": "not found"})
        except subprocess.CalledProcessError as e:
            return self.send_json(500, {"error": (e.stderr or b"").decode(errors="replace") or str(e)})
        except Exception as e:  # noqa: BLE001
            return self.send_json(400, {"error": str(e)})


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", 8000), Handler).serve_forever()
