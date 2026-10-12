#!/usr/bin/env python3
"""Firefox Native Messaging host for an authorised CTF/lab navigator.

The host receives one JSON message at a time over Firefox Native Messaging,
opens the requested HTTP(S) connection itself, and preserves the supplied
request-target exactly. It deliberately does not follow redirects or perform
scanning/crawling.
"""
import json
import socket
import ssl
import struct
import sys
from urllib.parse import quote, urlsplit

MAX_BODY = 600 * 1024  # Keep native response comfortably below Firefox's ~1 MB message limit.
MAX_REQUEST_BODY = 256 * 1024
DEFAULT_TIMEOUT = 10.0
MAX_TIMEOUT = 30.0
USER_AGENT = "LFI-Navigator-Native/1.0.0"


def read_message():
    # Firefox frames each Native Messaging message with a 4-byte length prefix.
    header = sys.stdin.buffer.read(4)
    if not header:
        return None
    if len(header) != 4:
        raise EOFError("incomplete native-message header")
    length = struct.unpack("=I", header)[0]
    if length > 1024 * 1024:
        raise ValueError("native message too large")
    payload = sys.stdin.buffer.read(length)
    if len(payload) != length:
        raise EOFError("incomplete native-message payload")
    return json.loads(payload.decode("utf-8"))


def write_message(value):
    # Native Messaging expects the same length-prefixed format on stdout; keep
    # diagnostics on stderr so they cannot corrupt the protocol stream.
    payload = json.dumps(value, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("=I", len(payload)))
    sys.stdout.buffer.write(payload)
    sys.stdout.buffer.flush()


def parse_target(raw_url):
    if not isinstance(raw_url, str) or not raw_url.strip():
        raise ValueError("missing target URL")
    parsed = urlsplit(raw_url.strip())
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise ValueError("target must be an http:// or https:// URL")
    if parsed.fragment:
        raise ValueError("URL fragments are not sent in HTTP requests")
    # urlsplit() parses without resolving dot segments. We deliberately use the
    # original path string as the HTTP request-target.
    request_path = parsed.path or "/"
    if not request_path.startswith("/"):
        request_path = "/" + request_path
    request_target = quote(request_path, safe="/%:@!$&'()*+,;=-._~")
    if parsed.query:
        request_target += "?" + quote(parsed.query, safe="/%:@!$&'()*+,;=-._~?=&")
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    host = parsed.hostname
    host_header = f"[{host}]" if ":" in host and not host.startswith("[") else host
    if parsed.port is not None:
        host_header += f":{port}"
    return parsed.scheme, host, port, host_header, request_target


def read_response(sock):
    def recv_more(buffer):
        chunk = sock.recv(8192)
        if chunk:
            buffer.extend(chunk)
        return bool(chunk)

    buf = bytearray()
    header_end = None
    while header_end is None:
        if not recv_more(buf):
            break
        if len(buf) > 128 * 1024:
            raise ValueError("response headers too large")
        marker = buf.find(b"\r\n\r\n")
        if marker >= 0:
            header_end = marker + 4
    if header_end is None:
        raise ValueError("incomplete HTTP response headers")

    header_bytes = bytes(buf[:header_end])
    body = bytearray(buf[header_end:])
    lines = header_bytes[:-4].split(b"\r\n")
    status_line = lines[0].decode("iso-8859-1", "replace") if lines else ""
    parts = status_line.split(" ", 2)
    status = int(parts[1]) if len(parts) >= 2 and parts[1].isdigit() else 0
    reason = parts[2] if len(parts) >= 3 else ""
    headers = {}
    for line in lines[1:]:
        if b":" not in line:
            continue
        key, value = line.split(b":", 1)
        headers[key.decode("iso-8859-1", "replace").lower()] = value.lstrip().decode("iso-8859-1", "replace")

    transfer_encoding = headers.get("transfer-encoding", "").lower()
    if "chunked" in transfer_encoding:
        decoded = bytearray()
        while True:
            while b"\r\n" not in body:
                if not recv_more(body):
                    raise ValueError("incomplete chunk-size line")
                if len(decoded) > MAX_BODY:
                    return status, reason, headers, bytes(decoded[:MAX_BODY]), True
            line_end = body.find(b"\r\n")
            size_line = bytes(body[:line_end]).split(b";", 1)[0].strip()
            del body[:line_end + 2]
            try:
                chunk_size = int(size_line, 16)
            except ValueError as exc:
                raise ValueError("invalid chunk-size line") from exc
            if chunk_size == 0:
                # Consume the terminating CRLF and ignore optional trailers.
                while b"\r\n\r\n" not in body:
                    if not recv_more(body):
                        break
                    if len(body) > 128 * 1024:
                        break
                break
            remaining = MAX_BODY - len(decoded)
            if chunk_size > remaining:
                return status, reason, headers, bytes(decoded[:MAX_BODY]), True
            while len(body) < chunk_size + 2:
                if not recv_more(body):
                    raise ValueError("incomplete chunk data")
            if body[chunk_size:chunk_size + 2] != b"\r\n":
                raise ValueError("invalid chunk terminator")
            decoded.extend(body[:chunk_size])
            del body[:chunk_size + 2]
            if len(decoded) > MAX_BODY:
                return status, reason, headers, bytes(decoded[:MAX_BODY]), True
        return status, reason, headers, bytes(decoded), False

    while len(body) < MAX_BODY + 1:
        chunk = sock.recv(min(16384, MAX_BODY + 1 - len(body)))
        if not chunk:
            break
        body.extend(chunk)
    truncated = len(body) > MAX_BODY
    if truncated:
        del body[MAX_BODY:]
    return status, reason, headers, bytes(body), truncated


def coerce_timeout(value):
    try:
        timeout = float(value)
    except (TypeError, ValueError):
        timeout = DEFAULT_TIMEOUT
    if timeout != timeout or timeout <= 0:
        return DEFAULT_TIMEOUT
    return min(timeout, MAX_TIMEOUT)

def perform_request(raw_url, timeout=DEFAULT_TIMEOUT, method="GET", body="", content_type="application/octet-stream"):
    timeout = coerce_timeout(timeout)
    method = str(method or "GET").upper()
    if method not in ("GET", "POST", "PUT"):
        raise ValueError("method must be GET, POST, or PUT")
    if not isinstance(content_type, str) or not content_type.strip() or any(c in content_type for c in "\r\n"):
        raise ValueError("invalid Content-Type header")
    scheme, host, port, host_header, request_target = parse_target(raw_url)
    # GET has no body. POST and PUT use UTF-8 and the byte count, not character
    # count, is used for Content-Length.
    body_bytes = b"" if method == "GET" else str(body or "").encode("utf-8")
    if len(body_bytes) > MAX_REQUEST_BODY:
        raise ValueError("request body exceeds 256 KiB limit")
    headers = (
        f"{method} {request_target} HTTP/1.1\r\n"
        f"Host: {host_header}\r\n"
        f"User-Agent: {USER_AGENT}\r\n"
        "Accept: */*\r\n"
        "Accept-Encoding: identity\r\n"
        f"Content-Length: {len(body_bytes)}\r\n"
        + (f"Content-Type: {content_type.strip()}\r\n" if method != "GET" else "")
        + "Connection: close\r\n\r\n"
    ).encode("iso-8859-1")
    request = headers + body_bytes

    sock = socket.create_connection((host, port), timeout=timeout)
    try:
        if scheme == "https":
            context = ssl.create_default_context()
            sock = context.wrap_socket(sock, server_hostname=host)
        sock.settimeout(timeout)
        sock.sendall(request)
        status, reason, headers, body, truncated = read_response(sock)
    finally:
        sock.close()

    return {
        "ok": True,
        "url": raw_url,
        "requestTarget": request_target,
        "method": method,
        "status": status,
        "statusText": reason,
        "contentType": headers.get("content-type", ""),
        "body": body.decode("utf-8", "replace"),
        "truncated": truncated,
    }


def handle(message):
    if not isinstance(message, dict):
        raise ValueError("message must be a JSON object")
    action = message.get("action")
    if action == "ping":
        return {"ok": True, "type": "pong", "transport": "python-native"}
    if action == "request":
        return perform_request(
            message.get("url"), message.get("timeout", DEFAULT_TIMEOUT),
            message.get("method", "GET"), message.get("body", ""),
            message.get("contentType", "application/octet-stream")
        )
    return {"ok": False, "error": f"unknown action: {action!r}"}


def main():
    while True:
        try:
            message = read_message()
            if message is None:
                return 0
            try:
                response = handle(message)
            except Exception as exc:
                response = {"ok": False, "error": str(exc)}
            if isinstance(message, dict) and "requestId" in message:
                response["requestId"] = message["requestId"]
            write_message(response)
        except Exception as exc:
            print(f"native host error: {exc}", file=sys.stderr, flush=True)
            return 1


if __name__ == "__main__":
    raise SystemExit(main())
