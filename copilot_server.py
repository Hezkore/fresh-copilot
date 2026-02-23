#!/usr/bin/env python3
"""Bridges Fresh plugin (file-based IPC) to the Copilot LSP subprocess (stdio JSON-RPC).
Usage: python3 copilot_server.py <server_binary> <workspace_folder> <port_file>
"""

import json
import logging
import os
import subprocess
import sys
import threading
import time

log = logging.getLogger("copilot-server")

lsp_process = None
lsp_lock = threading.Lock()

pending_requests = {}  # lsp_id -> (plugin_req_id, method)
request_counter = 0
request_counter_lock = threading.Lock()

ipc_dir = ""
shutdown_event = threading.Event()


def _get_log_path():
    cache = os.environ.get("XDG_CACHE_HOME")
    if not cache:
        cache = os.path.join(os.path.expanduser("~"), ".cache")
    log_dir = os.path.join(cache, "fresh")
    os.makedirs(log_dir, exist_ok=True)
    return os.path.join(log_dir, "copilot-server.log")


def _init_logging():
    log_path = _get_log_path()
    logging.basicConfig(
        level=logging.DEBUG,
        format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
        handlers=[
            logging.FileHandler(log_path),
            logging.StreamHandler(sys.stderr),
        ],
    )
    log.info("Log: %s", log_path)


def write_resp(data):
    path = os.path.join(ipc_dir, "resp")
    line = json.dumps(data) + "\n"
    try:
        with open(path, "a") as f:
            f.write(line)
    except OSError as e:
        log.error("Failed to write response: %s", e)


def next_lsp_id():
    global request_counter
    with request_counter_lock:
        request_counter += 1
        return request_counter


def lsp_send(message: dict):
    global lsp_process
    with lsp_lock:
        proc = lsp_process
    if proc is None or proc.poll() is not None:
        log.warning("LSP process not running, cannot send: %s", message.get("method", "?"))
        return
    try:
        body = json.dumps(message).encode("utf-8")
        header = f"Content-Length: {len(body)}\r\n\r\n".encode()
        proc.stdin.write(header + body)
        proc.stdin.flush()
        log.debug("LSP >> %s", message.get("method") or f"response/{message.get('id')}")
    except (BrokenPipeError, OSError) as e:
        log.error("LSP send error: %s", e)


def lsp_request(method: str, params: dict, plugin_req_id=None):
    lsp_id = next_lsp_id()
    if plugin_req_id is not None:
        pending_requests[lsp_id] = (plugin_req_id, method)
    lsp_send({"jsonrpc": "2.0", "id": lsp_id, "method": method, "params": params})
    return lsp_id


def lsp_notify(method: str, params: dict):
    lsp_send({"jsonrpc": "2.0", "method": method, "params": params})


def read_lsp_messages():
    global lsp_process
    with lsp_lock:
        proc = lsp_process
    if proc is None:
        return

    buf = b""
    while not shutdown_event.is_set():
        try:
            chunk = proc.stdout.read1(4096)  # non-blocking read
            if not chunk:
                log.info("LSP stdout closed")
                break
            buf += chunk
            while True:
                header_end = buf.find(b"\r\n\r\n")
                if header_end == -1:
                    break
                header_bytes = buf[:header_end]
                content_length = None
                for line in header_bytes.split(b"\r\n"):
                    if line.lower().startswith(b"content-length:"):
                        content_length = int(line.split(b":", 1)[1].strip())
                        break
                if content_length is None:
                    log.warning("No Content-Length in LSP header, discarding")
                    buf = buf[header_end + 4:]
                    break
                start = header_end + 4
                if len(buf) < start + content_length:
                    break  # need more data
                body = buf[start:start + content_length]
                buf = buf[start + content_length:]
                try:
                    msg = json.loads(body.decode("utf-8"))
                    handle_lsp_message(msg)
                except (json.JSONDecodeError, UnicodeDecodeError) as e:
                    log.error("LSP parse error: %s", e)
        except (OSError, ValueError) as e:
            log.error("LSP read error: %s", e)
            break

    log.info("LSP reader thread exiting")
    write_resp({"type": "serverStopped"})


def handle_lsp_message(msg: dict):
    msg_id = msg.get("id")
    method = msg.get("method")

    if msg_id is not None and method is None:
        if msg_id in pending_requests:
            plugin_req_id, req_method = pending_requests.pop(msg_id)
            result = msg.get("result")
            error = msg.get("error")
            if error:
                log.warning("LSP error for %s: %s", req_method, error)
                write_resp({"type": "error", "id": plugin_req_id, "error": error})
            else:
                dispatch_lsp_response(req_method, plugin_req_id, result)
        else:
            log.debug("LSP response for unknown id %s", msg_id)
        return

    # Notification or server request
    if method == "$/logTrace" or method == "$/progress":
        return  # ignore verbose noise

    if method == "window/logMessage":
        params = msg.get("params", {})
        log.debug("LSP logMessage [%s]: %s", params.get("type"), params.get("message", ""))
        return

    if method == "window/showMessage":
        params = msg.get("params", {})
        write_resp({"type": "showMessage", "message": params.get("message", ""), "msgType": params.get("type", 3)})
        return

    if method == "window/showMessageRequest":
        params = msg.get("params", {})
        log.info("LSP showMessageRequest: %s", params.get("message", ""))
        write_resp({"type": "showMessageRequest", "id": str(msg_id), "message": params.get("message", ""), "msgType": params.get("type", 3), "actions": params.get("actions", [])})
        # Auto-respond null so the server isn't blocked
        lsp_send({"jsonrpc": "2.0", "id": msg_id, "result": None})
        return

    if method == "window/showDocument":
        params = msg.get("params", {})
        uri = params.get("uri", "")
        write_resp({"type": "showDocument", "uri": uri})
        lsp_send({"jsonrpc": "2.0", "id": msg_id, "result": {"success": True}})
        return

    if method == "workspace/configuration":
        params = msg.get("params", {})
        items = params.get("items", [])
        lsp_send({"jsonrpc": "2.0", "id": msg_id, "result": [None] * len(items)})
        return

    if method in ("copilot/didChangeStatus", "didChangeStatus", "statusNotification"):
        params = msg.get("params", {})
        write_resp({"type": "statusChanged", "message": params.get("message", ""), "kind": params.get("kind", "Normal")})
        return

    log.debug("LSP unhandled method: %s (id=%s)", method, msg_id)

    if msg_id is not None:
        lsp_send({"jsonrpc": "2.0", "id": msg_id, "error": {"code": -32601, "message": "Method not found"}})


def dispatch_lsp_response(method: str, plugin_req_id, result):
    if method == "initialize":
        lsp_notify("initialized", {})
        write_resp({"type": "initialized", "id": plugin_req_id})
        return

    if method == "textDocument/inlineCompletion":
        items = []
        if result and isinstance(result, dict):
            for item in result.get("items", []):
                items.append({
                    "insertText": item.get("insertText", ""),
                    "range": item.get("range"),
                    "command": item.get("command"),
                })
        write_resp({"type": "completionResult", "id": plugin_req_id, "items": items})
        return

    if method == "signIn":
        if result:
            write_resp({
                "type": "signInResult",
                "id": plugin_req_id,
                "userCode": result.get("userCode", ""),
                "verificationUri": result.get("verificationUri", ""),
                "command": result.get("command"),
            })
        else:
            write_resp({"type": "signInResult", "id": plugin_req_id, "userCode": "", "verificationUri": ""})
        return

    if method == "signOut":
        write_resp({"type": "signOutResult", "id": plugin_req_id})
        return

    if method == "workspace/executeCommand":
        write_resp({"type": "commandResult", "id": plugin_req_id, "result": result})
        return

    write_resp({"type": "lspResponse", "id": plugin_req_id, "method": method, "result": result})


def handle_plugin_message(msg: dict):
    msg_type = msg.get("type")
    req_id = msg.get("id")

    if msg_type == "initialize":
        workspace = msg.get("workspaceFolders", [])
        process_id = os.getpid()  # use our own PID so the LSP server monitors us
        lsp_request("initialize", {
            "processId": process_id,
            "clientInfo": {"name": "Fresh", "version": "1.0.0"},
            "workspaceFolders": [{"uri": f"file://{w}"} for w in workspace],
            "capabilities": {
                "workspace": {
                    "workspaceFolders": True,
                    "configuration": True,
                },
                "textDocument": {
                    "synchronization": {
                        "dynamicRegistration": True,
                        "didSave": True,
                    },
                    "inlineCompletion": {"dynamicRegistration": True},
                    "inlayHint": {"dynamicRegistration": True},
                },
            },
            "initializationOptions": {
                "editorInfo": {"name": "Fresh", "version": "1.0.0"},
                "editorPluginInfo": {"name": "GitHub Copilot for Fresh", "version": "1.0.0"},
            },
        }, plugin_req_id=req_id)
        return

    if msg_type == "configuration":
        lsp_notify("workspace/didChangeConfiguration", {"settings": msg.get("settings", {})})
        return

    if msg_type == "openDocument":
        lsp_notify("textDocument/didOpen", {
            "textDocument": {
                "uri": msg["uri"],
                "languageId": msg.get("languageId", "plaintext"),
                "version": msg.get("version", 1),
                "text": msg.get("text", ""),
            }
        })
        return

    if msg_type == "changeDocument":
        lsp_notify("textDocument/didChange", {
            "textDocument": {"uri": msg["uri"], "version": msg.get("version", 1)},
            "contentChanges": msg.get("changes", []),
        })
        return

    if msg_type == "closeDocument":
        lsp_notify("textDocument/didClose", {
            "textDocument": {"uri": msg["uri"]}
        })
        return

    if msg_type == "focusDocument":
        uri = msg.get("uri")
        if uri:
            lsp_notify("textDocument/didFocus", {"textDocument": {"uri": uri}})
        else:
            lsp_notify("textDocument/didFocus", {})
        return

    if msg_type == "inlineCompletion":
        lsp_request("textDocument/inlineCompletion", {
            "textDocument": {"uri": msg["uri"], "version": msg.get("version", 0)},
            "position": msg["position"],
            "context": {"triggerKind": msg.get("triggerKind", 2)},
            "formattingOptions": msg.get("formattingOptions", {"tabSize": 4, "insertSpaces": True}),
        }, plugin_req_id=req_id)
        return

    if msg_type == "signIn":
        lsp_request("signIn", {}, plugin_req_id=req_id)
        return

    if msg_type == "signOut":
        lsp_request("signOut", {}, plugin_req_id=req_id)
        return

    if msg_type == "executeCommand":
        lsp_request("workspace/executeCommand", {
            "command": msg["command"],
            "arguments": msg.get("arguments", []),
        }, plugin_req_id=req_id)
        return

    if msg_type == "didAcceptCompletion":
        cmd = msg.get("command")
        if cmd:
            lsp_notify("workspace/executeCommand", {
                "command": cmd.get("command"),
                "arguments": cmd.get("arguments", []),
            })
        return

    if msg_type == "didShowCompletion":
        lsp_notify("textDocument/didShowCompletion", {"item": msg.get("item", {})})
        return

    log.debug("Unknown plugin message type: %s", msg_type)


def cmd_file_watcher():
    cmd_path = os.path.join(ipc_dir, "cmd")
    last_pos = 0

    while not shutdown_event.is_set():
        time.sleep(0.05)
        try:
            if not os.path.exists(cmd_path):
                continue
            with open(cmd_path, "r") as f:
                f.seek(last_pos)
                new_data = f.read()
                last_pos = f.tell()

            if not new_data:
                try:
                    size = os.path.getsize(cmd_path)
                    if size < last_pos:
                        last_pos = 0
                except OSError:
                    pass
                continue

            for line in new_data.strip().split("\n"):
                if line.strip():
                    try:
                        handle_plugin_message(json.loads(line))
                    except (json.JSONDecodeError, KeyError) as e:
                        log.error("IPC parse error: %s - %r", e, line[:80])
        except OSError:
            continue


def parent_watcher(parent_pid):
    while not shutdown_event.is_set():
        time.sleep(2)
        try:
            os.kill(parent_pid, 0)
        except OSError:
            log.info("Parent %d exited, shutting down", parent_pid)
            shutdown_event.set()


def main():
    global lsp_process, ipc_dir

    if len(sys.argv) < 4:
        print("Usage: copilot_server.py <server_binary> <workspace_folder> <port_file>", file=sys.stderr)
        sys.exit(1)

    server_binary = sys.argv[1]
    workspace = sys.argv[2]
    port_file = sys.argv[3]

    _init_logging()
    parent_pid = os.getppid()
    log.info("Starting Copilot bridge (pid=%d, parent=%d)", os.getpid(), parent_pid)
    log.info("Server binary: %s", server_binary)
    log.info("Workspace: %s", workspace)

    threading.Thread(target=parent_watcher, args=(parent_pid,), daemon=True).start()

    xdg_cache = os.environ.get("XDG_CACHE_HOME") or os.path.join(os.path.expanduser("~"), ".cache")
    ipc_base = os.path.join(xdg_cache, "fresh", "copilot-ipc")
    os.makedirs(ipc_base, exist_ok=True)

    ipc_dir = os.path.join(ipc_base, str(os.getpid()))
    os.makedirs(ipc_dir, exist_ok=True)

    with open(port_file, "w") as f:
        f.write(ipc_dir)

    log.info("IPC directory: %s", ipc_dir)

    try:
        lsp_process = subprocess.Popen(
            [server_binary, "--stdio"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            cwd=workspace,
        )
    except (FileNotFoundError, PermissionError) as e:
        log.error("Failed to start Copilot Language Server: %s", e)
        with open(port_file, "w") as f:
            f.write("ERROR: " + str(e))
        sys.exit(1)

    log.info("Copilot Language Server started (pid=%d)", lsp_process.pid)

    threading.Thread(target=read_lsp_messages, daemon=True).start()

    threading.Thread(target=cmd_file_watcher, daemon=True).start()

    write_resp({"type": "ready"})

    try:
        while not shutdown_event.is_set():
            if lsp_process.poll() is not None:
                log.info("Copilot Language Server exited (code=%d)", lsp_process.returncode)
                write_resp({"type": "serverStopped"})
                break
            time.sleep(1)
    except KeyboardInterrupt:
        pass
    finally:
        shutdown_event.set()
        if lsp_process and lsp_process.poll() is None:
            lsp_process.terminate()
            try:
                lsp_process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                lsp_process.kill()
        try:
            for fn in os.listdir(ipc_dir):
                os.remove(os.path.join(ipc_dir, fn))
            os.rmdir(ipc_dir)
        except OSError:
            pass
        log.info("Copilot bridge stopped")


if __name__ == "__main__":
    main()
