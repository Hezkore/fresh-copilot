/// <reference path="./lib/fresh.d.ts" />

const editor = getEditor();

interface CopilotState {
  ipcDir: string | null;
  initialized: boolean;
  status: string;
  statusKind: string;
  enabled: boolean;
  pendingCompletion: PendingCompletion | null;
  openDocuments: Map<string, DocumentState>;
}

interface DocumentState {
  version: number;
  text: string;
  languageId: string;
}

interface PendingCompletion {
  bufferId: number;
  cursorPos: number;
  insertText: string;
  rangeStart: number;
  rangeEnd: number;
  command: Record<string, unknown> | null;
  reqId: string;
}

interface CompletionItem {
  insertText: string;
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  } | null;
  command: Record<string, unknown> | null;
}

const state: CopilotState = {
  ipcDir: null,
  initialized: false,
  status: "not running",
  statusKind: "Normal",
  enabled: true,
  pendingCompletion: null,
  openDocuments: new Map(),
};

let serverProcess: ProcessHandle<BackgroundProcessResult> | null = null;
let pollActive = false;
let requestCounter = 0;
let completionDebounceActive = false;
let completionGeneration = 0;
let lastActiveBufferId: number | null = null;
// Maps reqId -> cursorPos at time of request, to validate results on arrival
const pendingCompletionRequests = new Map<string, number>();
let latestCompletionReqId: string | null = null;
const manualCompletionReqIds = new Set<string>();
let lastStatusWasOurs = false;

function setStatus(msg: string): void {
  lastStatusWasOurs = msg !== "";
  editor.setStatus(msg);
}

function getPluginDir(): string {
  const configDir = editor.getConfigDir();
  const candidates = [
    editor.pathJoin(configDir, "plugins", "packages", "copilot"),
    editor.pathJoin(configDir, "bundles", "packages", "copilot"),
  ];
  for (const dir of candidates) {
    if (editor.fileExists(editor.pathJoin(dir, "copilot_server.py"))) {
      return dir;
    }
  }
  return editor.pathJoin(configDir, "plugins", "packages", "copilot");
}

function findCopilotBinary(): string | null {
  const home = editor.getEnv("HOME") || "";
  const candidates = [
    editor.pathJoin(home, "node_modules", "@github", "copilot-language-server-linux-x64", "copilot-language-server"),
    editor.pathJoin(home, "node_modules", "@github", "copilot-language-server-darwin-arm64", "copilot-language-server"),
    editor.pathJoin(home, "node_modules", "@github", "copilot-language-server-darwin-x64", "copilot-language-server"),
    editor.pathJoin(home, "node_modules", "@github", "copilot-language-server-win32-x64", "copilot-language-server.exe"),
    "/usr/local/lib/node_modules/@github/copilot-language-server-linux-x64/copilot-language-server",
    "/usr/lib/node_modules/@github/copilot-language-server-linux-x64/copilot-language-server",
    // .js fallback
    editor.pathJoin(home, "node_modules", "@github", "copilot-language-server", "dist", "language-server.js"),
    "/usr/local/lib/node_modules/@github/copilot-language-server/dist/language-server.js",
  ];
  for (const p of candidates) {
    if (editor.fileExists(p)) return p;
  }
  return null;
}

function detectLanguageId(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() || "";
  const map: Record<string, string> = {
    ts: "typescript", tsx: "typescriptreact",
    js: "javascript", jsx: "javascriptreact",
    py: "python", rb: "ruby", go: "go",
    rs: "rust", c: "c", cpp: "cpp", cc: "cpp", h: "c", hpp: "cpp",
    java: "java", cs: "csharp", php: "php",
    html: "html", css: "css", scss: "scss", less: "less",
    json: "json", yaml: "yaml", yml: "yaml", toml: "toml",
    md: "markdown", sh: "shellscript", bash: "shellscript",
    lua: "lua", vim: "viml", sql: "sql", xml: "xml",
    kt: "kotlin", swift: "swift", dart: "dart", r: "r",
  };
  return map[ext] || "plaintext";
}

function nextReqId(): string {
  requestCounter++;
  return `fresh-${requestCounter}`;
}

function sendToServer(data: Record<string, unknown>): void {
  if (!state.ipcDir) return;
  const cmdFile = editor.pathJoin(state.ipcDir, "cmd");
  const line = JSON.stringify(data) + "\n";
  const existing = editor.readFile(cmdFile) || "";
  editor.writeFile(cmdFile, existing + line);
}

function readServerResponses(): string[] {
  if (!state.ipcDir) return [];
  const respFile = editor.pathJoin(state.ipcDir, "resp");
  const content = editor.readFile(respFile);
  if (!content) return [];
  editor.writeFile(respFile, "");
  return content.split("\n").filter(l => l.trim());
}

async function startServer(): Promise<boolean> {
  if (state.ipcDir !== null) {
    setStatus("Copilot: already running");
    return false;
  }

  const serverBinary = findCopilotBinary();
  if (!serverBinary) {
    setStatus("Copilot: language server not found. Run: npm install @github/copilot-language-server");
    return false;
  }

  const pluginDir = getPluginDir();
  const serverScript = editor.pathJoin(pluginDir, "copilot_server.py");
  if (!editor.fileExists(serverScript)) {
    setStatus(`Copilot: server script not found at ${serverScript}`);
    return false;
  }

  const workspace = editor.getCwd();
  const xdgCache = editor.getEnv("XDG_CACHE_HOME") ||
    editor.pathJoin(editor.getEnv("HOME") || "", ".cache");
  const ipcBase = editor.pathJoin(xdgCache, "fresh", "copilot-ipc");
  await editor.spawnProcess("mkdir", ["-p", ipcBase]);

  const portFile = editor.pathJoin(ipcBase, `starting-${Date.now()}.tmp`);

  let cmd: string;
  let args: string[];
  if (serverBinary.endsWith(".js")) {
    cmd = "python3";
    args = [serverScript, `node ${serverBinary}`, workspace, portFile];
  } else {
    cmd = "python3";
    args = [serverScript, serverBinary, workspace, portFile];
  }

  setStatus("Copilot: starting...");
  serverProcess = editor.spawnBackgroundProcess(cmd, args);

  let foundIpcDir: string | null = null;
  for (let i = 0; i < 30; i++) {
    await editor.delay(200);
    const content = editor.readFile(portFile);
    if (content && content.trim() && !content.startsWith("ERROR:")) {
      foundIpcDir = content.trim();
      break;
    }
    if (content && content.startsWith("ERROR:")) {
      setStatus(`Copilot: ${content}`);
      editor.writeFile(portFile, "");
      return false;
    }
  }
  editor.writeFile(portFile, "");

  if (!foundIpcDir) {
    setStatus("Copilot: server failed to start (timeout)");
    await stopServer();
    return false;
  }

  state.ipcDir = foundIpcDir;
  setStatus("Copilot: server started, initializing...");

  startPolling();
  startEventTracking();

  return true;
}

async function stopServer(): Promise<void> {
  stopEventTracking();
  pollActive = false;
  clearPendingCompletion();

  if (serverProcess) {
    await serverProcess.kill();
    serverProcess = null;
  }

  for (const [uri] of state.openDocuments) {
    sendToServer({ type: "closeDocument", uri });
  }

  state.ipcDir = null;
  state.initialized = false;
  state.status = "not running";
  state.statusKind = "Normal";
  state.openDocuments.clear();

  setStatus("Copilot: stopped");
}

function initializeLSP(): void {
  const workspace = editor.getCwd();
  sendToServer({
    type: "initialize",
    id: nextReqId(),
    workspaceFolders: [workspace],
    processId: 0,
  });
}

function sendConfiguration(): void {
  sendToServer({
    type: "configuration",
    settings: {
      http: {},
      telemetry: { telemetryLevel: "all" },
    },
  });
}

async function syncOpenDocuments(): Promise<void> {
  const buffers = editor.listBuffers();
  for (const buf of buffers) {
    if (!buf.path || !editor.fileExists(buf.path)) continue;
    await openDocument(buf.id);
  }
}

async function openDocument(bufferId: number): Promise<void> {
  const path = editor.getBufferPath(bufferId);
  if (!path || !editor.fileExists(path)) return;
  const uri = "file://" + path;
  if (state.openDocuments.has(uri)) return;

  const length = editor.getBufferLength(bufferId);
  const text = length > 0 ? await editor.getBufferText(bufferId, 0, length) : "";
  const languageId = detectLanguageId(path);

  state.openDocuments.set(uri, { version: 1, text, languageId });
  sendToServer({ type: "openDocument", uri, text, languageId, version: 1 });
}

async function changeDocument(bufferId: number): Promise<void> {
  const path = editor.getBufferPath(bufferId);
  if (!path) return;
  const uri = "file://" + path;

  const doc = state.openDocuments.get(uri);
  if (!doc) {
    await openDocument(bufferId);
    return;
  }

  const length = editor.getBufferLength(bufferId);
  const text = length > 0 ? await editor.getBufferText(bufferId, 0, length) : "";

  if (text === doc.text) return; // no change

  doc.version++;
  doc.text = text;

  sendToServer({
    type: "changeDocument",
    uri,
    version: doc.version,
    changes: [{ text }], // full document sync
  });
}

function closeDocument(path: string): void {
  const uri = "file://" + path;
  if (!state.openDocuments.has(uri)) return;
  state.openDocuments.delete(uri);
  sendToServer({ type: "closeDocument", uri });
}

async function requestCompletion(bufferId: number, manual = false): Promise<void> {
  if (!state.initialized) return;
  if (!manual && !state.enabled) return;
  if (state.statusKind === "Error") return;

  const path = editor.getBufferPath(bufferId);
  if (!path || !editor.fileExists(path)) return;
  const uri = "file://" + path;

  const doc = state.openDocuments.get(uri);
  if (!doc) return;

  const cursorPos = editor.getCursorPosition();
  const text = doc.text;
  const prefix = text.slice(0, cursorPos);
  const line = (prefix.match(/\n/g) || []).length;
  const lastNl = prefix.lastIndexOf("\n");
  const character = cursorPos - (lastNl + 1);

  const reqId = nextReqId();
  if (manual) manualCompletionReqIds.add(reqId);
  pendingCompletionRequests.set(reqId, cursorPos);
  latestCompletionReqId = reqId;
  sendToServer({
    type: "inlineCompletion",
    id: reqId,
    uri,
    version: doc.version,
    position: { line, character },
    triggerKind: 2, // automatic
    formattingOptions: { tabSize: 4, insertSpaces: true },
  });
}

function scheduleCompletion(): void {
  if (!state.initialized || !state.enabled) return;
  const gen = ++completionGeneration;
  completionDebounceActive = true;
  (async () => {
    await editor.delay(300);
    if (gen !== completionGeneration) return; // superseded by a newer keystroke
    completionDebounceActive = false;
    const bufferId = editor.getActiveBufferId();
    if (bufferId === null || bufferId === undefined) return;
    await changeDocument(bufferId);
    await requestCompletion(bufferId);
  })();
}

function clearPendingCompletion(): void {
  latestCompletionReqId = null;
  if (state.pendingCompletion) {
    const { bufferId } = state.pendingCompletion;
    editor.removeVirtualTextsByPrefix(bufferId, "copilot-ghost-");
    state.pendingCompletion = null;
  }
}

async function showCompletion(
  bufferId: number,
  item: CompletionItem,
  reqId: string,
): Promise<void> {
  const { insertText, command } = item;
  if (!insertText) return;

  const cursorPos = editor.getCursorPosition();

  // Determine range for replacement (where the completion inserts/replaces)
  let rangeStart = cursorPos;
  let rangeEnd = cursorPos;

  if (item.range) {
    const doc = state.openDocuments.get("file://" + editor.getBufferPath(bufferId));
    if (doc) {
      const lines = doc.text.split("\n");
      let startOff = 0;
      for (let i = 0; i < item.range.start.line && i < lines.length; i++) {
        startOff += lines[i].length + 1;
      }
      startOff += item.range.start.character;
      let endOff = 0;
      for (let i = 0; i < item.range.end.line && i < lines.length; i++) {
        endOff += lines[i].length + 1;
      }
      endOff += item.range.end.character;
      rangeStart = startOff;
      rangeEnd = endOff;
    }
  }

  clearPendingCompletion();

  // show only untyped suffix
  const alreadyTyped = cursorPos - rangeStart;
  if (alreadyTyped > 0) {
    // drop if user typed something that diverges from suggestion
    const typedSoFar = await editor.getBufferText(bufferId, rangeStart, cursorPos);
    if (!insertText.startsWith(typedSoFar)) return;
  }
  const ghostText = insertText.slice(alreadyTyped);
  if (!ghostText) return;

  // only store after all checks - acceptCompletion guards on this
  state.pendingCompletion = {
    bufferId,
    cursorPos,
    insertText,
    rangeStart,
    rangeEnd,
    command: command as Record<string, unknown> | null,
    reqId,
  };

  const lines = ghostText.split("\n");

  editor.addVirtualText(bufferId, `copilot-ghost-0`, cursorPos, lines[0], 128, 128, 128, true, false);

  for (let i = 1; i < lines.length; i++) {
    editor.addVirtualText(bufferId, `copilot-ghost-${i}`, cursorPos, "\n" + lines[i], 128, 128, 128, true, false);
  }

  // Notify server that we showed the completion
  sendToServer({ type: "didShowCompletion", item: { command } });
}

async function acceptCompletion(): Promise<void> {
  const comp = state.pendingCompletion;
  if (!comp) return;

  const { bufferId, insertText, rangeStart, cursorPos, command } = comp;

  // insert only untyped suffix, single undo step
  const alreadyTyped = cursorPos - rangeStart;
  const suffix = insertText.slice(alreadyTyped);
  if (suffix) {
    editor.insertText(bufferId, cursorPos, suffix);
  }

  if (command) {
    sendToServer({ type: "didAcceptCompletion", command });
  }

  clearPendingCompletion();
}

async function startPolling(): Promise<void> {
  pollActive = true;
  while (pollActive && state.ipcDir) {
    const lines = readServerResponses();
    for (const line of lines) {
      try {
        const msg = JSON.parse(line);
        await handleServerMessage(msg);
      } catch { /* ignore */ }
    }
    await editor.delay(100);
  }
}

async function handleServerMessage(msg: Record<string, unknown>): Promise<void> {
  const msgType = msg.type as string;

  if (msgType === "ready") {
    initializeLSP();
    return;
  }

  if (msgType === "initialized") {
    state.initialized = true;
    sendConfiguration();
    await syncOpenDocuments();
    const bufferId = editor.getActiveBufferId();
    if (bufferId !== null && bufferId !== undefined) {
      const path = editor.getBufferPath(bufferId);
      if (path) {
        sendToServer({ type: "focusDocument", uri: "file://" + path });
      }
    }
    setStatus("● Copilot: ready");
    return;
  }

  if (msgType === "statusChanged") {
    state.status = (msg.message as string) || "";
    state.statusKind = (msg.kind as string) || "Normal";
    const icon = state.statusKind === "Error" ? "✗" :
                 state.statusKind === "Warning" ? "⚠" : "●";
    if (state.status) {
      setStatus(`${icon} Copilot: ${state.status}`);
    }
    return;
  }

  if (msgType === "completionResult") {
    const reqId = msg.id as string;
    const isManual = manualCompletionReqIds.delete(reqId);
    if (!state.enabled && !isManual) return;
    const requestedAt = pendingCompletionRequests.get(reqId);
    pendingCompletionRequests.delete(reqId);
    // stale - superseded
    if (reqId !== latestCompletionReqId) return;
    const items = (msg.items as CompletionItem[]) || [];
    if (items.length === 0) {
      clearPendingCompletion();
      return;
    }
    const bufferId = editor.getActiveBufferId();
    if (bufferId === null || bufferId === undefined) return;
    // cursor moved since request - skip
    if (requestedAt !== undefined && editor.getCursorPosition() !== requestedAt) return;
    await showCompletion(bufferId, items[0], reqId);
    return;
  }

  if (msgType === "signInResult") {
    const userCode = msg.userCode as string;
    const verificationUri = msg.verificationUri as string;
    if (userCode) {
      setStatus(`Copilot: Sign in with code ${userCode} at ${verificationUri}`);
      // open browser
      const command = msg.command as Record<string, unknown> | null;
      if (command) {
        sendToServer({
          type: "executeCommand",
          id: nextReqId(),
          command: command.command,
          arguments: command.arguments || [],
        });
      }
    } else {
      setStatus("Copilot: sign-in initiated (check browser)");
    }
    return;
  }

  if (msgType === "signOutResult") {
    setStatus("Copilot: signed out");
    return;
  }

  if (msgType === "showDocument") {
    const uri = msg.uri as string;
    if (uri && !uri.startsWith("file://")) {
      setStatus(`Copilot: open in browser: ${uri}`);
    }
    return;
  }

  if (msgType === "showMessage" || msgType === "showMessageRequest") {
    setStatus(`Copilot: ${msg.message}`);
    return;
  }

  if (msgType === "serverStopped") {
    state.initialized = false;
    state.status = "stopped";
    setStatus("Copilot: language server stopped");
    return;
  }

  if (msgType === "error") {
    editor.debug(`Copilot error: ${JSON.stringify(msg.error)}`);
    return;
  }
}

function startEventTracking(): void {
  editor.on("cursor_moved", "copilot_on_cursor_moved");
  editor.on("after_insert", "copilot_on_buffer_changed");
  editor.on("after_delete", "copilot_on_buffer_changed");
  editor.on("buffer_activated", "copilot_on_buffer_opened");
  editor.on("buffer_closed", "copilot_on_buffer_closed");
}

function stopEventTracking(): void {
  editor.off("cursor_moved", "copilot_on_cursor_moved");
  editor.off("after_insert", "copilot_on_buffer_changed");
  editor.off("after_delete", "copilot_on_buffer_changed");
  editor.off("buffer_activated", "copilot_on_buffer_opened");
  editor.off("buffer_closed", "copilot_on_buffer_closed");
}

globalThis.copilot_on_cursor_moved = function(): void {
  const cursorPos = editor.getCursorPosition();
  const bufferId = editor.getActiveBufferId();

  if (state.pendingCompletion) {
    if (cursorPos !== state.pendingCompletion.cursorPos || bufferId !== state.pendingCompletion.bufferId) {
      clearPendingCompletion();
    }
  }

  // Only clear the status if we were the last to write it
  if (lastStatusWasOurs) {
    setStatus("");
  }

  if (bufferId !== lastActiveBufferId) {
    lastActiveBufferId = bufferId;
    if (bufferId !== null && bufferId !== undefined && state.initialized) {
      const path = editor.getBufferPath(bufferId);
      if (path) {
        sendToServer({ type: "focusDocument", uri: "file://" + path });
        openDocument(bufferId);
      }
    }
  }

  scheduleCompletion();
};

globalThis.copilot_on_buffer_changed = function(): void {
  clearPendingCompletion();
  scheduleCompletion();
};

globalThis.copilot_on_buffer_opened = async function(): Promise<void> {
  if (!state.initialized) return;
  const bufferId = editor.getActiveBufferId();
  if (bufferId === null || bufferId === undefined) return;
  await openDocument(bufferId);
  const path = editor.getBufferPath(bufferId);
  if (path) sendToServer({ type: "focusDocument", uri: "file://" + path });
};

globalThis.copilot_on_buffer_closed = function(): void {
  if (!state.initialized) return;
  const openPaths = new Set(
    editor.listBuffers().map(b => b.path).filter(Boolean)
  );
  for (const [uri] of state.openDocuments) {
    const path = uri.replace("file://", "");
    if (!openPaths.has(path)) {
      closeDocument(path);
    }
  }
};

globalThis.copilot_trigger = async function(): Promise<void> {
  if (!state.initialized) {
    setStatus("Copilot: not running - use 'Copilot: Start' first");
    return;
  }
  const bufferId = editor.getActiveBufferId();
  if (bufferId === null || bufferId === undefined) return;
  setStatus("● Copilot: fetching suggestion...");
  clearPendingCompletion();
  await changeDocument(bufferId);
  await requestCompletion(bufferId, true);
};

globalThis.copilot_accept = async function(): Promise<void> {
  if (state.pendingCompletion) {
    await acceptCompletion();
  } else {
    // Pass through Tab to the editor
    editor.executeAction("insert_tab");
  }
};

globalThis.copilot_dismiss = function(): void {
  if (state.pendingCompletion) {
    clearPendingCompletion();
  }
};

globalThis.copilot_start = async function(): Promise<void> {
  await startServer();
};

globalThis.copilot_stop = async function(): Promise<void> {
  await stopServer();
};

globalThis.copilot_sign_in = async function(): Promise<void> {
  if (!state.initialized) {
    setStatus("Copilot: not running - use 'Copilot: Start' first");
    return;
  }
  const reqId = nextReqId();
  sendToServer({ type: "signIn", id: reqId });
  setStatus("Copilot: signing in...");
};

globalThis.copilot_sign_out = async function(): Promise<void> {
  if (!state.initialized) {
    setStatus("Copilot: not running");
    return;
  }
  const reqId = nextReqId();
  sendToServer({ type: "signOut", id: reqId });
};

globalThis.copilot_toggle = function(): void {
  state.enabled = !state.enabled;
  if (!state.enabled) {
    clearPendingCompletion();
    setStatus("Copilot: completions disabled");
  } else {
    setStatus("Copilot: completions enabled");
    scheduleCompletion();
  }
};

globalThis.copilot_status = function(): void {
  if (!state.initialized) {
    setStatus("Copilot: not running");
    return;
  }
  const icon = state.statusKind === "Error" ? "✗" :
               state.statusKind === "Warning" ? "⚠" : "●";
  const enabled = state.enabled ? "" : " [disabled]";
  setStatus(`${icon} Copilot: ${state.status || "ready"}${enabled}`);
};

type ChatEntry = { role: "user" | "assistant"; text: string };

const CHAT_NS = "copilot-chat";
const COLOR_HEADER:    [number, number, number] = [80,  80,  80];
const COLOR_USER_LABEL:[number, number, number] = [100, 200, 100];
const COLOR_BOT_LABEL: [number, number, number] = [100, 170, 255];
const COLOR_THINKING:  [number, number, number] = [120, 120, 120];
const COLOR_SEPARATOR: [number, number, number] = [55,  55,  55];
const COLOR_DIFF_ADD:  [number, number, number] = [80,  180, 80];
const COLOR_DIFF_DEL:  [number, number, number] = [200, 70,  70];
const COLOR_DIFF_HDR:  [number, number, number] = [100, 140, 200];
const COLOR_CODE:      [number, number, number] = [180, 180, 130];

interface ChatState {
  bufferId:    number | null;
  splitId:     number | null;
  ipcDir:      string | null;
  contextFile: string | null;
  cursorLine:  number;
  selection:   string | null;
  model:       string;
  history:     ChatEntry[];
  streaming:   boolean;
  streamingText: string;
}

const chatState: ChatState = {
  bufferId: null, splitId: null, ipcDir: null,
  contextFile: null, cursorLine: 0, selection: null,
  model: "gpt-4o", history: [], streaming: false, streamingText: "",
};

function chatLine(width = 50): string { return "─".repeat(width) + "\n"; }

interface Segment {
  kind: string; // "text" | "edit_hunk" | "code"
  text?: string;
  header?: string;
  removed?: string[];
  added?: string[];
  lang?: string;
}

function parseSegments(raw: string): Segment[] {
  const segments: Segment[] = [];
  const lines = raw.split("\n");
  let i = 0;
  let textBuf = "";

  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith("```")) {
      if (textBuf) { segments.push({ kind: "text", text: textBuf }); textBuf = ""; }
      const fence = line.slice(3).trim();
      i++;
      if (fence === "edit") {
        // Collect hunks
        while (i < lines.length && !lines[i].startsWith("```")) {
          if (lines[i].trim() === "<<<") {
            i++;
            const hunkLines: string[] = [];
            while (i < lines.length && lines[i].trim() !== ">>>") {
              hunkLines.push(lines[i]);
              i++;
            }
            i++; // skip >>>
            const startLine = parseInt((hunkLines.find((l: string) => l.startsWith("start_line:")) || "start_line:0").split(":")[1] || "0");
            const endLine   = parseInt((hunkLines.find((l: string) => l.startsWith("end_line:"))   || "end_line:0").split(":")[1]   || "0");
            const sep = hunkLines.findIndex((l: string) => l.trim() === "---");
            const added = sep >= 0 ? hunkLines.slice(sep + 1) : [];
            const header = endLine >= startLine ? `@@ lines ${startLine}-${endLine} @@` : `@@ insert at ${startLine} @@`;
            segments.push({ kind: "edit_hunk", header, removed: endLine >= startLine ? ["(replaced)"] : [], added });
          } else {
            i++;
          }
        }
      } else {
        let codeBuf = "";
        while (i < lines.length && !lines[i].startsWith("```")) {
          codeBuf += lines[i] + "\n";
          i++;
        }
        segments.push({ kind: "code", lang: fence, text: codeBuf });
      }
      i++; // skip closing ```
    } else {
      textBuf += line + "\n";
      i++;
    }
  }
  if (textBuf) segments.push({ kind: "text", text: textBuf });
  return segments;
}

function buildAssistantDisplay(raw: string): string {
  const segs = parseSegments(raw);
  let out = "";
  for (const seg of segs) {
    if (seg.kind === "text") {
      out += seg.text || "";
    } else if (seg.kind === "edit_hunk") {
      out += (seg.header || "") + "\n";
      for (const l of (seg.removed || [])) out += "- " + l + "\n";
      for (const l of (seg.added   || [])) out += "+ " + l + "\n";
    } else {
      out += seg.text || "";
    }
  }
  return out;
}

function overlayAssistantText(
  _bufferId: number, raw: string,
  mark: (t: string, fg: [number,number,number], bold?: boolean) => void,
  skip: (t: string) => void
): void {
  const segs = parseSegments(raw);
  for (const seg of segs) {
    if (seg.kind === "text") {
      skip(seg.text || "");
    } else if (seg.kind === "edit_hunk") {
      mark((seg.header || "") + "\n", COLOR_DIFF_HDR, true);
      for (const l of (seg.removed || [])) mark("- " + l + "\n", COLOR_DIFF_DEL);
      for (const l of (seg.added   || [])) mark("+ " + l + "\n", COLOR_DIFF_ADD);
    } else {
      mark(seg.text || "", COLOR_CODE);
    }
  }
  skip("\n\n");
}

function chatBuildEntries(): TextPropertyEntry[] {
  const entries: TextPropertyEntry[] = [];
  entries.push({ text: `◉ Copilot Chat  │  ${chatState.model}\n` });
  if (chatState.contextFile) entries.push({ text: `  ${chatState.contextFile}\n` });
  entries.push({ text: chatLine() });
  entries.push({ text: "\n" });

  for (const item of chatState.history) {
    entries.push({ text: item.role === "user" ? "  You\n" : "  Copilot\n" });
    const display = item.role === "assistant" ? buildAssistantDisplay(item.text) : item.text;
    entries.push({ text: display + "\n\n" });
    entries.push({ text: chatLine() });
  }

  if (chatState.streaming) {
    entries.push({ text: "  Copilot\n" });
    entries.push({ text: (chatState.streamingText || "…") + "\n" });
  } else if (chatState.history.length === 0) {
    entries.push({ text: "  Use 'Copilot: Ask' (Ctrl+Alt+C) to send a message.\n" });
  }
  return entries;
}

function chatApplyOverlays(bufferId: number): void {
  editor.clearNamespace(bufferId, CHAT_NS);
  let byte = 0;
  const mark = (text: string, fg: [number,number,number], bold = false) => {
    const len = editor.utf8ByteLength(text);
    editor.addOverlay(bufferId, CHAT_NS, byte, byte + len, { fg, bold });
    byte += len;
  };
  const skip = (text: string) => { byte += editor.utf8ByteLength(text); };

  const headerLine = `◉ Copilot Chat  │  ${chatState.model}\n`;
  mark(headerLine, COLOR_HEADER);
  if (chatState.contextFile) mark(`  ${chatState.contextFile}\n`, COLOR_HEADER);
  mark(chatLine(), COLOR_SEPARATOR);
  skip("\n");

  for (const item of chatState.history) {
    if (item.role === "user") {
      mark("  You\n", COLOR_USER_LABEL, true);
      skip(item.text + "\n\n");
    } else {
      mark("  Copilot\n", COLOR_BOT_LABEL, true);
      overlayAssistantText(bufferId, item.text, mark, skip);
    }
    mark(chatLine(), COLOR_SEPARATOR);
  }

  if (chatState.streaming) {
    mark("  Copilot\n", COLOR_BOT_LABEL, true);
    if (!chatState.streamingText) mark("…\n", COLOR_THINKING);
  } else if (chatState.history.length === 0) {
    mark("  Use 'Copilot: Ask' (Ctrl+Alt+C) to send a message.\n", COLOR_THINKING);
  }
}

function chatRefreshBuffer(): void {
  if (chatState.bufferId === null || chatState.splitId === null) return;
  editor.setVirtualBufferContent(chatState.bufferId, chatBuildEntries());
  chatApplyOverlays(chatState.bufferId);
  // Auto-scroll to bottom
  editor.scrollToLineCenter(chatState.splitId, chatState.bufferId, 999999);
}

async function chatEnsureOpen(): Promise<boolean> {
  if (chatState.bufferId !== null) return true;

  const result = await editor.createVirtualBufferInSplit({
    name: "*Copilot*",
    mode: "copilot-chat",
    readOnly: true,
    editingDisabled: true,
    showLineNumbers: false,
    showCursors: false,
    lineWrap: true,
    direction: "horizontal",
    ratio: 0.35,
    panelId: "copilot-chat",
    entries: [{ text: "  Starting…\n" }],
  });

  chatState.bufferId = result.bufferId;
  chatState.splitId = result.splitId ?? null;
  // Remove column rulers from the chat panel
  if (chatState.splitId !== null) {
    editor.setLayoutHints(chatState.bufferId, chatState.splitId, { composeWidth: null, columnGuides: [] });
  }
  editor.on("buffer_closed", "copilot_on_chat_closed");

  if (!chatState.ipcDir) {
    const pluginDir = getPluginDir();
    const serverScript = editor.pathJoin(pluginDir, "copilot_chat_server.py");
    const ipcDir = `/tmp/copilot_chat_${Date.now()}`;
    chatState.ipcDir = ipcDir;
    await editor.spawnProcess("mkdir", ["-p", ipcDir]);
    editor.spawnProcess("python3", [serverScript, ipcDir]);
    const readyFile = editor.pathJoin(ipcDir, "chat_ready");
    for (let i = 0; i < 50; i++) {
      await editor.delay(100);
      if (editor.fileExists(readyFile)) break;
    }
  }

  chatRefreshBuffer();
  return true;
}

async function applyEdits(filePath: string, edits: Array<{start_line: number; end_line: number; replacement: string}>): Promise<void> {
  editor.setStatus(`Copilot: applying ${edits.length} edit(s)...`);

  // open via editor so edits land in undo history
  let bufferId = editor.findBufferByPath(filePath);
  if (!bufferId) {
    editor.openFile(filePath, null, null);
    bufferId = editor.findBufferByPath(filePath);
  }
  if (!bufferId) { editor.setStatus("Copilot: could not open buffer for edits"); return; }

  const content = editor.readFile(filePath);
  if (content === null) { editor.setStatus("Copilot: could not read file for edits"); return; }

  const rawLines = content.split("\n");
  const lineStartBytes: number[] = [];
  let off = 0;
  for (const line of rawLines) {
    lineStartBytes.push(off);
    off += editor.utf8ByteLength(line) + 1; // +1 for the \n
  }
  lineStartBytes.push(off); // sentinel past end

  // reverse order so byte offsets stay valid
  const sorted = [...edits].sort((a, b) => b.start_line - a.start_line);
  let applied = 0;

  for (const edit of sorted) {
    const s = edit.start_line - 1; // 0-indexed
    const e = edit.end_line - 1;
    const replacement = edit.replacement === "" ? "" : edit.replacement + "\n";

    if (edit.end_line < edit.start_line) {
      // Pure insert before start_line
      editor.insertText(bufferId, lineStartBytes[s], replacement);
    } else {
      const startByte = lineStartBytes[s];
      const endByte   = lineStartBytes[Math.min(e + 1, rawLines.length)];
      editor.deleteRange(bufferId, startByte, endByte);
      if (replacement) editor.insertText(bufferId, startByte, replacement);
    }
    applied++;
  }

  if (applied > 0) {
    editor.setStatus(`Copilot: applied ${applied} edit${applied !== 1 ? "s" : ""} to ${filePath.split("/").pop()}`);
  }
}

async function chatSendMessage(message: string): Promise<void> {
  if (!chatState.ipcDir) return;
  const reqId = `chat_${Date.now()}`;
  const cmdFile  = editor.pathJoin(chatState.ipcDir, "chat_cmd");
  const respFile = editor.pathJoin(chatState.ipcDir, "chat_resp");

  chatState.history.push({ role: "user", text: message });
  chatState.streaming = true;
  chatState.streamingText = "";
  chatRefreshBuffer();

  const existing = editor.readFile(cmdFile) || "";
  editor.writeFile(cmdFile, existing + JSON.stringify({
    id: reqId, type: "message", message,
    context_file: chatState.contextFile,
    cursor_line: chatState.cursorLine,
    selection: chatState.selection,
    model: chatState.model,
  }) + "\n");

  let respOffset = 0;
  const start = Date.now();
  while (Date.now() - start < 120000) {
    await editor.delay(100);
    if (!editor.fileExists(respFile)) continue;
    const content = editor.readFile(respFile) || "";
    const lines = content.split("\n");
    let done = false;
    let newOffset = 0;
    for (const line of lines) {
      newOffset += editor.utf8ByteLength(line) + 1;
      if (newOffset <= respOffset || !line.trim()) continue;
      let msg: { id: string; type: string; content?: string; edits?: Array<{start_line: number; end_line: number; replacement: string}>; context_file?: string };
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id !== reqId) continue;
      if (msg.type === "chunk") {
        chatState.streamingText += msg.content || "";
        chatRefreshBuffer();
      } else if (msg.type === "done" || msg.type === "error") {
        if (msg.type === "error") chatState.streamingText = `Error: ${msg.content}`;
        chatState.history.push({ role: "assistant", text: chatState.streamingText });
        chatState.streaming = false;
        chatState.streamingText = "";
        chatRefreshBuffer();
        if (msg.type === "done" && msg.edits && msg.edits.length > 0 && msg.context_file) {
          await applyEdits(msg.context_file, msg.edits);
        }
        done = true;
        break;
      }
    }
    respOffset = newOffset;
    if (done) break;
  }
  if (chatState.streaming) {
    chatState.history.push({ role: "assistant", text: chatState.streamingText || "(timeout)" });
    chatState.streaming = false;
    chatState.streamingText = "";
    chatRefreshBuffer();
  }
}


globalThis.copilot_open_chat = async function(): Promise<void> {
  await chatEnsureOpen();
  if (chatState.splitId !== null) editor.focusSplit(chatState.splitId);
};

globalThis.copilot_close_chat = function(): void {
  editor.off("buffer_closed", "copilot_on_chat_closed");
  if (chatState.splitId !== null) editor.closeSplit(chatState.splitId);
  chatState.bufferId = null;
  chatState.splitId = null;
};

globalThis.copilot_on_chat_closed = function(data: { buffer_id: number }): void {
  if (data.buffer_id !== chatState.bufferId) return;
  editor.off("buffer_closed", "copilot_on_chat_closed");
  chatState.bufferId = null;
  chatState.splitId = null;
};

globalThis.copilot_ask = async function(): Promise<void> {
  // capture context before panel opens
  const srcSplitId = editor.getActiveSplitId();
  const srcBufferId = editor.getActiveBufferId();
  const srcPath = srcBufferId >= 0 ? editor.getBufferPath(srcBufferId) : null;
  if (srcPath) {
    chatState.contextFile = srcPath;
    chatState.cursorLine = editor.getCursorLine();
    chatState.selection = null;
    const cursor = editor.getPrimaryCursor();
    if (cursor && cursor.selection) {
      chatState.selection = await editor.getBufferText(srcBufferId, cursor.selection.start, cursor.selection.end) || null;
    }
  }

  await chatEnsureOpen();

  const input = await editor.prompt("To Copilot> ", "");
  if (!input || !input.trim()) return;

  const trimmed = input.trim();
  if (trimmed === "/clear") {
    chatState.history = [];
    if (chatState.ipcDir) {
      const cmdFile = editor.pathJoin(chatState.ipcDir, "chat_cmd");
      editor.writeFile(cmdFile, JSON.stringify({ type: "clear" }) + "\n");
      editor.writeFile(editor.pathJoin(chatState.ipcDir, "chat_resp"), "");
    }
    chatRefreshBuffer();
    if (srcSplitId >= 0) editor.focusSplit(srcSplitId);
    return;
  }
  if (trimmed.startsWith("/model ")) {
    chatState.model = trimmed.slice(7).trim();
    if (chatState.ipcDir) {
      const cmdFile = editor.pathJoin(chatState.ipcDir, "chat_cmd");
      const e = editor.readFile(cmdFile) || "";
      editor.writeFile(cmdFile, e + JSON.stringify({ type: "model", model: chatState.model }) + "\n");
    }
    chatRefreshBuffer();
    if (srcSplitId >= 0) editor.focusSplit(srcSplitId);
    return;
  }

  // refocus before async send
  if (srcSplitId >= 0) editor.focusSplit(srcSplitId);

  await chatSendMessage(trimmed);
};

// Chat panel mode (Esc to close)
editor.defineMode(
  "copilot-chat",
  null,
  [
    ["Escape", "copilot_close_chat"],
    ["C-M-c", "copilot_ask"],
  ],
  true
);

editor.defineMode(
  "copilot",
  "normal",
  [
    ["C-Return", "copilot_accept"],
    ["C-M-s", "copilot_trigger"],
    ["C-M-t", "copilot_toggle"],
    ["C-M-d", "copilot_dismiss"],
    ["C-M-c", "copilot_ask"],
  ]
);
editor.setEditorMode("copilot");

editor.registerCommand("Copilot: Trigger Suggestion", "Manually request a Copilot suggestion", "copilot_trigger", null);
editor.registerCommand("Copilot: Start", "Start the GitHub Copilot integration", "copilot_start", null);
editor.registerCommand("Copilot: Stop", "Stop the GitHub Copilot integration", "copilot_stop", null);
editor.registerCommand("Copilot: Sign In", "Sign in to GitHub Copilot", "copilot_sign_in", null);
editor.registerCommand("Copilot: Sign Out", "Sign out from GitHub Copilot", "copilot_sign_out", null);
editor.registerCommand("Copilot: Toggle", "Enable or disable Copilot completions", "copilot_toggle", null);
editor.registerCommand("Copilot: Status", "Show Copilot status", "copilot_status", null);
editor.registerCommand("Copilot: Accept Completion", "Accept the current Copilot suggestion", "copilot_accept", null);
editor.registerCommand("Copilot: Dismiss Completion", "Dismiss the current Copilot suggestion", "copilot_dismiss", null);
editor.registerCommand("Copilot: Open Chat", "Show the Copilot chat panel", "copilot_open_chat", null);
editor.registerCommand("Copilot: Close Chat", "Close the Copilot chat panel", "copilot_close_chat", null);
editor.registerCommand("Copilot: Ask", "Send a message to Copilot (opens chat if needed)", "copilot_ask", null);

(async () => {
  editor.debug("Copilot plugin loaded");

  const binary = findCopilotBinary();
  if (!binary) {
    editor.debug("Copilot: language server not found - auto-start skipped. Use 'Copilot: Start' manually.");
    return;
  }

  await startServer();
})();
