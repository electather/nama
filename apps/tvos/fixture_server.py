#!/usr/bin/env python3

import argparse
import json
import mimetypes
import re
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import quote, unquote, urlsplit


DUMMY_CREDENTIALS = {
    "Authorization": "Bearer nama-player-lab-dummy-authorization",
    "X-Emby-Token": "nama-player-lab-dummy-jellyfin",
}
RANGE_PATTERN = re.compile(r"bytes=(\d*)-(\d*)")


class FixtureHTTPServer(ThreadingHTTPServer):
    daemon_threads = True


class FixtureHandler(BaseHTTPRequestHandler):
    server_version = "NamaFixtureServer"
    sys_version = ""

    def do_GET(self):
        self._serve(send_body=True)

    def do_HEAD(self):
        self._serve(send_body=False)

    def _serve(self, *, send_body):
        server = self.server
        if any(self.headers.get(name) == value for name, value in DUMMY_CREDENTIALS.items()):
            server.dummy_credentials_received.set()

        path = self._request_path()
        if path == "/credential-check":
            received = server.dummy_credentials_received.is_set()
            server.dummy_credentials_received.clear()
            self._json({"dummy_credentials_received": received}, send_body)
            return

        for prefix, cross_origin in (("/redirect/same/", None), ("/redirect/cross/", server.cross_origin)):
            if path and path.startswith(prefix):
                relative_path = path.removeprefix(prefix)
                if self._resolve_file(relative_path) is None:
                    self._empty_error(404)
                    return
                target = "/" + quote(relative_path, safe="/")
                self.send_response(307)
                self.send_header("Location", target if cross_origin is None else cross_origin + target)
                self.send_header("Content-Length", "0")
                self.end_headers()
                return

        file_path = self._resolve_file(path.lstrip("/") if path else "")
        if file_path is None:
            self._empty_error(404)
            return
        self._file(file_path, send_body)

    def _request_path(self):
        parts = urlsplit(self.path)
        if parts.query or parts.fragment:
            return None
        path = parts.path
        while True:
            decoded = unquote(path)
            if decoded == path:
                return path
            path = decoded

    def _resolve_file(self, relative_path):
        if not relative_path or "\\" in relative_path or "\0" in relative_path:
            return None
        parts = relative_path.split("/")
        if any(part in ("", ".", "..") for part in parts):
            return None
        try:
            candidate = (self.server.fixture_root / relative_path).resolve(strict=True)
            candidate.relative_to(self.server.fixture_root)
        except (OSError, RuntimeError, ValueError):
            return None
        return candidate if candidate.is_file() else None

    def _file(self, file_path, send_body):
        size = file_path.stat().st_size
        range_header = self.headers.get("Range")
        byte_range = self._parse_range(range_header, size) if range_header else None
        if range_header and byte_range is None:
            self.send_response(416)
            self.send_header("Content-Range", f"bytes */{size}")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return

        start, end = byte_range if byte_range else (0, size - 1)
        length = end - start + 1 if size else 0
        self.send_response(206 if byte_range else 200)
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Type", mimetypes.guess_type(file_path.name)[0] or "application/octet-stream")
        self.send_header("Content-Length", str(length))
        if byte_range:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.end_headers()
        if not send_body or not length:
            return
        with file_path.open("rb") as fixture:
            fixture.seek(start)
            remaining = length
            while remaining:
                chunk = fixture.read(min(remaining, 64 * 1024))
                if not chunk:
                    break
                self.wfile.write(chunk)
                remaining -= len(chunk)

    @staticmethod
    def _parse_range(value, size):
        match = RANGE_PATTERN.fullmatch(value.strip())
        if not match or size == 0:
            return None
        first, last = match.groups()
        if not first and not last:
            return None
        if not first:
            suffix_length = int(last)
            if suffix_length == 0:
                return None
            return max(0, size - suffix_length), size - 1
        start = int(first)
        end = min(int(last), size - 1) if last else size - 1
        return (start, end) if start < size and start <= end else None

    def _json(self, value, send_body):
        body = (json.dumps(value, separators=(",", ":")) + "\n").encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if send_body:
            self.wfile.write(body)

    def _empty_error(self, status):
        self.send_response(status)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def log_message(self, format, *args):
        pass


class FixtureServers:
    def __init__(self, fixture_root, bind_address, primary_port, secondary_port=None):
        root = Path(fixture_root).resolve(strict=True)
        if not root.is_dir():
            raise ValueError("fixture root must be a directory")
        secondary_port = primary_port + 1 if secondary_port is None else secondary_port
        if not 0 <= primary_port <= 65535 or not 0 <= secondary_port <= 65535:
            raise ValueError("ports must be between 0 and 65535")

        self._servers = []
        self._threads = []
        try:
            for port in (primary_port, secondary_port):
                server = FixtureHTTPServer((bind_address, port), FixtureHandler)
                server.fixture_root = root
                # ponytail: one lab-wide flag; add request IDs only if concurrent runs matter.
                server.dummy_credentials_received = threading.Event()
                self._servers.append(server)
            self.primary_origin = self._origin(bind_address, self._servers[0].server_port)
            self.secondary_origin = self._origin(bind_address, self._servers[1].server_port)
            for server in self._servers:
                server.cross_origin = self.secondary_origin
        except Exception:
            for server in self._servers:
                server.server_close()
            raise

    @staticmethod
    def _origin(host, port):
        return f"http://[{host}]:{port}" if ":" in host else f"http://{host}:{port}"

    def __enter__(self):
        for server in self._servers:
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            self._threads.append(thread)
        return self

    def __exit__(self, exc_type, exc_value, traceback):
        for server in self._servers:
            server.shutdown()
        for thread in self._threads:
            thread.join()
        for server in self._servers:
            server.server_close()


def main():
    parser = argparse.ArgumentParser(description="Serve disposable Nama Player Lab fixtures on a trusted LAN")
    parser.add_argument("--fixtures", required=True, type=Path)
    parser.add_argument("--bind", required=True)
    parser.add_argument("--port", required=True, type=int)
    arguments = parser.parse_args()
    if not 1 <= arguments.port <= 65534:
        parser.error("--port must leave the following port available (1-65534)")

    with FixtureServers(arguments.fixtures, arguments.bind, arguments.port) as servers:
        print(f"Player Lab primary origin: {servers.primary_origin}", flush=True)
        print(f"Player Lab cross-origin target: {servers.secondary_origin}", flush=True)
        try:
            threading.Event().wait()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
