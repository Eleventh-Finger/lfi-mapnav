"use strict";

const extensionPlatform = globalThis.browser ?? globalThis.chrome;
const CONFIG_SCOPE_KEY = "navigationScopeV45";
const CONFIG_SETTINGS_KEY = "scopedFetcherSettingsV46";
const DATA_RESPONSES_KEY = "scopedFetchedResponsesV46";
const RUNTIME_SEQ_KEY = "scopedFetcherSequenceV46";
const NATIVE_HOST_NAME = "lfi_navigator_transport";
const LIMIT_MAX_BYTES = 2 * 1024 * 1024;
const LIMIT_MAX_ITEMS = 100;
const LIMIT_MAX_STORED_BYTES = 6 * 1024 * 1024;
const TRACKER_KEY = "browserTrackerStateV45";
const MAX_NAVIGATIONS = 2000;

let runtimeScope = null;
let networkActive = false;
let globalFetchSequence = 0;
let nativePort = null;
let nativeRequestSequence = 0;
const pendingNative = new Map();
let persistQueue = Promise.resolve();
let trackerQueue = Promise.resolve();

function processScopeUrl(inputUrl) {
  if (typeof inputUrl !== "string" || !inputUrl.trim()) return null;
  const value = inputUrl.trim();
  const match = value.match(/^(https?):\/\/([^/?#]*)([^?#]*)(?:\?([^#]*))?(?:#.*)?$/i);
  if (!match) return null;
  try {
    const parsed = new URL(`${match[1]}://${match[2]}/`);
    if (!/^https?:$/.test(parsed.protocol)) return null;

    let path = match[3] || "/";
    path = path.replace(/\/+/g, "/");
    if (!path.startsWith("/")) path = `/${path}`;

    // A root ending in an empty query value (for example, ?page=) is a
    // request template. Navigation belongs in that value, not after the
    // PHP endpoint's pathname.
    const hasQuery = value.split("#", 1)[0].includes("?");
    const queryPrefix = hasQuery ? (match[4] ?? "") : null;
    const queryTemplate = queryPrefix !== null && /(?:^|&)[^=&]+=$/.test(queryPrefix);
    if (queryTemplate) {
      path = path.replace(/\/+$/, "") || "/";
      const rawRoot = `${parsed.origin}${path}?${queryPrefix}`;
      return {
        rawRoot,
        origin: parsed.origin,
        scheme: parsed.protocol,
        domain: parsed.hostname.toLowerCase(),
        port: parsed.port || (parsed.protocol === "https:" ? "443" : "80"),
        basePath: path,
        queryPrefix,
        queryTemplate: true
      };
    }

    path = path === "/" ? "/" : `${path.replace(/\/+$/, "")}/`;
    return {
      rawRoot: `${parsed.origin}${path}`,
      origin: parsed.origin,
      scheme: parsed.protocol,
      domain: parsed.hostname.toLowerCase(),
      port: parsed.port || (parsed.protocol === "https:" ? "443" : "80"),
      basePath: path,
      queryPrefix: null,
      queryTemplate: false
    };
  } catch { return null; }
}

function checkUrlScope(targetUrl) {
  if (!runtimeScope || typeof targetUrl !== "string") return null;
  const match = targetUrl.match(/^(https?):\/\/([^/?#]*)([^?#]*)(?:\?([^#]*))?(?:#.*)?$/i);
  if (!match) return null;
  try {
    const authority = new URL(`${match[1]}://${match[2]}/`);
    if (authority.protocol !== runtimeScope.scheme) return null;
    if (authority.hostname.toLowerCase() !== runtimeScope.domain) return null;
    const port = authority.port || (authority.protocol === "https:" ? "443" : "80");
    if (port !== runtimeScope.port) return null;

    const rawPath = match[3] || "/";
    const requestTarget = rawPath.startsWith("/") ? rawPath : `/${rawPath}`;
    if (runtimeScope.queryTemplate) {
      const query = match[4];
      // Query-template scopes are limited to the configured endpoint and
      // the exact query prefix. They cannot be used to change host or path.
      if (requestTarget !== runtimeScope.basePath || typeof query !== "string" || !query.startsWith(runtimeScope.queryPrefix)) return null;
      const displayPath = query.slice(runtimeScope.queryPrefix.length) || "/";
      return { executableUrl: targetUrl, requestTarget: `${requestTarget}?${query}`, displayPath };
    }

    const scopeBase = runtimeScope.basePath === "/" ? "/" : runtimeScope.basePath.replace(/\/+$/, "");
    const inScope = scopeBase === "/" || requestTarget === scopeBase || requestTarget.startsWith(`${scopeBase}/`);
    if (!inScope) return null;
    let displayPath = scopeBase === "/" ? requestTarget : (requestTarget === scopeBase ? "/" : requestTarget.slice(scopeBase.length));
    if (!displayPath.startsWith("/")) displayPath = `/${displayPath}`;
    return { executableUrl: targetUrl, requestTarget, displayPath };
  } catch { return null; }
}

function translateVirtualTreeToUrl(nodes, punctuationToken, rawPath = null, rawBaseParts = null) {
  if (!runtimeScope || !Array.isArray(nodes) || typeof punctuationToken !== "string") return null;
  if (runtimeScope.queryTemplate) {
    const expression = typeof rawPath === "string" && rawPath.trim()
      ? rawPath.trim()
      : nodes.join(punctuationToken);
    if (/^(?:https?:)?\/\//i.test(expression) || /[?#]/.test(expression)) return null;
    return `${runtimeScope.origin}${runtimeScope.basePath}?${runtimeScope.queryPrefix}${expression}`;
  }

  const base = runtimeScope.basePath === "/" ? "" : runtimeScope.basePath.replace(/\/+$/, "");
  if (typeof rawPath === "string" && rawPath.trim()) {
    const expression = rawPath.trim();
    if (/^(?:https?:)?\/\//i.test(expression)) return null;
    const baseParts = Array.isArray(rawBaseParts) ? rawBaseParts : [];
    const current = pathFromParts(baseParts).replace(/\/+$/, "");
    const path = expression.startsWith("/")
      ? expression
      : current === "/" ? `/${expression}` : `${current}/${expression}`;
    // Keep this as a string so URL parsing cannot normalize dot segments.
    return `${runtimeScope.origin}${base}${path.startsWith("/") ? path : `/${path}`}`;
  }
  const joined = nodes.join(punctuationToken);
  const path = joined.startsWith("/") ? joined : `/${joined}`;
  return `${runtimeScope.origin}${base}${path}`;
}

function pathFromParts(parts) {
  if (!Array.isArray(parts) || !parts.length) return "/";
  return `/${parts.join("/")}/`;
}

function disconnectNative(reason = "Native transport disconnected.") {
  const port = nativePort;
  nativePort = null;
  for (const pending of pendingNative.values()) pending.reject(new Error(reason));
  pendingNative.clear();
  if (port) {
    try { port.disconnect(); } catch {}
  }
}

function ensureNativePort() {
  if (nativePort) return nativePort;
  if (!extensionPlatform.runtime?.connectNative) {
    throw new Error("Firefox Native Messaging API is unavailable.");
  }
  const port = extensionPlatform.runtime.connectNative(NATIVE_HOST_NAME);
  nativePort = port;
  port.onMessage.addListener(message => {
    const id = Number(message?.requestId);
    if (!id || !pendingNative.has(id)) return;
    const pending = pendingNative.get(id);
    pendingNative.delete(id);
    if (message?.ok === false) pending.reject(new Error(message.error || "Native transport failed."));
    else pending.resolve(message);
  });
  port.onDisconnect.addListener(() => {
    const error = extensionPlatform.runtime.lastError;
    disconnectNative(error?.message || "Native transport disconnected.");
  });
  return port;
}

function sendNativeRequest(payload) {
  return new Promise((resolve, reject) => {
    let port;
    try { port = ensureNativePort(); }
    catch (error) { reject(error); return; }
    const requestId = ++nativeRequestSequence;
    const timeoutMs = Math.max(1000, Math.min(30000, Number(payload.timeout || 10) * 1000 + 2000));
    const timer = setTimeout(() => {
      if (!pendingNative.has(requestId)) return;
      pendingNative.delete(requestId);
      reject(new Error("Native transport request timed out."));
    }, timeoutMs);
    pendingNative.set(requestId, {
      resolve: value => { clearTimeout(timer); resolve(value); },
      reject: error => { clearTimeout(timer); reject(error); }
    });
    try {
      port.postMessage({ ...payload, requestId });
    } catch (error) {
      pendingNative.delete(requestId);
      clearTimeout(timer);
      reject(error);
    }
  });
}

async function nativePing() {
  const response = await sendNativeRequest({ action: "ping" });
  return response?.ok === true && response?.type === "pong";
}

function persistRecord(record) {
  const operation = persistQueue.then(async () => {
    const data = await extensionPlatform.storage.local.get([DATA_RESPONSES_KEY, RUNTIME_SEQ_KEY]);
    globalFetchSequence = Number(data[RUNTIME_SEQ_KEY]) || globalFetchSequence;
    globalFetchSequence += 1;
    record.id = globalFetchSequence;
    const history = Array.isArray(data[DATA_RESPONSES_KEY]) ? data[DATA_RESPONSES_KEY] : [];
    history.push(record);
    while (history.length > LIMIT_MAX_ITEMS) history.shift();
    while (history.length > 1 && JSON.stringify(history).length > LIMIT_MAX_STORED_BYTES) history.shift();
    await extensionPlatform.storage.local.set({
      [RUNTIME_SEQ_KEY]: globalFetchSequence,
      [DATA_RESPONSES_KEY]: history
    });
    try { await extensionPlatform.runtime.sendMessage({ type: "fetchedResponseAvailable", record }); } catch {}
    return record;
  });
  persistQueue = operation.catch(() => {});
  return operation;
}

async function performNativeFetch(targetUrl, reason = "manual", requestOptions = {}) {
  if (!runtimeScope || !networkActive) return { ok: false, error: "Fetching scope is not enabled." };
  const check = checkUrlScope(targetUrl);
  if (!check) return { ok: false, error: "Target is outside the configured scope." };
  try {
    const method = String(requestOptions.method || "GET").toUpperCase();
    if (!["GET", "POST", "PUT"].includes(method)) return { ok: false, error: "Unsupported HTTP method." };
    const requestBody = method === "GET" ? "" : String(requestOptions.body ?? "");
    if (new TextEncoder().encode(requestBody).byteLength > 256 * 1024) return { ok: false, error: "Request body exceeds 256 KiB limit." };
    const contentType = String(requestOptions.contentType || "application/octet-stream");
    if (/[\r\n]/.test(contentType)) return { ok: false, error: "Invalid content type header." };
    const native = await sendNativeRequest({ action: "request", url: check.executableUrl, timeout: 10, method, body: requestBody, contentType });
    if (!native?.ok) return { ok: false, error: native?.error || "Native transport failed." };
    const body = typeof native.body === "string" ? native.body : "";
    if (new TextEncoder().encode(body).byteLength > LIMIT_MAX_BYTES) {
      return { ok: false, error: "Payload threshold cap breached." };
    }
    const record = await persistRecord({
      timestamp: Date.now(),
      url: check.executableUrl,
      path: check.displayPath,
      requestTarget: native.requestTarget || check.requestTarget,
      method,
      status: Number(native.status) || 0,
      statusText: native.statusText || "",
      contentType: native.contentType || "text/plain",
      body,
      truncated: Boolean(native.truncated),
      reason,
      transport: "python-native"
    });
    return { ok: true, record };
  } catch (error) {
    return { ok: false, error: error?.message || "Native transport request failed." };
  }
}


function emptyTracker() {
  return { version: 2, scopeRootUrl: runtimeScope?.rawRoot || "", activeTabId: null, activeUrl: null, activePath: "/", lastNavigationAt: 0, navigations: [] };
}
async function readTracker() {
  const result = await extensionPlatform.storage.local.get(TRACKER_KEY);
  const tracker = result[TRACKER_KEY];
  if (!tracker || typeof tracker !== "object") return emptyTracker();
  tracker.navigations = Array.isArray(tracker.navigations) ? tracker.navigations.slice(-MAX_NAVIGATIONS) : [];
  return tracker;
}
async function writeTracker(tracker) {
  tracker.scopeRootUrl = runtimeScope?.rawRoot || "";
  tracker.navigations = tracker.navigations.slice(-MAX_NAVIGATIONS);
  await extensionPlatform.storage.local.set({ [TRACKER_KEY]: tracker });
}
function recordBrowserNavigation(details, { forceFetch = false } = {}) {
  const operation = trackerQueue.then(async () => {
    if (!details || details.frameId !== 0 || !runtimeScope) return;
    const check = checkUrlScope(details.url);
    if (!check) return;
    const tracker = await readTracker();
    const timestamp = Date.now();
    tracker.activeTabId = details.tabId;
    tracker.activeUrl = details.url;
    tracker.activePath = check.displayPath;
    tracker.lastNavigationAt = timestamp;
    const last = tracker.navigations[tracker.navigations.length - 1];
    const requestChanged = !last || last.tabId !== details.tabId || last.fullPath !== check.requestTarget;
    if (!last || last.tabId !== details.tabId || last.url !== details.url || last.path !== check.displayPath) {
      tracker.navigations.push({ tabId: details.tabId, url: details.url, path: check.displayPath, fullPath: check.requestTarget, timestamp, event: "navigation", transitionType: details.transitionType || null });
    }
    await writeTracker(tracker);
    // URL fragments are client-side and are never sent in an HTTP request.
    // Avoid refetching the same request target for fragment/history events.
    if (networkActive && (forceFetch || requestChanged)) void performNativeFetch(details.url, "browser-navigation");
  });
  trackerQueue = operation.catch(() => {});
  return operation;
}
async function seedActiveBrowserTab({ forceFetch = false } = {}) {
  try {
    const tabs = await extensionPlatform.tabs.query({ active: true, currentWindow: true });
    const tab = tabs?.[0];
    if (tab?.url) await recordBrowserNavigation({ tabId: tab.id, frameId: 0, url: tab.url, transitionType: "active-tab" }, { forceFetch });
  } catch {}
}

const initialization = extensionPlatform.storage.local.get([
  CONFIG_SCOPE_KEY, CONFIG_SETTINGS_KEY, RUNTIME_SEQ_KEY
]).then(async result => {
  if (result[CONFIG_SCOPE_KEY]?.rootUrl) runtimeScope = processScopeUrl(result[CONFIG_SCOPE_KEY].rootUrl);
  networkActive = Boolean(result[CONFIG_SETTINGS_KEY]?.enabled && runtimeScope);
  globalFetchSequence = Number(result[RUNTIME_SEQ_KEY]) || 0;
  // Service workers/background scripts can start after the browser has already
  // navigated. Seed the active tab once the persisted scope is available.
  if (runtimeScope) await seedActiveBrowserTab();
}).catch(() => {});


extensionPlatform.storage.onChanged?.addListener((changes, areaName) => {
  if (areaName !== "local") return;
  if (changes[CONFIG_SCOPE_KEY]) {
    runtimeScope = processScopeUrl(changes[CONFIG_SCOPE_KEY].newValue?.rootUrl || "");
    if (!runtimeScope) {
      networkActive = false;
      disconnectNative("Fetching scope cleared.");
    }
  }
  if (changes[CONFIG_SETTINGS_KEY]) {
    networkActive = Boolean(changes[CONFIG_SETTINGS_KEY].newValue?.enabled && runtimeScope);
  }
});

if (extensionPlatform.webNavigation?.onCommitted) extensionPlatform.webNavigation.onCommitted.addListener(recordBrowserNavigation);
if (extensionPlatform.webNavigation?.onHistoryStateUpdated) extensionPlatform.webNavigation.onHistoryStateUpdated.addListener(recordBrowserNavigation);
if (extensionPlatform.webNavigation?.onReferenceFragmentUpdated) extensionPlatform.webNavigation.onReferenceFragmentUpdated.addListener(recordBrowserNavigation);
if (extensionPlatform.tabs?.onActivated) extensionPlatform.tabs.onActivated.addListener(() => void seedActiveBrowserTab({ forceFetch: true }));

extensionPlatform.runtime.onMessage.addListener((payload, sender, sendResponse) => {
  if (!payload || typeof payload.type !== "string") return undefined;

  if (payload.type === "getFetcherStatus") {
    initialization.then(() => sendResponse({
      enabled: Boolean(networkActive && runtimeScope),
      scopeRootUrl: runtimeScope?.rawRoot || "",
      transport: "python-native"
    }));
    return true;
  }

  if (payload.type === "getBrowserNavigation") {
    readTracker().then(sendResponse).catch(() => sendResponse(emptyTracker()));
    return true;
  }

  if (payload.type === "getCurrentPageUrl") {
    extensionPlatform.tabs.query({ active: true, currentWindow: true }).then(tabs => {
      const url = tabs?.[0]?.url || "";
      sendResponse(url ? { ok: true, url } : { ok: false, error: "No active page URL." });
    }).catch(error => sendResponse({ ok: false, error: error?.message || "Could not read active tab." }));
    return true;
  }

  if (payload.type === "setNavigationScope") {
    const scope = processScopeUrl(payload.rootUrl);
    if (!scope) { sendResponse({ ok: false, error: "Root configuration rejected." }); return true; }
    runtimeScope = scope;
    extensionPlatform.storage.local.set({ [CONFIG_SCOPE_KEY]: { rootUrl: scope.rawRoot }, [TRACKER_KEY]: emptyTracker() })
      .then(() => seedActiveBrowserTab()).then(() => sendResponse({ ok: true, rootUrl: scope.rawRoot }));
    return true;
  }

  if (payload.type === "clearNavigationScope") {
    runtimeScope = null;
    networkActive = false;
    disconnectNative("Fetching scope cleared.");
    Promise.all([
      extensionPlatform.storage.local.remove(CONFIG_SCOPE_KEY),
      extensionPlatform.storage.local.set({ [CONFIG_SETTINGS_KEY]: { enabled: false }, [TRACKER_KEY]: emptyTracker() })
    ]).then(() => sendResponse({ ok: true }));
    return true;
  }

  if (payload.type === "setFetcherEnabled") {
    initialization.then(async () => {
      if (!payload.enabled) {
        networkActive = false;
        disconnectNative("Native transport disabled.");
      } else {
        if (!runtimeScope) throw new Error("Set a website root first.");
        if (!(await nativePing())) throw new Error("Python native transport did not respond.");
        networkActive = true;
      }
      await extensionPlatform.storage.local.set({ [CONFIG_SETTINGS_KEY]: { enabled: networkActive } });
      if (networkActive) await seedActiveBrowserTab({ forceFetch: true });
      sendResponse({ ok: true, enabled: networkActive, transport: "python-native" });
    }).catch(error => sendResponse({ ok: false, enabled: false, error: error?.message || "Could not enable native transport." }));
    return true;
  }

  if (payload.type === "fetchVirtualPath") {
    initialization.then(() => {
      const url = translateVirtualTreeToUrl(payload.parts, payload.navigationToken, payload.rawPath, payload.rawBaseParts);
      return url ? performNativeFetch(url, "virtual-navigation", { method: payload.method, body: payload.body, contentType: payload.contentType }) : { ok: false, error: "Error building target URL." };
    }).then(sendResponse).catch(error => sendResponse({ ok: false, error: error?.message || "Request failed." }));
    return true;
  }

  if (payload.type === "fetchCurrentPage") {
    initialization.then(async () => {
      const tabs = await extensionPlatform.tabs.query({ active: true, currentWindow: true });
      const currentUrl = tabs?.[0]?.url || "";
      const check = checkUrlScope(currentUrl);
      if (!check) return { ok: false, error: "Current page is outside the configured scope." };
      return performNativeFetch(currentUrl, "current-page");
    }).then(sendResponse).catch(error => sendResponse({ ok: false, error: error?.message || "Request failed." }));
    return true;
  }

  if (payload.type === "getFetchedResponses") {
    extensionPlatform.storage.local.get(DATA_RESPONSES_KEY).then(result => {
      const afterId = Number(payload.afterId) || 0;
      const rows = Array.isArray(result[DATA_RESPONSES_KEY]) ? result[DATA_RESPONSES_KEY] : [];
      sendResponse(rows.filter(row => Number(row.id) > afterId));
    });
    return true;
  }

  if (payload.type === "clearFetcherResponses") {
    persistQueue.then(() => extensionPlatform.storage.local.set({ [DATA_RESPONSES_KEY]: [] }))
      .then(() => sendResponse({ ok: true }))
      .catch(error => sendResponse({ ok: false, error: error?.message || "Could not clear fetched responses." }));
    return true;
  }

  return undefined;
});
