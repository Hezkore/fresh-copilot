#!/usr/bin/env python3
"""
Copilot Chat - interactive terminal chat using GitHub Copilot Chat API
Usage: python3 copilot_chat.py [--context-file <path>] [--cursor-line <n>] [--selection-file <path>]
"""
import json
import os
import re
import sys
import urllib.request
import urllib.error
import argparse

# ── ANSI colors ───────────────────────────────────────────────────────────────
RESET   = "\033[0m"
BOLD    = "\033[1m"
DIM     = "\033[2m"
CYAN    = "\033[36m"
YELLOW  = "\033[33m"
GREEN   = "\033[32m"
RED     = "\033[31m"
MAGENTA = "\033[35m"
BLUE    = "\033[34m"

def print_banner(context_file: str | None, model: str):
    os.system("clear")
    print(f"\n{CYAN}{BOLD}  ◉ GitHub Copilot Chat{RESET}")
    if context_file:
        print(f"{DIM}  File: {context_file}{RESET}")
    print(f"{DIM}  Model: {model}  |  /help for commands{RESET}\n")

# ── Auth ──────────────────────────────────────────────────────────────────────
APPS_JSON = os.path.expanduser("~/.config/github-copilot/apps.json")
TOKEN_URL = "https://api.github.com/copilot_internal/v2/token"
CHAT_URL  = "https://api.githubcopilot.com/chat/completions"

_session_token: str | None = None
_session_expires: float = 0.0

def get_oauth_token() -> str:
    try:
        with open(APPS_JSON) as f:
            data = json.load(f)
        return list(data.values())[0]["oauth_token"]
    except Exception as e:
        print(f"{RED}Error reading auth: {e}{RESET}")
        sys.exit(1)

def get_session_token() -> str:
    global _session_token, _session_expires
    import time
    if _session_token and time.time() < _session_expires - 60:
        return _session_token
    oauth = get_oauth_token()
    req = urllib.request.Request(TOKEN_URL, headers={
        "Authorization": f"Bearer {oauth}",
        "Accept": "application/json",
        "editor-version": "vscode/1.85.0",
        "editor-plugin-version": "copilot-chat/0.12.0",
    })
    try:
        with urllib.request.urlopen(req) as resp:
            data = json.loads(resp.read())
            _session_token = data["token"]
            _session_expires = data.get("expires_at", time.time() + 1800)
            return _session_token
    except Exception as e:
        print(f"{RED}Failed to get session token: {e}{RESET}")
        sys.exit(1)

# ── Chat ──────────────────────────────────────────────────────────────────────
def stream_chat(messages: list, model: str) -> str:
    token = get_session_token()
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
    full_response = ""
    try:
        with urllib.request.urlopen(req) as resp:
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
                        full_response += delta
                        sys.stdout.write(delta)
                        sys.stdout.flush()
                except (KeyError, json.JSONDecodeError):
                    pass
    except urllib.error.HTTPError as e:
        body_text = e.read().decode()
        print(f"\n{RED}HTTP {e.code}: {body_text}{RESET}")
    except Exception as e:
        print(f"\n{RED}Error: {e}{RESET}")
    return full_response

# ── Code block extraction ─────────────────────────────────────────────────────
def extract_code_blocks(text: str) -> list[tuple[str, str]]:
    """Return list of (lang, code) from fenced code blocks."""
    pattern = r"```(\w*)\n(.*?)```"
    return re.findall(pattern, text, re.DOTALL)

def apply_to_file(context_file: str, code: str) -> bool:
    """Write code to context_file. Returns True on success."""
    try:
        with open(context_file, "w") as f:
            f.write(code)
        return True
    except Exception as e:
        print(f"{RED}Failed to write file: {e}{RESET}")
        return False

def prompt_apply(context_file: str, response: str) -> None:
    """If response has code blocks, offer to apply largest one to context_file."""
    blocks = extract_code_blocks(response)
    if not blocks:
        return
    # Pick the largest block
    lang, code = max(blocks, key=lambda b: len(b[1]))
    lines = code.count("\n") + 1
    print(f"\n{YELLOW}─── Code block detected ({lines} lines) ───{RESET}")
    print(f"{DIM}  Apply to {context_file}? [y/N] {RESET}", end="", flush=True)
    try:
        answer = input().strip().lower()
    except (EOFError, KeyboardInterrupt):
        answer = "n"
    if answer == "y":
        if apply_to_file(context_file, code):
            print(f"{GREEN}  ✓ Written to {context_file}{RESET}")
        # Reload file content in the system prompt on next refresh
    print()

# ── System prompt builder ─────────────────────────────────────────────────────
def build_system_message(context_file: str | None, cursor_line: int | None,
                          selection: str | None) -> str:
    parts = [
        "You are GitHub Copilot, a helpful AI programming assistant integrated into a terminal editor.",
        "Be concise, accurate, and helpful. Format all code with fenced markdown code blocks.",
        "When asked to edit or fix code, output the COMPLETE updated file content in a code block.",
        "Do not truncate or summarize — always output the full file so the user can apply it.",
    ]

    if context_file and os.path.isfile(context_file):
        try:
            with open(context_file) as f:
                file_content = f.read(48000)
            lang = os.path.splitext(context_file)[1].lstrip(".") or "text"
            parts.append(f"\nThe user is currently editing: `{context_file}`")
            if cursor_line is not None:
                parts.append(f"Their cursor is on line {cursor_line + 1}.")
            if selection:
                parts.append(f"\nThey have selected this text:\n```{lang}\n{selection}\n```")
            parts.append(f"\nFull file contents:\n```{lang}\n{file_content}\n```")
        except Exception:
            pass

    return "\n".join(parts)

# ── Main loop ─────────────────────────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--context-file", default=None)
    parser.add_argument("--cursor-line", type=int, default=None)
    parser.add_argument("--selection-file", default=None)
    args, _ = parser.parse_known_args()

    model = "gpt-4o"

    # Read selection if provided
    selection: str | None = None
    if args.selection_file and os.path.isfile(args.selection_file):
        try:
            with open(args.selection_file) as f:
                selection = f.read().strip() or None
        except Exception:
            pass

    def build_history_with_fresh_context() -> list:
        """Build fresh history with up-to-date file content."""
        system_content = build_system_message(args.context_file, args.cursor_line, selection)
        return [{"role": "system", "content": system_content}]

    history = build_history_with_fresh_context()

    print_banner(args.context_file, model)

    while True:
        try:
            sys.stdout.write(f"{GREEN}{BOLD}You:{RESET} ")
            sys.stdout.flush()
            user_input = input().strip()
        except (EOFError, KeyboardInterrupt):
            print(f"\n{DIM}Bye!{RESET}\n")
            break

        if not user_input:
            continue

        # ── Commands ──────────────────────────────────────────────────────────
        if user_input.lower() in ("/exit", "/quit", "/q"):
            print(f"\n{DIM}Bye!{RESET}\n")
            break

        if user_input.lower() == "/clear":
            history = build_history_with_fresh_context()
            print_banner(args.context_file, model)
            print(f"{DIM}  Conversation cleared.{RESET}\n")
            continue

        if user_input.lower().startswith("/model "):
            model = user_input[7:].strip()
            print(f"{DIM}  Switched to model: {model}{RESET}\n")
            continue

        if user_input.lower() == "/refresh":
            # Re-read the file from disk (in case it changed)
            history = build_history_with_fresh_context()
            print(f"{DIM}  File context refreshed.{RESET}\n")
            continue

        if user_input.lower() == "/apply":
            if not args.context_file:
                print(f"{RED}  No context file to apply to.{RESET}\n")
                continue
            # Find last assistant code block
            last_response = next(
                (m["content"] for m in reversed(history) if m["role"] == "assistant"), None
            )
            if not last_response:
                print(f"{RED}  No previous response to apply.{RESET}\n")
                continue
            prompt_apply(args.context_file, last_response)
            continue

        if user_input.lower() == "/help":
            print(f"\n{DIM}  Commands:")
            print(f"    /clear          Clear conversation history")
            print(f"    /refresh        Re-read file from disk into context")
            print(f"    /apply          Apply last code block to the context file")
            print(f"    /model <name>   Switch model (e.g. gpt-4o, claude-3.5-sonnet)")
            print(f"    /exit           Exit chat{RESET}\n")
            continue

        history.append({"role": "user", "content": user_input})

        print(f"\n{CYAN}{BOLD}Copilot:{RESET} ", end="", flush=True)
        response = stream_chat(history, model)
        print("\n")

        if response:
            history.append({"role": "assistant", "content": response})
            # Auto-offer to apply if context file present and response has code
            if args.context_file and extract_code_blocks(response):
                prompt_apply(args.context_file, response)

if __name__ == "__main__":
    main()
