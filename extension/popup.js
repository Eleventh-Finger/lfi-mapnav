/* LFI Navigator popup: navigation controls, response analysis, and saved map state. */
"use strict";

const MAX_DISCOVERIES = 500;
const MAX_HISTORY = 500;
const MAX_EVIDENCE = 100;
const STORAGE_KEY = "navigatorStateV47";

const extensionAPI = globalThis.browser ?? globalThis.chrome;

if (!extensionAPI?.storage?.local) {
  throw new Error("WebExtension storage API is unavailable.");
}

const $ = id => document.getElementById(id);

const fileTree = $("fileTree");
const currentPathElement = $("currentPath");
const backBtn = $("backBtn");
const forwardBtn = $("forwardBtn");
const navigationPathInput = $("navigationPathInput");
const requestMethodInput = $("requestMethodInput");
const requestBodyInput = $("requestBodyInput");
const requestContentTypeInput = $("requestContentTypeInput");
const navigateInputBtn = $("navigateInputBtn");
const requestState = $("requestState");
const requestedPath = $("requestedPath");
const cacheState = $("cacheState");
const requestMessage = $("requestMessage");
const tokenInput = $("tokenInput");
const responsePath = $("responsePath");
const responseInput = $("responseInput");
const ingestBtn = $("ingestBtn");
const clearResponseBtn = $("clearResponseBtn");
const parseStatus = $("parseStatus");
const fileCount = $("fileCount");
const directoryCount = $("directoryCount");
const potentialCount = $("potentialCount");
const discoveryCount = $("discoveryCount");
const memoryCurrentDirectory = $("memoryCurrentDirectory");
const lastDiscovery = $("lastDiscovery");
const latestDiscovery = $("latestDiscovery");
const discoveryHistory = $("discoveryHistory");
const expandAllBtn = $("expandAllBtn");
const collapseAllBtn = $("collapseAllBtn");
const exportBtn = $("exportBtn");
const importBtn = $("importBtn");
const fileImport = $("fileImport");
const clearMemoryBtn = $("clearMemoryBtn");
const scopeUrlInput = $("scopeUrlInput");
const useCurrentPageBtn = $("useCurrentPageBtn");
const setScopeBtn = $("setScopeBtn");
const clearScopeBtn = $("clearScopeBtn");
const scopeStatus = $("scopeStatus");
const enableFetcherBtn = $("enableFetcherBtn");
const disableFetcherBtn = $("disableFetcherBtn");
const fetchCurrentBtn = $("fetchCurrentBtn");

const state = {
  root: createDirectory("root"),
  currentPath: [],
  selectedPath: [],
  navigationToken: "/",
  navigationExpression: "/",
  navigationHistory: ["/"],
  historyIndex: 0,
  discoveries: [],
  requestQueue: [],
  requestInProgress: false,
  requestCounter: 0,
  lastDiscovery: null,
  browserLastSyncedAt: 0,
  navigationScopeRootUrl: "",
  scopedFetchEnabled: false,
  fetchedResponseLastId: 0
};

const responseCache = new Map();
let stateSaveQueue = Promise.resolve();

function now() { return Date.now(); }

async function getNavigationScope() {
  try {
    const result = await extensionAPI.storage.local.get("navigationScopeV45");
    return result["navigationScopeV45"]?.rootUrl || "";
  } catch { return ""; }
}

async function syncBrowserNavigation() {
  if (!extensionAPI?.runtime?.sendMessage) return;
  try {
    const tracker = await extensionAPI.runtime.sendMessage({ type: "getBrowserNavigation" });
    if (!tracker) return;
    const fresh = (Array.isArray(tracker.navigations) ? tracker.navigations : [])
      .filter(e => e && typeof e.timestamp === "number" && e.timestamp > state.browserLastSyncedAt)
      .sort((a,b) => a.timestamp - b.timestamp);
    for (const entry of fresh) {
      const pathValue = typeof entry.path === "string" ? entry.path : "/";
      const normalized = normalizeNavigationPath(pathValue);
      if (!normalized.length) { state.currentPath = []; state.selectedPath = []; continue; }
      mergeEntry(pathValue, `browser-navigation:${entry.url || pathValue}`, /\/$/.test(pathValue) ? "directory" : inferType(pathValue, false));
      recordNavigation(normalized);
      state.currentPath = [...normalized]; state.selectedPath = [...normalized];
    }
    const active = typeof tracker.activePath === "string" ? tracker.activePath : "/";
    const activeParts = normalizeNavigationPath(active);
    if (activeParts.length) { mergeEntry(active, `browser-active:${tracker.activeUrl || active}`, inferType(active, /\/$/.test(active))); state.currentPath=[...activeParts]; state.selectedPath=[...activeParts]; }
    if (fresh.length) state.browserLastSyncedAt = fresh[fresh.length - 1].timestamp;
    renderAll();
    await saveState();
  } catch (e) { console.debug("Browser navigation sync unavailable:", e); }
}

function setScopeStatus(message, type = "") {
  scopeStatus.textContent = message;
  scopeStatus.className = `scope-status ${type}`.trim();
}

async function applyNavigationScope() {
  const value = scopeUrlInput.value.trim();
  if (!value) { setScopeStatus("Enter a website root URL first.", "error"); return; }
  try {
    const result = await extensionAPI.runtime.sendMessage({ type: "setNavigationScope", rootUrl: value });
    if (!result?.ok) { setScopeStatus(result?.error || "Error setting scope.", "error"); return; }
    state.navigationScopeRootUrl = result.rootUrl;
    state.browserLastSyncedAt = 0;
    state.navigationHistory = ["/"];
    state.historyIndex = 0;
    state.currentPath = [];
    state.selectedPath = [];
    renderFetcherControls();
    await saveState();
    renderAll();
  } catch (error) { setScopeStatus("Error setting root.", "error"); }
}

async function clearNavigationScope() {
  try {
    await extensionAPI.runtime.sendMessage({ type: "clearNavigationScope" });
    state.navigationScopeRootUrl = "";
    state.currentPath = [];
    state.selectedPath = [];
    state.scopedFetchEnabled = false;
    scopeUrlInput.value = "";
    renderFetcherControls();
    await saveState();
    renderAll();
  } catch (error) { setScopeStatus("Error clearing root.", "error"); }
}


async function getScopedFetcherStatus() {
  try {
    const result = await extensionAPI.runtime.sendMessage({ type: "getFetcherStatus" });
    return Boolean(result?.enabled);
  } catch { return false; }
}

function renderFetcherControls() {
  const active = Boolean(state.navigationScopeRootUrl && state.scopedFetchEnabled);
  const hasScope = Boolean(state.navigationScopeRootUrl);
  enableFetcherBtn.hidden = active;
  disableFetcherBtn.hidden = !active;
  if (active) {
    setScopeStatus(`Scoped fetching enabled: ${state.navigationScopeRootUrl}`, "fetching");
  } else if (hasScope) {
    setScopeStatus(`Ready: ${state.navigationScopeRootUrl}`, "active");
  } else {
    setScopeStatus("No website root configured.");
  }
}

async function syncFetchedResponses() {
  if (!extensionAPI?.runtime?.sendMessage) return;
  try {
    const responses = await extensionAPI.runtime.sendMessage({
      type: "getFetchedResponses",
      afterId: state.fetchedResponseLastId
    });
    if (!Array.isArray(responses) || !responses.length) return;
    responses.forEach(record => {
      if (record && record.body) ingestResponse(record.path, record.body);
      state.fetchedResponseLastId = Math.max(state.fetchedResponseLastId, Number(record?.id) || 0);
    });
    await saveState();
    renderAll();
  } catch (e) { console.debug(e); }
}

async function enableScopedFetcher() {
  const rootUrl = state.navigationScopeRootUrl;
  if (!rootUrl) return;
  try {
    // The HTTP request is made by the Python Native Messaging transport, not
    // by extension fetch/XHR. Host permissions are therefore not required.
    // The background script enforces the configured URL scope before every
    // native request. This also avoids Firefox manifest/permission prompts.
    const result = await extensionAPI.runtime.sendMessage({ type: "setFetcherEnabled", enabled: true });
    if (!result?.ok) {
      state.scopedFetchEnabled = false;
      setScopeStatus(result?.error || "Python native transport could not be started.", "error");
      renderFetcherControls();
      return;
    }
    state.scopedFetchEnabled = Boolean(result.enabled);
    renderFetcherControls();
    await syncFetchedResponses();
    await saveState();
  } catch (e) {
    setScopeStatus(e?.message || "Python native transport could not be started.", "error");
  }
}

async function disableScopedFetcher() {
  try {
    const result = await extensionAPI.runtime.sendMessage({ type: "setFetcherEnabled", enabled: false });
    state.scopedFetchEnabled = Boolean(result?.enabled);
    renderFetcherControls();
    await saveState();
  } catch (e) { console.debug(e); }
}

function createDirectory(name) {
  return {
    name, type: "directory", children: {}, expanded: true,
    firstSeen: now(), lastSeen: now(), discoveryCount: 0, evidence: []
  };
}
function createFile(name) {
  return {
    name, type: "file", firstSeen: now(), lastSeen: now(),
    discoveryCount: 0, newlyDiscovered: true, evidence: []
  };
}
function createPotential(name) {
  return {
    name, type: "potential", firstSeen: now(), lastSeen: now(),
    discoveryCount: 0, newlyDiscovered: true, evidence: []
  };
}

function pathToString(path) {
  return Array.isArray(path) && path.length ? "/" + path.join("/") : "/";
}

function cleanPath(value) {
  if (value === null || value === undefined) return "";
  let result = String(value).trim();
  result = result.replace(/^[ (\"'`<\[]+/, "").replace(/[)\"'`>,;\]}]+$/, "");
  result = result.replace(/\\/g, "/");
  result = result.split("?")[0].split("#")[0];
  result = result.replace(/^https?:\/\/[^/]+/i, "").replace(/^file:\/\//i, "");
  result = result.replace(/\/+/g, "/");
  return result.trim();
}

function parsePath(value) {
  const cleaned = cleanPath(value);
  if (!cleaned || /^(javascript:|mailto:|data:|tel:)/i.test(cleaned)) return null;
  const directoryHint = /\/$/.test(cleaned);
  const absolute = cleaned.startsWith("/");
  const parts = cleaned.split("/").filter(Boolean);
  return { parts, directoryHint, absolute };
}

// Memory parsing deliberately does NOT resolve '..' by popping a parent.
function resolvePath(value, baseParts = []) {
  const parsed = parsePath(value);
  if (!parsed) return null;
  const output = parsed.absolute ? [] : [...baseParts];
  for (const part of parsed.parts) {
    if (!part || part === ".") continue;
    output.push(part);
  }
  return { parts: output, path: pathToString(output), directoryHint: parsed.directoryHint };
}
function normalizePath(value) { return resolvePath(value, []); }
function normalizeNavigationSyntax(value) {
  if (typeof value !== "string") return null;
  const token = value.trim();
  if (!token || token.length > 128) return null;
  if (/[\u0000-\u001F\u007F?#\\]/.test(token)) return null;
  return token;
}
function normalizeNavigationPath(value) {
  if (Array.isArray(value)) return value.filter(part => typeof part === "string" && part.length > 0);
  const normalized = normalizePath(value);
  return normalized ? normalized.parts : [];
}
function inferType(path, directoryHint = false) {
  if (directoryHint || String(path).includes("..") || String(path).endsWith("/")) return "directory";
  const name = String(path).split("/").pop().toLowerCase();
  if (/\.(php|php[0-9]|asp|aspx|jsp|jspx|html?|css|js|json|xml|txt|log|conf|cfg|ini|env|yaml|yml|md|csv|sql|db|sqlite|bak|old|zip|tar|gz|jpg|jpeg|png|gif|svg|ico|pdf|docx?|xlsx?|sh|py|rb|pl|cgi|exe|dll)$/.test(name)) return "file";
  if (/^(passwd|hosts|shadow|fstab|resolv\.conf|environment|authorized_keys)$/.test(name)) return "file";
  if (/^(etc|var|tmp|home|root|usr|bin|sbin|opt|dev|proc|sys|srv|www|html|public|public_html|uploads?|images?|css|js|logs?|config)$/.test(name)) return "directory";
  return "potential";
}
function getNode(path) {
  if (!Array.isArray(path)) return null;
  let node = state.root;
  for (const part of path) {
    if (!node.children || !node.children[part]) return null;
    node = node.children[part];
  }
  return node;
}
function ensureDirectory(parts) {
  let current = state.root;
  for (const part of parts) {
    if (!part) continue;
    if (!current.children[part]) current.children[part] = createDirectory(part);
    if (current.children[part].type !== "directory") {
      current.children[part] = { ...createDirectory(part), ...current.children[part], type: "directory", children: current.children[part].children || {} };
    }
    current = current.children[part];
  }
  return current;
}
function mergeEntry(rawPath, source, forcedType = null, basePath = []) {
  const normalized = resolvePath(rawPath, basePath);
  if (!normalized || !normalized.parts.length) return null;
  const parts = normalized.parts;
  const parent = ensureDirectory(parts.slice(0, -1));
  const name = parts[parts.length - 1];
  const inferred = forcedType || inferType(normalized.path, normalized.directoryHint);
  let node = parent.children[name];
  let created = false;
  if (!node) {
    node = inferred === "directory" ? createDirectory(name) : inferred === "file" ? createFile(name) : createPotential(name);
    parent.children[name] = node;
    created = true;
  }
  if (inferred === "directory" && node.type !== "directory") {
    node.type = "directory"; node.children = node.children || {}; node.expanded = true;
  }
  if (inferred === "file" && node.type === "potential") node.type = "file";
  node.lastSeen = now();
  node.discoveryCount = (node.discoveryCount || 0) + 1;
  node.newlyDiscovered = true;
  node.evidence = Array.isArray(node.evidence) ? node.evidence : [];
  node.evidence.push({ source: String(source || "unknown"), timestamp: now(), type: node.type });
  if (node.evidence.length > MAX_EVIDENCE) node.evidence = node.evidence.slice(-MAX_EVIDENCE);
  return { path: normalized.path, type: node.type, created };
}

function extractCandidates(text) {
  const candidates = [];
  if (!text) return candidates;
  const absolute = /(?:^|[\s"'(\[])(\/[A-Za-z0-9._~+\-@%/\\]+)(?=$|[\s"'()>,;\]])/gm;
  const relative = /(?:^|[\s"'(\[])(\.{1,2}\/[A-Za-z0-9._~+\-@%/\\]+)(?=$|[\s"'()>,;\]])/gm;
  const html = /(?:href|src|action)\s*=\s*["']([^"']+)["']/gi;
  const directories = /(?:^|\n)\s*([A-Za-z0-9._~+\-@%]+(?:\/[A-Za-z0-9._~+\-@%]+)*\/)\s*(?:\r?$)/gm;
  const json = /["'](?:path|file|filename|filepath|directory|dirname|name)["']\s*:\s*["']([^"']+)["']/gi;
  for (const match of text.matchAll(absolute)) candidates.push({ value: match[1], source: "absolute-path" });
  for (const match of text.matchAll(relative)) candidates.push({ value: match[1], source: "relative-path" });
  for (const match of text.matchAll(html)) candidates.push({ value: match[1], source: "html-attribute" });
  for (const match of text.matchAll(directories)) candidates.push({ value: match[1], source: "directory-listing" });
  for (const match of text.matchAll(json)) candidates.push({ value: match[1], source: "json-field" });
  return deduplicateCandidates(candidates);
}
function deduplicateCandidates(candidates) {
  const map = new Map();
  for (const candidate of candidates) {
    const parsed = parsePath(candidate.value);
    if (!parsed) continue;
    const key = candidate.value.trim().toLowerCase();
    const existing = map.get(key);
    if (!existing) map.set(key, { value: candidate.value, source: candidate.source, directoryHint: parsed.directoryHint });
    else { existing.directoryHint = existing.directoryHint || parsed.directoryHint; if (candidate.source === "directory-listing") existing.source = candidate.source; }
  }
  return [...map.values()];
}
function getResponseBasePath(path) {
  if (!path) return [];
  const normalized = normalizePath(path);
  if (!normalized) return [];
  return normalized.directoryHint ? normalized.parts : normalized.parts.slice(0, -1);
}
function ingestResponse(path, body) {
  if (!body || !String(body).trim()) {
    showStatus("No response data supplied.", "error");
    return;
  }
  const candidates = extractCandidates(body);
  const discoveries = [];
  const normalizedResponse = path ? normalizePath(path) : null;
  if (normalizedResponse && normalizedResponse.parts.length) {
    const result = mergeEntry(normalizedResponse.path, "response-path", inferType(normalizedResponse.path, normalizedResponse.directoryHint));
    if (result) discoveries.push(result);
  }
  const basePath = getResponseBasePath(path);
  for (const candidate of candidates) {
    const result = mergeEntry(candidate.value, candidate.source, null, basePath);
    if (result) discoveries.push(result);
  }
  const record = { timestamp: now(), path: path || "/", candidateCount: candidates.length, discoveries };
  state.discoveries.push(record);
  if (state.discoveries.length > MAX_DISCOVERIES) state.discoveries = state.discoveries.slice(-MAX_DISCOVERIES);
  state.lastDiscovery = record.timestamp;
  markCached(path || "/");
  renderAll();
  void saveState();
  showStatus(`Ingested ${candidates.length} candidate(s) and merged them into memory.`, "success");
}
function cacheKey(path) { return pathToString(normalizeNavigationPath(path)); }
function hasCachedResponse(path) { return responseCache.has(cacheKey(path)); }
function markCached(path) { responseCache.set(cacheKey(path), { timestamp: now() }); }
function clearCache() { responseCache.clear(); }
function samePath(a, b) { return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i]); }

function setCurrentPath(path, { record = true, select = true } = {}) {
  const next = Array.isArray(path) ? path.filter(part => typeof part === "string" && part.length > 0) : [];
  state.currentPath = [...next];
  if (select) state.selectedPath = [...next];
  if (record) recordNavigation(next);
  const node = getNode(next);
  if (node && node.type === "directory") node.expanded = true;
  renderAll();
  void saveState();
}
function recordNavigation(path) {
  const value = pathToString(path);
  if (state.navigationHistory[state.historyIndex] === value) return;
  state.navigationHistory = state.navigationHistory.slice(0, state.historyIndex + 1);
  state.navigationHistory.push(value);
  if (state.navigationHistory.length > MAX_HISTORY) state.navigationHistory = state.navigationHistory.slice(-MAX_HISTORY);
  state.historyIndex = state.navigationHistory.length - 1;
}
function navigateHistory(delta) {
  const next = state.historyIndex + delta;
  if (next < 0 || next >= state.navigationHistory.length) return false;
  state.historyIndex = next;
  const parsed = normalizeNavigationPath(state.navigationHistory[next]);
  setCurrentPath(parsed, { record: false, select: true });
  return true;
}
function navigateBack() {
  if (navigateHistory(-1)) return;
  if (state.currentPath.length) setCurrentPath(state.currentPath.slice(0, -1));
}
function splitNavigationExpression(raw) {
  const value = String(raw ?? "").trim();
  if (!value || /^(?:https?:)?\/\//i.test(value)) return null;
  const absolute = value.startsWith("/");
  const parts = value.split("/").filter(Boolean);
  return absolute ? parts : [...state.currentPath, ...parts];
}
function navigateToExpression(raw) {
  const expression = String(raw ?? "").trim();
  const baseParts = [...state.currentPath];
  const nextParts = splitNavigationExpression(expression);
  if (!nextParts) {
    requestMessage.textContent = "Enter a relative or absolute path expression.";
    return;
  }
  state.navigationExpression = expression;
  navigationPathInput.value = expression || "/";
  // Put the traversed expression into the map so the tree follows navigation as well as discoveries.
  if (nextParts.length) ensureDirectory(nextParts);
  setCurrentPath(nextParts);
  enqueueNavigationRequest(nextParts, "literal-navigation", expression || "/", baseParts);
}
function navigateForward() { navigateToExpression(navigationPathInput.value); }

function enqueueNavigationRequest(parts, reason, rawPath = null, rawBaseParts = null) {
state.requestCounter++;
const req = { id: state.requestCounter, path: rawPath ?? pathToString(parts), parts, rawPath, rawBaseParts, reason, state: "queued" };
requestedPath.textContent = req.path;
requestState.textContent = "LOADING";
extensionAPI.runtime.sendMessage({
type: "fetchVirtualPath",
parts: req.parts,
navigationToken: state.navigationToken,
rawPath: req.rawPath,
rawBaseParts: req.rawBaseParts,
method: requestMethodInput.value,
body: requestMethodInput.value === "GET" ? "" : requestBodyInput.value,
contentType: requestContentTypeInput.value.trim() || "application/octet-stream"
}).then(res => {
if (res && res.ok) {
requestState.textContent = "RECEIVED";
if (res.record) ingestResponse(res.record.path, res.record.body);
} else {
requestState.textContent = "FAILED";
requestMessage.textContent = res?.error || "Native transport failed.";
}
}).catch(error => {
requestState.textContent = "FAILED";
requestMessage.textContent = error?.message || "Native transport connection failed.";
});
}
function renderTree() {
  fileTree.innerHTML = "";
  const nodes = Object.values(state.root.children || {}).sort(sortNodes);
  if (!nodes.length) {
    fileTree.innerHTML = `<div class="empty">No filesystem data has been discovered.</div>`;
    return;
  }
  for (const node of nodes) fileTree.appendChild(renderNode(node, []));
}
function renderNode(node, parentPath) {
  const container = document.createElement("div");
  container.className = "tree-node";
  const path = [...parentPath, node.name];
  const row = document.createElement("div");
  row.className = "node-row";
  if (samePath(path, state.selectedPath)) row.classList.add("selected");
  const arrow = document.createElement("span"); arrow.className = "node-arrow";
  const icon = document.createElement("span"); icon.className = "node-icon";
  const name = document.createElement("span"); name.className = "node-name"; name.textContent = node.name;
  const meta = document.createElement("span"); meta.className = "node-meta";
  if (node.type === "directory") {
    arrow.textContent = node.expanded ? "▼" : "▶"; icon.textContent = "📁"; name.classList.add("node-directory");
    meta.textContent = `${Object.keys(node.children || {}).length} item(s)`;
    row.addEventListener("click", e => { e.stopPropagation(); state.selectedPath = [...path]; renderTree(); updateRequestControls(); void saveState(); });
    row.addEventListener("dblclick", e => { e.stopPropagation(); setCurrentPath(path); });
    arrow.addEventListener("click", e => { e.stopPropagation(); node.expanded = !node.expanded; state.selectedPath = [...path]; renderTree(); updateRequestControls(); void saveState(); });
  } else if (node.type === "file") {
    icon.textContent = "📄"; name.classList.add("node-file"); meta.textContent = "FILE";
    row.addEventListener("click", () => { state.selectedPath = [...path]; renderTree(); updateRequestControls(); void saveState(); });
  } else {
    icon.textContent = "❓"; name.classList.add("node-potential"); meta.textContent = "POTENTIAL";
    row.addEventListener("click", () => { state.selectedPath = [...path]; renderTree(); updateRequestControls(); void saveState(); });
  }
  row.append(arrow, icon, name, meta); container.appendChild(row);
  if (node.type === "directory" && node.expanded) {
    const children = document.createElement("div"); children.className = "children";
    for (const child of Object.values(node.children || {}).sort(sortNodes)) children.appendChild(renderNode(child, path));
    container.appendChild(children);
  }
  return container;
}
function sortNodes(a, b) { const order = { directory: 0, potential: 1, file: 2 }; return (order[a.type] - order[b.type]) || a.name.localeCompare(b.name); }
function setExpanded(node, expanded) { if (!node || node.type !== "directory") return; node.expanded = expanded; Object.values(node.children || {}).forEach(child => setExpanded(child, expanded)); }
function calculateStats() {
  let files = 0, directories = 0, potential = 0;
  function walk(node) { if (!node) return; if (node.type === "file") files++; else if (node.type === "directory") { directories++; Object.values(node.children || {}).forEach(walk); } else potential++; }
  Object.values(state.root.children || {}).forEach(walk);
  return { files, directories, potential, discoveries: state.discoveries.length };
}
function renderMemory() {
  const stats = calculateStats();
  fileCount.textContent = stats.files; directoryCount.textContent = stats.directories; potentialCount.textContent = stats.potential; discoveryCount.textContent = stats.discoveries;
  memoryCurrentDirectory.textContent = pathToString(state.currentPath); currentPathElement.textContent = pathToString(state.currentPath);
  lastDiscovery.textContent = state.lastDiscovery ? new Date(state.lastDiscovery).toLocaleString() : "Never";
  backBtn.disabled = state.historyIndex <= 0 && state.currentPath.length === 0;
  forwardBtn.disabled = false;
}
function renderLatestDiscovery() {
  latestDiscovery.innerHTML = "";
  const record = state.discoveries[state.discoveries.length - 1];
  if (!record) { latestDiscovery.textContent = "Nothing analyzed yet."; return; }
  const summary = document.createElement("div"); summary.textContent = `Path: ${record.path} | Candidates: ${record.candidateCount}`; latestDiscovery.appendChild(summary);
  const list = document.createElement("ul");
  for (const item of (record.discoveries || []).slice(0, 100)) { const li = document.createElement("li"); li.textContent = `${item.path} [${item.type}]`; list.appendChild(li); }
  latestDiscovery.appendChild(list);
}
function renderHistory() {
  discoveryHistory.innerHTML = "";
  if (!state.discoveries.length) { discoveryHistory.innerHTML = `<div class="empty">No history yet.</div>`; return; }
  for (const record of [...state.discoveries].reverse().slice(0, 100)) {
    const row = document.createElement("div"); row.className = "history-entry";
    const path = document.createElement("div"); path.className = "history-path"; path.textContent = record.path;
    const time = document.createElement("div"); time.className = "history-time"; time.textContent = new Date(record.timestamp).toLocaleString();
    row.append(path, time); discoveryHistory.appendChild(row);
  }
}
function updateRequestControls() {
  forwardBtn.title = "Navigate to the path expression in the box below";
}
function renderAll() { renderTree(); renderMemory(); renderLatestDiscovery(); renderHistory(); updateRequestControls(); }

function showStatus(m, type = "") {
parseStatus.textContent = m;
parseStatus.className = `status ${type}`;
}
function saveState() {
  const snapshot = {
    version: 5.1,
    root: state.root, currentPath: state.currentPath, selectedPath: state.selectedPath,
    navigationToken: state.navigationToken, navigationExpression: state.navigationExpression,
    navigationHistory: state.navigationHistory, historyIndex: state.historyIndex,
    discoveries: state.discoveries, lastDiscovery: state.lastDiscovery,
    browserLastSyncedAt: state.browserLastSyncedAt,
    navigationScopeRootUrl: state.navigationScopeRootUrl,
    scopedFetchEnabled: state.scopedFetchEnabled, fetchedResponseLastId: state.fetchedResponseLastId
  };
  const operation = stateSaveQueue.then(() => extensionAPI.storage.local.set({ [STORAGE_KEY]: snapshot }));
  stateSaveQueue = operation.catch(error => console.error("Unable to save state:", error));
  return operation;
}
function sanitizeMemoryNode(node, fallbackName = "root", depth = 0) {
  if (!node || typeof node !== "object" || depth > 200) return createDirectory(fallbackName);
  const name = typeof node.name === "string" && node.name.length <= 255 ? node.name : fallbackName;
  const type = node.type === "file" || node.type === "potential" || node.type === "directory" ? node.type : "directory";
  const base = type === "file" ? createFile(name) : type === "potential" ? createPotential(name) : createDirectory(name);
  base.firstSeen = Number.isFinite(node.firstSeen) ? node.firstSeen : base.firstSeen;
  base.lastSeen = Number.isFinite(node.lastSeen) ? node.lastSeen : base.lastSeen;
  base.discoveryCount = Number.isFinite(node.discoveryCount) && node.discoveryCount >= 0 ? Math.min(node.discoveryCount, 1000000) : 0;
  base.newlyDiscovered = Boolean(node.newlyDiscovered);
  base.evidence = Array.isArray(node.evidence) ? node.evidence.slice(-MAX_EVIDENCE).filter(item => item && typeof item === "object").map(item => ({
    source: String(item.source || "unknown").slice(0, 1000),
    timestamp: Number.isFinite(item.timestamp) ? item.timestamp : base.lastSeen,
    type: item.type === "directory" || item.type === "file" || item.type === "potential" ? item.type : base.type
  })) : [];
  if (type === "directory") {
    base.expanded = node.expanded !== false;
    const children = node.children && typeof node.children === "object" ? node.children : {};
    for (const [key, child] of Object.entries(children)) {
      if (!key || key.length > 255) continue;
      base.children[key] = sanitizeMemoryNode(child, key, depth + 1);
    }
  }
  return base;
}
function sanitizeMemoryRoot(root) {
  const safe = sanitizeMemoryNode(root, "root");
  safe.type = "directory";
  safe.name = "root";
  return safe;
}

async function loadState() {
  try {
    const result = await extensionAPI.storage.local.get(STORAGE_KEY);
    const saved = result[STORAGE_KEY];
    if (saved?.root?.children) state.root = sanitizeMemoryRoot(saved.root);
    state.currentPath = Array.isArray(saved?.currentPath) ? saved.currentPath.filter(part => typeof part === "string" && part.length > 0 && part.length <= 255).slice(-200) : [];
    state.selectedPath = Array.isArray(saved?.selectedPath) ? saved.selectedPath.filter(part => typeof part === "string" && part.length > 0 && part.length <= 255).slice(-200) : [...state.currentPath];
    state.navigationToken = typeof saved?.navigationToken === "string" ? (normalizeNavigationSyntax(saved.navigationToken) || "/") : "/";
    state.navigationExpression = typeof saved?.navigationExpression === "string" ? saved.navigationExpression : "/";
    state.navigationHistory = Array.isArray(saved?.navigationHistory) && saved.navigationHistory.length ? saved.navigationHistory.filter(item => typeof item === "string" && item.length <= 4096).slice(-MAX_HISTORY) : ["/"];
    state.historyIndex = Number.isInteger(saved?.historyIndex) ? Math.min(Math.max(saved.historyIndex, 0), state.navigationHistory.length - 1) : state.navigationHistory.length - 1;
    state.discoveries = Array.isArray(saved?.discoveries) ? saved.discoveries.filter(item => item && typeof item === "object").slice(-MAX_DISCOVERIES) : [];
    state.lastDiscovery = saved?.lastDiscovery || null;
    state.browserLastSyncedAt = Number(saved?.browserLastSyncedAt) || 0;
    state.navigationScopeRootUrl = typeof saved?.navigationScopeRootUrl === "string" ? saved.navigationScopeRootUrl : await getNavigationScope();
    state.scopedFetchEnabled = await getScopedFetcherStatus();
    state.fetchedResponseLastId = Number.isInteger(saved?.fetchedResponseLastId) ? saved.fetchedResponseLastId : 0;
    tokenInput.value = state.navigationToken; scopeUrlInput.value = state.navigationScopeRootUrl; navigationPathInput.value = state.navigationExpression || "/";
    renderFetcherControls(); renderAll(); await syncFetchedResponses(); await syncBrowserNavigation();
  } catch (e) { console.error("Unable to load state:", e); renderAll(); }
}

async function useCurrentPage() {
  try {
    const result = await extensionAPI.runtime.sendMessage({ type: "getCurrentPageUrl" });
    if (!result?.ok || !result.url) {
      setScopeStatus("Could not read the current page URL.", "error");
      return;
    }
    scopeUrlInput.value = result.url;
  } catch (error) {
    setScopeStatus(error?.message || "Could not read the current page URL.", "error");
  }
}

async function fetchCurrentPage() {
  try {
    const result = await extensionAPI.runtime.sendMessage({ type: "fetchCurrentPage" });
    if (result?.ok) {
      requestState.textContent = "RECEIVED";
      requestMessage.textContent = result.record?.url || "Current page fetched.";
      if (result.record?.body) ingestResponse(result.record.path, result.record.body);
    } else {
      requestState.textContent = "FAILED";
      requestMessage.textContent = result?.error || "Current page fetch failed.";
    }
  } catch (error) {
    requestState.textContent = "FAILED";
    requestMessage.textContent = error?.message || "Current page fetch failed.";
  }
}

function exportMemory() {
  const payload = {
    version: 1,
    exportedAt: new Date().toISOString(),
    state: {
      root: state.root,
      currentPath: state.currentPath,
      selectedPath: state.selectedPath,
      navigationToken: state.navigationToken,
      navigationHistory: state.navigationHistory,
      historyIndex: state.historyIndex,
      navigationScopeRootUrl: state.navigationScopeRootUrl
    }
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "lfi-navigator-memory.json";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function importMemory() {
  fileImport.click();
}

async function handleMemoryImport(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    const parsed = JSON.parse(await file.text());
    const imported = parsed.state || parsed;
    if (!imported || typeof imported !== "object" || !imported.root) {
      throw new Error("Invalid memory export.");
    }
    if (!imported.root || typeof imported.root !== "object") throw new Error("Invalid memory root.");
    state.root = sanitizeMemoryRoot(imported.root);
    state.currentPath = Array.isArray(imported.currentPath) ? imported.currentPath.filter(part => typeof part === "string" && part.length > 0 && part.length <= 255).slice(-200) : [];
    state.selectedPath = Array.isArray(imported.selectedPath) ? imported.selectedPath.filter(part => typeof part === "string" && part.length > 0 && part.length <= 255).slice(-200) : [];
    state.navigationToken = typeof imported.navigationToken === "string" ? (normalizeNavigationSyntax(imported.navigationToken) || "/") : "/";
    state.navigationExpression = typeof imported.navigationExpression === "string" && !/[\u0000-\u001F\u007F]/.test(imported.navigationExpression)
      ? imported.navigationExpression.trim().slice(0, 4096) || "/"
      : "/";
    state.navigationHistory = Array.isArray(imported.navigationHistory) && imported.navigationHistory.length
      ? imported.navigationHistory.filter(item => typeof item === "string" && item.length <= 4096 && !/[\u0000-\u001F\u007F]/.test(item)).slice(-MAX_HISTORY)
      : ["/"];
    state.historyIndex = Number.isInteger(imported.historyIndex)
      ? Math.min(Math.max(imported.historyIndex, 0), state.navigationHistory.length - 1)
      : state.navigationHistory.length - 1;
    state.navigationScopeRootUrl = typeof imported.navigationScopeRootUrl === "string" ? imported.navigationScopeRootUrl : "";
    tokenInput.value = state.navigationToken;
    scopeUrlInput.value = state.navigationScopeRootUrl;
    navigationPathInput.value = state.navigationExpression;
    await saveState();
    renderAll();
    showStatus("Memory imported successfully.", "success");
  } catch (error) {
    showStatus(error?.message || "Memory import failed.", "error");
  } finally {
    fileImport.value = "";
  }
}

function clearResponse() {
  responsePath.value = "";
  responseInput.value = "";
  showStatus("", "");
}

function setTreeExpanded(expanded) {
  function walk(node) {
    if (node.type === "directory") {
      node.expanded = expanded;
      Object.values(node.children || {}).forEach(walk);
    }
  }
  walk(state.root);
  renderAll();
  saveState();
}

extensionAPI.runtime?.onMessage?.addListener(message => {
  if (message?.type !== "fetchedResponseAvailable") return;
  const record = message.record;
  if (!record || !record.body) return;
  if (Number(record.id) <= state.fetchedResponseLastId) return;
  ingestResponse(record.path || "/", record.body);
  state.fetchedResponseLastId = Math.max(state.fetchedResponseLastId, Number(record.id) || 0);
  void saveState();
});

useCurrentPageBtn.addEventListener("click", useCurrentPage);
fetchCurrentBtn.addEventListener("click", fetchCurrentPage);
exportBtn.addEventListener("click", exportMemory);
importBtn.addEventListener("click", importMemory);
fileImport.addEventListener("change", handleMemoryImport);
clearResponseBtn.addEventListener("click", clearResponse);
expandAllBtn.addEventListener("click", () => setTreeExpanded(true));
collapseAllBtn.addEventListener("click", () => setTreeExpanded(false));

backBtn.addEventListener("click", navigateBack);
forwardBtn.addEventListener("click", navigateForward);
navigateInputBtn.addEventListener("click", () => navigateToExpression(navigationPathInput.value));
navigationPathInput.addEventListener("keydown", event => { if (event.key === "Enter") navigateToExpression(navigationPathInput.value); });
setScopeBtn.addEventListener("click", applyNavigationScope);
clearScopeBtn.addEventListener("click", clearNavigationScope);
enableFetcherBtn.addEventListener("click", enableScopedFetcher);
disableFetcherBtn.addEventListener("click", disableScopedFetcher);
ingestBtn.addEventListener("click", () => {
ingestResponse(responsePath.value.trim(), responseInput.value);
});
clearMemoryBtn.addEventListener("click", () => {
  if (!confirm("Clear all remembered filesystem and discovery data?")) return;
  state.root = createDirectory("root");
  state.currentPath = [];
  state.selectedPath = [];
  state.navigationToken = "/";
  state.navigationExpression = "/";
  state.navigationHistory = ["/"];
  state.historyIndex = 0;
  state.discoveries = [];
  state.lastDiscovery = null;
  state.requestQueue = [];
  state.requestInProgress = false;
  state.requestCounter = 0;
  state.fetchedResponseLastId = 0;
  state.browserLastSyncedAt = 0;
  navigationPathInput.value = "/";
  tokenInput.value = "/";
  void extensionAPI.runtime.sendMessage({ type: "clearFetcherResponses" });
  clearCache();
  renderAll();
  void saveState();
  showStatus("Memory cleared.", "success");
});
void loadState();

