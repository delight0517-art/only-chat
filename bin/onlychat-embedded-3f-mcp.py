#!/usr/bin/env python3
"""Per-turn stdio MCP relay to the authenticated Only Chat 3F endpoint."""
import json
import os
import sys
import urllib.error
import urllib.request


URL = os.environ.get("ONLYCHAT_MCP_URL", "")
TOKEN = os.environ.get("ONLYCHAT_MCP_TOKEN", "")
SESSION_ID = ""
PROTOCOL_VERSION = "2024-11-05"


def send(message):
    global SESSION_ID, PROTOCOL_VERSION
    if not URL or not TOKEN:
        raise RuntimeError("Only Chat 3F bridge credentials are unavailable.")
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        "Authorization": "Bearer " + TOKEN,
    }
    if SESSION_ID:
        headers["Mcp-Session-Id"] = SESSION_ID
        headers["Mcp-Protocol-Version"] = PROTOCOL_VERSION
    request = urllib.request.Request(URL, data=json.dumps(message).encode(), headers=headers, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            if message.get("method") == "initialize":
                SESSION_ID = response.headers.get("Mcp-Session-Id", "")
                PROTOCOL_VERSION = response.headers.get("Mcp-Protocol-Version", PROTOCOL_VERSION)
            if response.status == 202:
                return None
            payload = response.read(1024 * 1024 + 1)
            if len(payload) > 1024 * 1024:
                raise RuntimeError("Only Chat 3F response exceeded the size limit.")
            return json.loads(payload.decode())
    except urllib.error.HTTPError as error:
        try:
            detail = json.loads(error.read(4096).decode()).get("error", "Only Chat 3F bridge rejected the request.")
        except Exception:
            detail = "Only Chat 3F bridge rejected the request."
        raise RuntimeError(str(detail)[:240]) from None


for raw in sys.stdin:
    message = None
    try:
        message = json.loads(raw)
        response = send(message)
        if response is not None:
            sys.stdout.write(json.dumps(response, separators=(",", ":")) + "\n")
            sys.stdout.flush()
    except Exception as error:
        request_id = message.get("id") if isinstance(message, dict) else None
        response = {"jsonrpc": "2.0", "id": request_id, "error": {"code": -32000, "message": str(error)[:240]}}
        sys.stdout.write(json.dumps(response, separators=(",", ":")) + "\n")
        sys.stdout.flush()
