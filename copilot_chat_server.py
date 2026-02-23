#!/usr/bin/env python3
"""Non-interactive IPC chat server for the Fresh Copilot Chat panel."""
import json
import os
import re
import sys
import time
import urllib.request
import urllib.error

APPS_JSON = os.path.expanduser("~/.config/github-copilot/apps.json")
TOKEN_URL = "https://api.github.com/copilot_internal/v2/token"
CHAT_URL  = "https://api.githubcopilot.com/chat/completions"

_session_token: str | None = None
_session_expires: float = 0.0

def get_oauth_token() -> str:
    with open(APPS_JSON) as f:
        data = json.load(f)
    return list(data.values())[0]["oauth_token"]

def get_session_token() -> str:
    global _session_token, _session_expires
    if _session_token and time.time() < _session_expires - 60:
        return _session_token
    oauth = get_oauth_token()
    req = urllib.request.Request(TOKEN_URL, headers={
        "Authorization": f"Bearer {oauth}",
        "Accept": "application/json",
        "editor-version": "vscode/1.85.0",
        "editor-plugin-version": "copilot-chat/0.12.0",
    })
    with urllib.request.urlopen(req) as resp:
        data = json.loads(resp.read())
        _session_token = data["token"]
        _session_expires = data.get("expires_at", time.time() + 1800)
        return _session_token

def build_system_message(context_file: str | None, cursor_line: int | None,
                          selection: str | None) -> str:
    parts = [
        "You are GitHub Copilot, a helpful AI programming assistant integrated into a terminal editor.",
        "Be concise and helpful. Format explanatory code with fenced markdown code blocks.",
        "When asked to edit or fix code in the current file, output ONLY the changed lines using this exact format:\n"
        "```edit\n"
        "<<<\n"
        "start_line: <1-based line number>\n"
        "end_line: <1-based line number, inclusive>\n"
        "---\n"
        "<replacement lines here>\n"
        ">>>\n"
        "```\n"
        "Use one <<<...>>> block per contiguous changed region. Do NOT output the whole file. "
        "start_line/end_line refer to the CURRENT line numbers in the file. "
        "end_line must include every existing line you are replacing or removing - if your "
        "replacement ends with a closing bracket/delimiter that already exists just after end_line, "
        "extend end_line to include it, otherwise it will be duplicated in the file. "
        "To insert lines before line N: set start_line=N, end_line=N-1 (end < start means pure insert). "
        "To delete lines: set start_line/end_line to the range and leave replacement empty. "
        "If the user is NOT asking to edit the file, just reply normally with text or code blocks.",
    ]
    if context_file and os.path.isfile(context_file):
        try:
            with open(context_file) as f:
                file_content = f.read(48000)
            lang = os.path.splitext(context_file)[1].lstrip(".") or "text"
            parts.append(f"\nThe user is editing: `{context_file}`")
            if cursor_line is not None:
                parts.append(f"Their cursor is on line {cursor_line + 1}.")
            if selection:
                parts.append(f"\nSelected text:\n```{lang}\n{selection}\n```")
            numbered = "\n".join(f"{i+1}: {l}" for i, l in enumerate(file_content.splitlines()))
            parts.append(f"\nFull file contents (with line numbers):\n```\n{numbered}\n```")
        except Exception:
            pass
    return "\n".join(parts)

def extract_edits(text: str) -> list[dict]:
    edits = []
    for block in re.findall(r"```edit\s*\n(.*?)(?:```|$)", text, re.DOTALL):
        for hunk in re.findall(r"<<<\s*\n(.*?)>>>", block, re.DOTALL):
            lines = hunk.splitlines()
            try:
                start_line = int(next(l.split(":")[1].strip() for l in lines if l.startswith("start_line:")))
                end_line   = int(next(l.split(":")[1].strip() for l in lines if l.startswith("end_line:")))
                sep = next((i for i, l in enumerate(lines) if l.strip() == "---"), None)
                if sep is not None:
                    replacement_lines = lines[sep+1:]
                    stripped = [re.sub(r"^\d+:\s?", "", rl) for rl in replacement_lines]
                    replacement = "\n".join(stripped)
                else:
                    replacement = ""
                edits.append({"start_line": start_line, "end_line": end_line, "replacement": replacement})
            except (StopIteration, ValueError):
                pass
    return edits

def stream_response(messages: list, model: str, req_id: str, resp_file: str, context_file: str | None = None) -> str:
    try:
        token = get_session_token()
    except Exception as e:
        with open(resp_file, "a") as f:
            f.write(json.dumps({"id": req_id, "type": "error", "content": f"Auth error: {e}"}) + "\n")
        return ""

    body = json.dumps({
        "model": model,
        "messages": messages,
        "stream": True,
        "temperature": 0.1,
        "top_p": 1,
    }).encode()
    req = urllib.request.Request(CHAT_URL, data=body, method="POST", headers={
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
        "Accept": "application/json",
        "editor-version": "vscode/1.85.0",
        "editor-plugin-version": "copilot-chat/0.12.0",
        "Copilot-Integration-Id": "vscode-chat",
    })
    full_content = ""
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            for raw_line in resp:
                line = raw_line.decode("utf-8").strip()
                if not line.startswith("data: "):
                    continue
                payload = line[6:]
                if payload == "[DONE]":
                    break
                try:
                    chunk = json.loads(payload)
                    choices = chunk.get("choices", [])
                    if not choices:
                        continue
                    delta = choices[0]["delta"].get("content", "")
                    if delta:
                        full_content += delta
                        with open(resp_file, "a") as f:
                            f.write(json.dumps({"id": req_id, "type": "chunk", "content": delta}) + "\n")
                except (KeyError, json.JSONDecodeError):
                    pass
    except urllib.error.HTTPError as e:
        err = e.read().decode()
        with open(resp_file, "a") as f:
            f.write(json.dumps({"id": req_id, "type": "error", "content": f"HTTP {e.code}: {err}"}) + "\n")
        return ""
    except Exception as e:
        with open(resp_file, "a") as f:
            f.write(json.dumps({"id": req_id, "type": "error", "content": str(e)}) + "\n")
        return ""

    edits = extract_edits(full_content)
    with open(resp_file, "a") as f:
        f.write(json.dumps({
            "id": req_id, "type": "done",
            "has_edits": len(edits) > 0,
            "edits": edits,
            "context_file": context_file,
        }) + "\n")
    return full_content

def run_server(ipc_dir: str) -> None:
    cmd_file  = os.path.join(ipc_dir, "chat_cmd")
    resp_file = os.path.join(ipc_dir, "chat_resp")

    portfile = os.path.join(ipc_dir, "chat_ready")
    with open(portfile, "w") as f:
        f.write("ready\n")

    model = "gpt-4o"
    # conversation: list of {role, content, context_file, cursor_line, selection}
    # We rebuild system message fresh each request to pick up file changes
    history: list[dict] = []
    last_cmd_size = 0

    while True:
        try:
            if os.path.exists(cmd_file):
                size = os.path.getsize(cmd_file)
                if size > last_cmd_size:
                    with open(cmd_file, "r") as f:
                        f.seek(last_cmd_size)
                        new_data = f.read()
                    last_cmd_size = size

                    for line in new_data.splitlines():
                        line = line.strip()
                        if not line:
                            continue
                        try:
                            cmd = json.loads(line)
                        except json.JSONDecodeError:
                            continue

                        cmd_type = cmd.get("type", "message")

                        if cmd_type == "clear":
                            history = []
                            last_cmd_size = 0
                            with open(cmd_file, "w") as f:
                                pass
                            with open(resp_file, "w") as f:
                                pass
                            continue

                        if cmd_type == "model":
                            model = cmd.get("model", model)
                            continue

                        if cmd_type == "message":
                            req_id = cmd.get("id", "")
                            message = cmd.get("message", "")
                            context_file = cmd.get("context_file")
                            cursor_line = cmd.get("cursor_line")
                            selection = cmd.get("selection")

                            system_msg = build_system_message(context_file, cursor_line, selection)
                            messages = [{"role": "system", "content": system_msg}]
                            for h in history:
                                messages.append({"role": h["role"], "content": h["content"]})
                            messages.append({"role": "user", "content": message})

                            assistant_text = stream_response(messages, model, req_id, resp_file, context_file)

                            history.append({"role": "user", "content": message})
                            if assistant_text:
                                history.append({"role": "assistant", "content": assistant_text})

        except Exception:
            pass

        time.sleep(0.05)

if __name__ == "__main__":
    ipc_dir = sys.argv[1] if len(sys.argv) > 1 else "/tmp/copilot_chat_ipc"
    os.makedirs(ipc_dir, exist_ok=True)
    run_server(ipc_dir)
