import json
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import SplitResult, urlsplit, urlunsplit
from urllib.request import Request, urlopen


def load_env_file() -> dict:
    result = {}
    env_path = Path(__file__).with_name(".env")
    if not env_path.exists():
        return result
    for line in env_path.read_text().splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, value = stripped.split("=", 1)
        result[key.strip()] = value.strip()
    return result


ENV_FILE_VALUES = load_env_file()

TARGET_BASE = os.environ.get("CODEX_PROXY_TARGET", "http://127.0.0.1:4000")
PORT = int(os.environ.get("CODEX_PROXY_PORT", "4100"))
AUTH_TOKEN = os.environ.get("LITELLM_MASTER_KEY") or ENV_FILE_VALUES.get("LITELLM_MASTER_KEY", "")
MODEL_ALIASES = {
    "gpt-5.3-codex": "gpt",
    "gpt-5.4-codex": "gpt",
    "gpt-5-codex": "gpt",
    "gpt-5": "gpt",
    "gpt": "gpt",
}


def rewrite_path(path: str) -> str:
    split = urlsplit(path)
    new_path = split.path
    if not new_path.startswith("/v1/") and (
        new_path == "/responses"
        or new_path.startswith("/responses/")
        or new_path == "/models"
        or new_path.startswith("/models/")
    ):
        new_path = f"/v1{new_path}"
    return urlunsplit(SplitResult(split.scheme, split.netloc, new_path, split.query, split.fragment))


def rewrite_body(body: bytes) -> bytes:
    try:
        payload = json.loads(body.decode("utf-8"))
    except Exception:
        return body
    model = payload.get("model")
    if isinstance(model, str):
        payload["model"] = MODEL_ALIASES.get(model, "gpt" if "codex" in model else model)
    return json.dumps(payload).encode("utf-8")


def log_line(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, format: str, *args) -> None:
        return

    def do_GET(self) -> None:
        self._proxy()

    def do_POST(self) -> None:
        self._proxy()

    def do_DELETE(self) -> None:
        self._proxy()

    def do_PATCH(self) -> None:
        self._proxy()

    def _proxy(self) -> None:
        length = int(self.headers.get("Content-Length", "0") or "0")
        body = self.rfile.read(length) if length else None
        content_type = self.headers.get("Content-Type", "")
        if body and "application/json" in content_type:
            body = rewrite_body(body)
        upstream_url = f"{TARGET_BASE}{rewrite_path(self.path)}"
        log_line(f"proxy {self.command} {self.path} -> {upstream_url}")
        headers = {}
        has_auth = False
        for key, value in self.headers.items():
            if key.lower() in {"host", "content-length", "connection", "accept-encoding"}:
                continue
            if key.lower() == "authorization":
                has_auth = True
            headers[key] = value
        if not has_auth and AUTH_TOKEN:
            headers["Authorization"] = f"Bearer {AUTH_TOKEN}"
        request = Request(upstream_url, data=body, headers=headers, method=self.command)
        try:
            with urlopen(request, timeout=900) as response:
                self._relay(response.status, response.getheaders(), response)
        except HTTPError as error:
            log_line(f"proxy upstream http error {error.code} {upstream_url}")
            self._relay(error.code, error.headers.items(), error)
        except URLError as error:
            log_line(f"proxy upstream url error {upstream_url}: {error.reason}")
            self._write_error(502, str(error.reason))
        except Exception as error:
            log_line(f"proxy upstream exception {upstream_url}: {repr(error)}")
            self._write_error(502, str(error))

    def _relay(self, status: int, headers, stream) -> None:
        self.close_connection = True
        self.send_response(status)
        for key, value in headers:
            if key.lower() in {"transfer-encoding", "connection", "content-length", "content-encoding", "server", "date"}:
                continue
            self.send_header(key, value)
        self.send_header("Connection", "close")
        self.end_headers()
        reader = getattr(stream, "read1", None)
        while True:
            chunk = reader(8192) if reader else stream.read(8192)
            if not chunk:
                break
            self.wfile.write(chunk)
            self.wfile.flush()

    def _write_error(self, status: int, message: str) -> None:
        payload = json.dumps({"error": message}).encode("utf-8")
        self.close_connection = True
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(payload)
        self.wfile.flush()


if __name__ == "__main__":
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    server.serve_forever()
