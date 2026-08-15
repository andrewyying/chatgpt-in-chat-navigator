/**
 * ChatGPT Navigator — sidebar, prompt index and answer folding.
 *
 * This file owns the extension's UI and state. It deliberately knows nothing
 * about ChatGPT's markup: every question about the page ("where are the
 * turns?", "who wrote this one?", "which part folds?") goes through CGXDom in
 * src/chatgpt-dom.js, and prompt ordering goes through CGXOrder in
 * src/turn-order.js.
 */
(() => {
  const EXT_NS = "cgx";
  const SIDEBAR_ID = "cgx-sidebar";
  const STORAGE_KEY_PREFIX = "cgx_state_v1";
  const PREFS_KEY = "cgx_prefs_v1";
  const TITLE_CACHE_VERSION = "2";
  const DEBOUNCE_MS = 250;
  // A streaming answer mutates the DOM continuously, which resets a plain
  // debounce forever. Cap the total wait so the sidebar still updates mid-answer.
  const MAX_SCAN_DELAY_MS = 800;
  const SEARCH_INPUT_DEBOUNCE_MS = 140;
  const IDLE_TIMEOUT_MS = 300;
  // ChatGPT navigates from the page's own world. A content script runs in an
  // isolated world, so the history.pushState wrapper installed below never
  // sees those calls — reading location.pathname is the only reliable signal.
  // It is a string compare, so polling it often costs nothing.
  const ROUTE_POLL_MS = 150;
  // If a click looked like navigation but the URL never moved, put the list back.
  const NAV_INTENT_TIMEOUT_MS = 1500;
  const INIT_DELAY_MS = 200;
  // How long after a conversation switch we keep ignoring turns belonging to
  // the conversation we just left.
  const STALE_GUARD_MS = 4000;
  const FILE_NAME_EXTENSIONS = new Set([
    "pdf",
    "doc",
    "docx",
    "txt",
    "md",
    "rtf",
    "csv",
    "tsv",
    "xls",
    "xlsx",
    "ppt",
    "pptx",
    "json",
    "xml",
    "yaml",
    "yml",
    "zip",
    "rar",
    "7z",
    "tar",
    "gz",
    "png",
    "jpg",
    "jpeg",
    "gif",
    "webp",
    "bmp",
    "svg",
    "heic",
    "heif",
    "mp3",
    "wav",
    "m4a",
    "ogg",
    "aac",
    "flac",
    "mp4",
    "mov",
    "avi",
    "mkv",
    "webm",
    "srt",
    "vtt",
    "py",
    "js",
    "jsx",
    "ts",
    "tsx",
    "css",
    "html",
    "sql",
    "ipynb"
  ]);
  const FILE_EXT_PATTERN = Array.from(FILE_NAME_EXTENSIONS)
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp)
    .join("|");
  const FILE_NAME_IN_TEXT_RE = new RegExp(
    `([A-Za-z0-9][A-Za-z0-9 _().-]{0,118}\\.(?:${FILE_EXT_PATTERN}))(?=$|[^A-Za-z0-9]|[A-Z]{2,}(?=[a-z]))`,
    "gi"
  );
  const BOOKMARK_SVG = `
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
      <path fill="currentColor" d="M6 2c-1.1 0-2 .9-2 2v16l8-3.2 8 3.2V4c0-1.1-.9-2-2-2H6zm0 2h12v13.2l-6-2.4-6 2.4V4z"/>
    </svg>
  `;
  const MINUS_SVG = `
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
      <rect x="6" y="11" width="12" height="2" fill="currentColor" rx="1" />
    </svg>
  `;
  const EXPAND_SVG = `
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
      <path fill="currentColor" d="M7.4 9.6L12 14.2l4.6-4.6L18 11l-6 6-6-6z"/>
    </svg>
  `;
  const COLLAPSE_SVG = `
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
      <path fill="currentColor" d="M7.4 14.4L12 9.8l4.6 4.6L18 13l-6-6-6 6z"/>
    </svg>
  `;
  let prefsCache = { hiddenByDefault: false };
  const titleCacheByElement = new WeakMap();
  const regexCache = new Map();

  const svgTemplateContainer = document.createElement("div");
  function parseSvgTemplate(html) {
    svgTemplateContainer.innerHTML = html;
    return svgTemplateContainer.firstElementChild;
  }
  const EXPAND_SVG_TMPL = parseSvgTemplate(EXPAND_SVG);
  const COLLAPSE_SVG_TMPL = parseSvgTemplate(COLLAPSE_SVG);

  function setToggleIcon(btn, collapsed) {
    const tmpl = collapsed ? EXPAND_SVG_TMPL : COLLAPSE_SVG_TMPL;
    const existing = btn.firstElementChild;
    if (existing?.getAttribute?.("viewBox") === tmpl.getAttribute("viewBox")) {
      const path = existing.querySelector("path, rect");
      const tmplPath = tmpl.querySelector("path, rect");
      if (path && tmplPath && path.getAttribute("d") === tmplPath.getAttribute("d")) return;
    }
    btn.replaceChildren(tmpl.cloneNode(true));
    btn.setAttribute("aria-label", collapsed ? "Expand" : "Collapse");
    btn.setAttribute("title", collapsed ? "Expand" : "Collapse");
  }

  // ---------- Utilities ----------
  function getConversationKey() {
    return `${STORAGE_KEY_PREFIX}:${location.host}${location.pathname}`;
  }

  function textPreview(s, max = 120) {
    if (!s) return "";
    const t = s.replace(/\s+/g, " ").trim();
    return t.length > max ? t.slice(0, max - 1) + "…" : t;
  }

  function dedupeStrings(values) {
    const seen = new Set();
    const out = [];
    for (const raw of values || []) {
      const v = String(raw || "").trim();
      if (!v) continue;
      const key = v.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(v);
    }
    return out;
  }

  // FNV-1a. Used to derive a stable id for a prompt when the markup gives us
  // no id of its own — see stableIdForElement.
  function hashString(value) {
    let h = 0x811c9dc5;
    const s = String(value || "");
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(36);
  }

  function sanitizeFileNameCandidate(value) {
    return String(value || "")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/^[`"'([{<\s]+|[`"')\]}>.,;:!?]+$/g, "");
  }

  function escapeRegExp(value) {
    return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function isLikelyFileName(value) {
    const name = sanitizeFileNameCandidate(value);
    if (!name) return false;
    if (name.length < 3 || name.length > 140) return false;
    if (/[/\\]/.test(name)) return false;
    const dot = name.lastIndexOf(".");
    if (dot <= 0 || dot === name.length - 1) return false;
    const ext = name.slice(dot + 1).toLowerCase();
    return FILE_NAME_EXTENSIONS.has(ext);
  }

  function extractFileNamesFromText(value) {
    const text = String(value || "").replace(/\s+/g, " ").trim();
    if (!text) return [];
    if (!text.includes(".")) return [];
    const matches = [];
    FILE_NAME_IN_TEXT_RE.lastIndex = 0;
    let m = null;
    while ((m = FILE_NAME_IN_TEXT_RE.exec(text))) {
      if (m[1]) matches.push(m[1]);
      if (!m[0]) break;
    }
    FILE_NAME_IN_TEXT_RE.lastIndex = 0;
    return dedupeStrings(matches.map((name) => sanitizeFileNameCandidate(name)).filter((name) => isLikelyFileName(name)));
  }

  function collectFileNameCandidates(source, out) {
    if (!source) return;
    if (isLikelyFileName(source)) {
      out.push(sanitizeFileNameCandidate(source));
      return;
    }
    const parsed = extractFileNamesFromText(source);
    if (parsed.length) out.push(...parsed);
  }

  function extractUploadedFileNames(el) {
    if (!el?.querySelectorAll) return [];
    if (!el.querySelector?.(CGXDom.ATTACHMENT_SELECTOR)) return [];
    const nodes = el.querySelectorAll(CGXDom.ATTACHMENT_SELECTOR);
    if (!nodes.length) return [];

    const names = [];
    nodes.forEach((node) => {
      collectFileNameCandidates(node.getAttribute?.("download"), names);
      collectFileNameCandidates(node.getAttribute?.("title"), names);
      collectFileNameCandidates(node.getAttribute?.("aria-label"), names);
      collectFileNameCandidates(node.textContent, names);
    });
    return dedupeStrings(names);
  }

  function bracketUploadedFileNames(text, fileNames) {
    const names = dedupeStrings(fileNames);
    if (!names.length) return (text || "").trim();
    let out = String(text || "");
    let replacedAny = false;
    const sorted = names.slice().sort((a, b) => b.length - a.length);

    for (const name of sorted) {
      const bracketed = `[${name}]`;
      if (out.includes(bracketed)) continue;
      if (out.includes(name)) {
        out = out.split(name).join(bracketed);
        replacedAny = true;
      }
    }

    if (!replacedAny) {
      const prefix = names.map((name) => `[${name}]`).join(" ");
      out = out ? `${prefix} ${out}` : prefix;
    }

    return out.replace(/\s+/g, " ").trim();
  }

  function bracketStandaloneFileTitle(title) {
    const text = String(title || "").trim();
    if (!text) return "";
    if (/^\[[^\]]+\]$/.test(text)) return text;
    if (!isLikelyFileName(text)) return text;
    return `[${sanitizeFileNameCandidate(text)}]`;
  }

  function extractTextWithoutAttachmentNodes(el) {
    if (!el?.querySelectorAll) return (el?.textContent || "").trim();
    if (!el.querySelector?.(CGXDom.ATTACHMENT_SELECTOR)) {
      return String(el.textContent || "").replace(/\s+/g, " ").trim();
    }
    const attachmentNodes = el.querySelectorAll(CGXDom.ATTACHMENT_SELECTOR);
    const skipSet = new Set(attachmentNodes);
    const parts = [];
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        let parent = node.parentNode;
        while (parent && parent !== el) {
          if (skipSet.has(parent)) return NodeFilter.FILTER_REJECT;
          parent = parent.parentNode;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    while (walker.nextNode()) {
      const v = walker.currentNode.nodeValue;
      if (v) parts.push(v);
    }
    return parts.join(" ").replace(/\s+/g, " ").trim();
  }

  function getCachedRegex(pattern, flags) {
    const key = `${flags}:${pattern}`;
    let re = regexCache.get(key);
    if (!re) {
      re = new RegExp(pattern, flags);
      if (regexCache.size > 200) regexCache.clear();
      regexCache.set(key, re);
    }
    re.lastIndex = 0;
    return re;
  }

  function stripFileArtifactsFromText(text, fileNames) {
    let out = String(text || "");
    const names = dedupeStrings(fileNames);
    if (!names.length) return out.replace(/\s+/g, " ").trim();

    const exts = [];
    for (const name of names) {
      const cleanName = sanitizeFileNameCandidate(name);
      if (!cleanName) continue;
      const dot = cleanName.lastIndexOf(".");
      const ext = dot > 0 ? cleanName.slice(dot + 1) : "";
      if (ext) exts.push(ext);
      const escapedName = escapeRegExp(cleanName);
      if (ext) {
        const escapedExt = escapeRegExp(ext);
        out = out.replace(getCachedRegex(`${escapedName}\\s*${escapedExt}(?=\\b|\\s|$)`, "gi"), "");
      }
      out = out.replace(getCachedRegex(escapedName, "gi"), "");
    }

    const uniqueExts = dedupeStrings(exts);
    if (uniqueExts.length) {
      const extPattern = uniqueExts.map((ext) => escapeRegExp(ext)).join("|");
      out = out.replace(getCachedRegex(`\\b(?:${extPattern})\\b`, "gi"), "");
      out = out.replace(getCachedRegex(`(^|\\s)(?:${extPattern})(?=[A-Za-z])`, "gi"), "$1");
    }

    return out.replace(/\s+/g, " ").trim();
  }

  function extractAttachmentLikeFileNamesFromText(textInput) {
    const text = String(textInput || "").replace(/\s+/g, " ").trim();
    if (!text) return [];
    const candidates = extractFileNamesFromText(text);
    if (!candidates.length) return [];

    const lower = text.toLowerCase();
    const out = [];
    for (const name of candidates) {
      const idx = lower.indexOf(name.toLowerCase());
      if (idx < 0) continue;
      const after = text.slice(idx + name.length);
      const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "";
      const hasBadge = ext ? getCachedRegex(`^\\s*${escapeRegExp(ext)}\\b`, "i").test(after) : false;
      const hasGluedBadge = /^[A-Z]{2,}(?=[A-Za-z])/.test(after);
      if (hasBadge || hasGluedBadge) out.push(name);
    }
    return dedupeStrings(out);
  }

  function extractAttachmentLikeFileNamesFromMessageText(el) {
    return extractAttachmentLikeFileNamesFromText(el?.textContent || "");
  }

  function normalizeAttachmentArtifactsInTitle(title) {
    const text = String(title || "").replace(/\s+/g, " ").trim();
    if (!text) return "";
    const files = extractAttachmentLikeFileNamesFromText(text);
    if (!files.length) return text;
    const cleanedPromptText = stripFileArtifactsFromText(text, files);
    return bracketUploadedFileNames(cleanedPromptText, files) || text;
  }

  function safeAttrSelector(value) {
    if (window.CSS && CSS.escape) return CSS.escape(value);
    return String(value).replace(/"/g, '\\"');
  }

  function applyThemeFromDom() {
    const theme = CGXDom.detectTheme();
    if (theme) document.documentElement.setAttribute("data-cgx-theme", theme);
    else document.documentElement.removeAttribute("data-cgx-theme");
  }

  function isChatRoute(pathname = location.pathname) {
    return CGXDom.isChatRoute(pathname);
  }

  function removeInjectedUI() {
    document.getElementById(SIDEBAR_ID)?.remove();
    document.getElementById("cgx-show-pill")?.remove();
    document.querySelectorAll(`.${EXT_NS}-toggle, .${EXT_NS}-toggle-wrap`).forEach((el) => el.remove());
  }

  function classifyMutations(records) {
    let hasChange = false;
    let hasRemoval = false;
    for (const m of records) {
      if (m.type !== "childList") continue;
      if (!hasChange && m.addedNodes) {
        for (const node of m.addedNodes) {
          if (CGXDom.containsMessage(node)) { hasChange = true; break; }
        }
      }
      if (m.removedNodes) {
        for (const node of m.removedNodes) {
          if (CGXDom.containsMessage(node)) {
            hasChange = true;
            hasRemoval = true;
            break;
          }
        }
      }
      if (hasChange && hasRemoval) break;
    }
    return { hasChange, hasRemoval };
  }

  function extractUserText(el, uploadedFiles) {
    const files = Array.isArray(uploadedFiles) ? uploadedFiles : extractUploadedFileNames(el);
    if (!files.length) return String(el?.textContent || "").replace(/\s+/g, " ").trim();
    const txtWithoutAttachments = extractTextWithoutAttachmentNodes(el);
    const cleanedPromptText = stripFileArtifactsFromText(txtWithoutAttachments, files);
    return bracketUploadedFileNames(cleanedPromptText, files);
  }

  function getCachedTitle(el) {
    const memoTitle = titleCacheByElement.get(el);
    if (memoTitle != null) return memoTitle;

    const cached = el.getAttribute?.(`data-${EXT_NS}-title`);
    const cachedVersion = el.getAttribute?.(`data-${EXT_NS}-title-ver`);
    if (cached && cachedVersion === TITLE_CACHE_VERSION) {
      titleCacheByElement.set(el, cached);
      return cached;
    }

    const uploadedFiles = dedupeStrings([
      ...extractUploadedFileNames(el),
      ...extractAttachmentLikeFileNamesFromMessageText(el)
    ]);
    const raw = extractUserText(el, uploadedFiles);
    const baseTitle = textPreview(raw.split("\n").find(Boolean) || raw, 90);
    const title = normalizeAttachmentArtifactsInTitle(bracketStandaloneFileTitle(baseTitle) || "[Media]");
    el.setAttribute?.(`data-${EXT_NS}-title`, title);
    el.setAttribute?.(`data-${EXT_NS}-title-ver`, TITLE_CACHE_VERSION);
    titleCacheByElement.set(el, title);
    return title;
  }

  /**
   * A key for a turn that survives ChatGPT unmounting and remounting it.
   *
   * Order matters. An id we already stamped wins, then whatever id the markup
   * exposes, then the absolute turn number. Only if all of those are missing do
   * we fall back to hashing the prompt text — remounting must not mint a new
   * id, or the sidebar fills up with duplicates of the same question.
   */
  function stableIdForElement(el, idx, role) {
    const existing = el.getAttribute(`data-${EXT_NS}-id`);
    if (existing) return existing;

    let base = CGXDom.stableKey(el);
    if (!base) {
      const turn = CGXDom.turnNumber(el);
      if (turn != null) base = `turn${turn}`;
    }
    if (!base && role === CGXDom.ROLE_USER) {
      // Two prompts with identical text would collide; upsertUserEntry
      // disambiguates when it sees both mounted at once.
      base = `h${hashString((el.textContent || "").replace(/\s+/g, " ").trim())}`;
    }
    if (!base) base = `${idx.toString(36)}_${Math.random().toString(36).slice(2, 9)}`;

    const id = `${EXT_NS}_${base}`;
    el.setAttribute(`data-${EXT_NS}-id`, id);
    return id;
  }

  function ensureSidebar() {
    let sb = document.getElementById(SIDEBAR_ID);
    if (sb) return sb;

    sb = document.createElement("div");
    sb.id = SIDEBAR_ID;
    sb.classList.add("cgx-hidden");
    sb.setAttribute("aria-hidden", "true");

    sb.innerHTML = `
      <div id="cgx-header">
        <div id="cgx-title-row">
          <label id="cgx-hidden-default-row" for="cgx-hidden-default">
            <span>Hidden by Default</span>
            <span class="cgx-switch">
              <input type="checkbox" id="cgx-hidden-default" />
              <span class="cgx-switch-track" aria-hidden="true"></span>
            </span>
          </label>
          <button class="cgx-btn cgx-icon-btn" id="cgx-hide" title="Hide sidebar (Alt+N to show again)" aria-label="Hide sidebar">
            ${MINUS_SVG}
          </button>
        </div>
        <input id="cgx-search" placeholder="Search questions…" />
        <div id="cgx-actions">
          <button class="cgx-btn" id="cgx-refresh" title="Rescan messages">Refresh</button>
          <button class="cgx-btn" id="cgx-collapse-all">Collapse all</button>
          <button class="cgx-btn" id="cgx-expand-all">Expand all</button>
        </div>
      </div>
      <div id="cgx-list"></div>
    `;

    document.documentElement.appendChild(sb);
    ensureShowPill();

    // Hide button
    sb.querySelector("#cgx-hide").addEventListener("click", () => hideSidebar());

    // Search filter
    const search = sb.querySelector("#cgx-search");
    search.addEventListener("input", scheduleSearchRender);
    sb.querySelector("#cgx-list").addEventListener("click", onListClick);

    // Refresh: also forget the resolved DOM strategy, so a manual refresh can
    // recover from ChatGPT swapping its markup mid-session.
    sb.querySelector("#cgx-refresh").addEventListener("click", () => {
      CGXDom.resetStrategy();
      scanAndRender({ force: true });
    });

    // Collapse/Expand all
    sb.querySelector("#cgx-collapse-all").addEventListener("click", () => setAllAssistantCollapsed(true));
    sb.querySelector("#cgx-expand-all").addEventListener("click", () => setAllAssistantCollapsed(false));

    const hiddenDefaultToggle = sb.querySelector("#cgx-hidden-default");
    syncHiddenByDefaultToggle(sb);
    hiddenDefaultToggle.addEventListener("change", () => {
      setHiddenByDefault(hiddenDefaultToggle.checked);
    });

    return sb;
  }

  function ensureShowPill() {
    if (!isChatRoute()) return null;
    let pill = document.getElementById("cgx-show-pill");
    if (pill) return pill;

    pill = document.createElement("div");
    pill.id = "cgx-show-pill";
    pill.setAttribute("aria-label", "Show sidebar (Alt+N)");
    pill.setAttribute("title", "Show sidebar (Alt+N)");
    pill.innerHTML = BOOKMARK_SVG;

    pill.addEventListener("click", () => showSidebar());

    document.documentElement.appendChild(pill);
    return pill;
  }

  function isSidebarHidden(sb) {
    return !!sb?.classList?.contains("cgx-hidden");
  }

  function showSidebar() {
    const sb = ensureSidebar();
    sb.classList.remove("cgx-hidden");
    sb.setAttribute("aria-hidden", "false");
    document.getElementById("cgx-show-pill")?.remove();
  }

  function hideSidebar() {
    const sb = ensureSidebar();
    sb.classList.add("cgx-hidden");
    sb.setAttribute("aria-hidden", "true");
    ensureShowPill();
  }

  function applySidebarDefaultVisibility() {
    if (prefsCache.hiddenByDefault) hideSidebar();
    else showSidebar();
  }

  // ---------- Storage ----------
  async function loadState() {
    const key = getConversationKey();
    return new Promise((resolve) => {
      chrome.storage.local.get([key], (res) => resolve(normalizeState(res[key])));
    });
  }

  let saveStateTimer = null;
  function saveState(state) {
    if (saveStateTimer) clearTimeout(saveStateTimer);
    saveStateTimer = setTimeout(() => {
      saveStateTimer = null;
      const key = getConversationKey();
      chrome.storage.local.set({ [key]: state });
    }, 300);
  }
  function saveStateNow(state) {
    if (saveStateTimer) { clearTimeout(saveStateTimer); saveStateTimer = null; }
    const key = getConversationKey();
    return new Promise((resolve) => {
      chrome.storage.local.set({ [key]: state }, () => resolve());
    });
  }

  function normalizePrefs(raw) {
    const prefs = raw && typeof raw === "object" ? raw : {};
    const hasHiddenByDefault = Object.prototype.hasOwnProperty.call(prefs, "hiddenByDefault");
    const hasExpandByDefault = Object.prototype.hasOwnProperty.call(prefs, "expandByDefault");
    const hiddenByDefault = hasHiddenByDefault ? !!prefs.hiddenByDefault : hasExpandByDefault ? !prefs.expandByDefault : false;
    return {
      hiddenByDefault
    };
  }

  async function loadPrefs() {
    return new Promise((resolve) => {
      chrome.storage.local.get([PREFS_KEY], (res) => resolve(normalizePrefs(res[PREFS_KEY])));
    });
  }

  async function savePrefs(prefs = prefsCache) {
    const next = normalizePrefs(prefs);
    return new Promise((resolve) => {
      chrome.storage.local.set({ [PREFS_KEY]: next }, () => resolve());
    });
  }

  async function setHiddenByDefault(value) {
    prefsCache.hiddenByDefault = !!value;
    await savePrefs(prefsCache);
  }

  function syncHiddenByDefaultToggle(root = document) {
    const toggle = root.querySelector?.("#cgx-hidden-default");
    if (toggle) toggle.checked = !!prefsCache.hiddenByDefault;
  }

  // ---------- Collapse logic ----------
  //
  // Stored as a conversation-wide default plus per-answer overrides, not as a
  // set of collapsed ids. ChatGPT only mounts a window of the thread, so
  // "Collapse all" can never reach every answer at the moment it is clicked —
  // recording it as a default is what makes answers arrive already folded when
  // they finally mount.
  //
  // `defaultCollapsedUpTo` pins the default to answers that existed when the
  // button was pressed, so a reply you ask for afterwards isn't folded away
  // while it is still being written.
  function normalizeState(raw) {
    const s = raw && typeof raw === "object" ? raw : {};
    if (s.overrides || typeof s.defaultCollapsed === "boolean") {
      return {
        defaultCollapsed: !!s.defaultCollapsed,
        defaultCollapsedUpTo: Number.isFinite(s.defaultCollapsedUpTo) ? s.defaultCollapsedUpTo : null,
        overrides: { ...(s.overrides || {}) }
      };
    }
    // v1 stored a plain set of collapsed message ids.
    const overrides = {};
    for (const id of Object.keys(s.collapsed || {})) overrides[id] = true;
    return { defaultCollapsed: false, defaultCollapsedUpTo: null, overrides };
  }

  let stateCache = normalizeState(null);

  function isCollapsed(messageId, el) {
    const overrides = stateCache.overrides;
    if (overrides && Object.prototype.hasOwnProperty.call(overrides, messageId)) return !!overrides[messageId];
    if (!stateCache.defaultCollapsed) return false;
    const limit = stateCache.defaultCollapsedUpTo;
    if (limit == null) return true;
    const turn = el ? CGXDom.turnNumber(el) : null;
    return turn == null ? true : turn <= limit;
  }

  function setCollapsed(messageId, value, el) {
    stateCache.overrides = stateCache.overrides || {};
    // Record only a deviation from the default: drop any existing override,
    // see what the default gives, and re-add one only if it disagrees. Keeping
    // the map sparse is what lets "Collapse all" keep applying to answers that
    // have not mounted yet.
    delete stateCache.overrides[messageId];
    if (isCollapsed(messageId, el) !== !!value) stateCache.overrides[messageId] = !!value;
    saveState(stateCache);
  }

  // Highest turn number we know about, mounted or merely indexed.
  function highestKnownTurn(scan) {
    let max = null;
    for (const entry of indexById.values()) {
      if (CGXOrder.hasTurn(entry) && (max == null || entry.turn > max)) max = entry.turn;
    }
    for (const t of scan?.turns || []) {
      const n = CGXDom.turnNumber(t.el);
      if (n != null && (max == null || n > max)) max = n;
    }
    return max;
  }

  function injectToggleForAssistant(blockEl, messageId) {
    const content = CGXDom.assistantContent(blockEl);
    if (!content || CGXDom.isComposer(content)) return null;

    let wrap = blockEl.querySelector?.(`.${EXT_NS}-toggle-wrap`);
    if (!wrap) {
      wrap = document.createElement("div");
      wrap.className = `cgx-toggle-row ${EXT_NS}-toggle-wrap`;
    }

    let btn = wrap.querySelector?.(`button.${EXT_NS}-toggle`);
    if (!btn) {
      const existing = blockEl.querySelector?.(`button.${EXT_NS}-toggle`);
      if (existing) btn = existing;
    }

    if (!btn) {
      btn = document.createElement("button");
      btn.className = "cgx-toggle cgx-toggle-btn " + `${EXT_NS}-toggle`;
      btn.type = "button";
    }

    if (!wrap.contains(btn)) wrap.appendChild(btn);
    const parent = content?.parentElement || blockEl;
    if (parent && !parent.contains(wrap)) {
      parent.insertBefore(wrap, content);
    }

    const apply = () => {
      const collapsed = isCollapsed(messageId, blockEl);
      content.classList.toggle("cgx-collapsed", collapsed);
      setToggleIcon(btn, collapsed);
    };

    btn.dataset.cgxTarget = messageId;

    if (!btn.dataset?.cgxBound) {
      btn.dataset.cgxBound = "1";
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const targetId = btn.dataset.cgxTarget;
        if (!targetId) return;
        const targetEl = document.querySelector(`[data-${EXT_NS}-id="${safeAttrSelector(targetId)}"]`);
        if (!targetEl) return;
        const targetContent = CGXDom.assistantContent(targetEl);
        if (!targetContent) return;
        const next = !isCollapsed(targetId, targetEl);
        setCollapsed(targetId, next, targetEl);
        targetContent.classList.toggle("cgx-collapsed", next);
        setToggleIcon(btn, next);
      });
    }

    apply();
    return btn;
  }

  async function setAllAssistantCollapsed(value) {
    const scan = CGXDom.scanTurns();

    // Set the conversation default and clear every per-answer deviation. The
    // answers currently on screen are updated below; the ones ChatGPT hasn't
    // mounted pick this up from the default when they appear.
    stateCache.defaultCollapsed = !!value;
    stateCache.overrides = {};
    stateCache.defaultCollapsedUpTo = value ? highestKnownTurn(scan) : null;

    pauseObserver();
    try {
      for (let i = 0; i < scan.assistant.length; i++) {
        const el = scan.assistant[i];
        if (CGXDom.isComposer(el)) continue;
        injectToggleForAssistant(el, stableIdForElement(el, i, CGXDom.ROLE_ASSISTANT));
      }
    } finally {
      resumeObserver();
    }

    await saveStateNow(stateCache);
  }

  // ---------- Sidebar index ----------
  // Prompts accumulate in `indexById` (keyed by a stable id) instead of being
  // rebuilt from the DOM on every scan. ChatGPT virtualizes/windows long
  // conversations, so questions that scroll out of view leave the DOM; keeping
  // them here is what lets the sidebar list *all* prompts in long chats.
  let indexById = new Map(); // stableId -> {id, el, title, titleLower, turn, rank, seq, idx, anchorHint}
  let discoverySeq = 0;
  let currentIndex = []; // ordered snapshot of indexById, used for rendering
  let lastRenderedFilter = "";
  let lastUserSignature = "";
  let lastAssistantSignature = "";
  let lastScanTurns = [];
  let forceFullScan = true;
  let searchRenderTimer = null;

  function setCurrentIndex(nextIndex) {
    currentIndex = nextIndex || [];
  }

  function resetScanState() {
    indexById.clear();
    discoverySeq = 0;
    setCurrentIndex([]);
    lastUserSignature = "";
    lastAssistantSignature = "";
    lastScanTurns = [];
    forceFullScan = true;
    apiOrder = null;
    apiLoadedForPath = "";
    regexCache.clear();
    CGXDom.resetStrategy();
  }

  function clearSearchRenderTimer() {
    if (!searchRenderTimer) return;
    clearTimeout(searchRenderTimer);
    searchRenderTimer = null;
  }

  function getSidebarFilterValue(root = document.getElementById(SIDEBAR_ID)) {
    const input = root?.querySelector?.("#cgx-search");
    return (input?.value || "").trim().toLowerCase();
  }

  function scheduleSearchRender() {
    clearSearchRenderTimer();
    searchRenderTimer = setTimeout(() => {
      searchRenderTimer = null;
      const q = getSidebarFilterValue();
      if (q === lastRenderedFilter) return;
      renderList(currentIndex, q);
      lastRenderedFilter = q;
    }, SEARCH_INPUT_DEBOUNCE_MS);
  }

  // The answer that belongs to a prompt is the next assistant turn after it.
  // Uses the ordered turn list from the last scan so it costs nothing extra.
  function findNextAssistantForUser(userEl, turns, allowRescan = true) {
    if (!userEl) return null;
    const list = turns || lastScanTurns;
    const idx = list.findIndex((t) => t.el === userEl);
    if (idx < 0) {
      if (!allowRescan) return null;
      lastScanTurns = CGXDom.scanTurns().turns;
      return findNextAssistantForUser(userEl, lastScanTurns, false);
    }
    for (let i = idx + 1; i < list.length; i++) {
      if (list[i].role === CGXDom.ROLE_ASSISTANT) return list[i].el;
      // Hit the next question before finding an answer — nothing to expand.
      if (list[i].role === CGXDom.ROLE_USER) return null;
    }
    return null;
  }

  // ---------- Jumping to a prompt ----------
  // The sidebar lists every prompt, but ChatGPT only mounts a window of them,
  // so the one being clicked often has no element yet. Look for it, then fall
  // back to scrolling the thread until ChatGPT renders it.
  const HUNT_ATTEMPTS = 10;
  const HUNT_MOUNT_TIMEOUT_MS = 300;
  const SETTLE_PASSES = 6;
  const SETTLE_PAUSE_MS = 90;
  const POLL_STEP_MS = 30;

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // Poll until `predicate` returns something truthy, or give up. Used instead
  // of a fixed number of frames because how long ChatGPT takes to render a
  // freshly scrolled-to turn varies a lot with thread length.
  async function waitFor(predicate, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = predicate();
      if (value) return value;
      if (Date.now() >= deadline) return null;
      await sleep(POLL_STEP_MS);
    }
  }

  function findScroller() {
    const anchor = document.querySelector("[data-message-id]") || CGXDom.conversationRoot();
    let el = anchor?.parentElement;
    while (el && el !== document.body) {
      if (el.scrollHeight > el.clientHeight + 32) {
        const overflowY = getComputedStyle(el).overflowY;
        if (overflowY === "auto" || overflowY === "scroll") return el;
      }
      el = el.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  }

  function messageElement(messageId) {
    if (!messageId) return null;
    const safe = safeAttrSelector(messageId);
    // Queried separately, not as one comma selector: the container wraps the
    // message, so a combined query would return the container by document
    // order. Callers need the message itself when it exists — it is what the
    // turn scan yields, and what expanding the answer below it keys off.
    return (
      document.querySelector(`[data-message-id="${safe}"]`) ||
      // Placeholder that survives when the message itself is unmounted; still
      // worth scrolling to.
      document.querySelector(`[data-turn-id-container="${safe}"]`)
    );
  }

  // Which slice of the conversation is mounted, expressed in API positions.
  function mountedApiRange() {
    if (!apiOrder) return null;
    let min = Infinity;
    let max = -Infinity;
    for (const el of document.querySelectorAll("[data-message-id]")) {
      const pos = apiOrder.get(el.getAttribute("data-message-id"));
      if (pos == null) continue;
      if (pos < min) min = pos;
      if (pos > max) max = pos;
    }
    return min === Infinity ? null : { min, max };
  }

  // Bisect on scroll position until the wanted turn mounts. Each pass compares
  // the target against the range currently on screen, so it converges in a few
  // steps instead of crawling the thread.
  async function huntForMessage(entry) {
    if (!entry.messageId) return null;
    const scroller = findScroller();
    if (scroller.scrollHeight - scroller.clientHeight <= 0) return null;

    const total = apiOrder?.size || currentIndex.length || 1;
    const position = entry.apiIndex != null ? entry.apiIndex : Math.max(0, currentIndex.indexOf(entry));
    let lo = 0;
    let hi = 1;
    let guess = Math.min(1, Math.max(0, position / Math.max(1, total - 1)));

    for (let attempt = 0; attempt < HUNT_ATTEMPTS; attempt++) {
      scroller.scrollTop = (scroller.scrollHeight - scroller.clientHeight) * guess;
      const found = await waitFor(() => messageElement(entry.messageId), HUNT_MOUNT_TIMEOUT_MS);
      if (found) return found;

      const range = mountedApiRange();
      if (!range || entry.apiIndex == null) break;
      if (entry.apiIndex < range.min) hi = guess;
      else if (entry.apiIndex > range.max) lo = guess;
      else break; // in range but absent — scrolling more won't help
      guess = (lo + hi) / 2;
    }
    return messageElement(entry.messageId);
  }

  /**
   * Bring a turn to rest near the top of the viewport.
   *
   * Scrolling to a turn is not a single operation. Landing there makes ChatGPT
   * mount the turns around it, which changes the height of everything above
   * and shifts the target out from under the scroll — a smooth scroll gets
   * abandoned mid-flight and stops short, which is why a jump used to need a
   * second click. So: jump instantly, let the thread relayout, look at where
   * the target actually ended up, and correct until it stays put.
   */
  async function settleOnElement(entry, initial) {
    let el = initial;
    for (let pass = 0; pass < SETTLE_PASSES; pass++) {
      if (!el?.isConnected) {
        el = entry.messageId ? await waitFor(() => messageElement(entry.messageId), HUNT_MOUNT_TIMEOUT_MS) : null;
        if (!el) return null;
      }

      const rect = el.getBoundingClientRect();
      const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
      const restingNearTop = rect.top >= 0 && rect.top <= Math.max(120, viewportHeight * 0.5);
      if (restingNearTop) return el;

      // "auto", never "smooth" — an instant scroll cannot be interrupted by
      // the relayout it triggers.
      el.scrollIntoView({ behavior: "auto", block: "start" });
      await sleep(SETTLE_PAUSE_MS);
      if (entry.messageId) el = messageElement(entry.messageId) || el;
    }
    return el;
  }

  function flashElement(el) {
    el.classList.remove("cgx-highlight");
    void el.offsetWidth;
    el.classList.add("cgx-highlight");
    setTimeout(() => el?.classList?.remove("cgx-highlight"), 1300);
  }

  function expandAnswerFor(userEl) {
    const next = findNextAssistantForUser(userEl);
    if (!next) return;
    const nextId = next.getAttribute?.(`data-${EXT_NS}-id`);
    if (!nextId || !isCollapsed(nextId, next)) return;
    setCollapsed(nextId, false, next);
    const content = CGXDom.assistantContent(next);
    content?.classList?.remove("cgx-collapsed");
    const toggleBtn = next.querySelector?.(`.${EXT_NS}-toggle`);
    if (!toggleBtn) return;
    setToggleIcon(toggleBtn, false);
  }

  let revealInFlight = false;
  async function revealEntry(entry) {
    if (!entry || revealInFlight) return;
    revealInFlight = true;
    try {
      let el = entry.el?.isConnected ? entry.el : messageElement(entry.messageId);
      if (!el) el = await huntForMessage(entry);
      if (!el) return;
      el = (await settleOnElement(entry, el)) || el;
      if (!el.isConnected) return;
      entry.el = el;
      flashElement(el);
      expandAnswerFor(el);
    } finally {
      revealInFlight = false;
    }
  }

  function handleIndexItemClick(it) {
    void revealEntry(it);
  }

  function onListClick(event) {
    const card = event?.target?.closest?.(".cgx-item[data-cgx-id]");
    if (!card) return;
    const itemId = card.getAttribute("data-cgx-id");
    if (!itemId) return;
    handleIndexItemClick(indexById.get(itemId));
  }

  // When ChatGPT switches conversations it swaps the thread in place, and for
  // a moment the outgoing conversation's turns are still mounted. Without this
  // they get indexed into the incoming conversation's list, where they linger
  // because the index is cumulative.
  let staleMessageKeys = null;
  let staleGuardUntil = 0;
  let staleForPath = "";

  function beginConversationSwitch(targetPath) {
    // Both the link click and the URL poll call this for the same navigation.
    // Only the first may snapshot: by the time the second runs, turns from the
    // *incoming* conversation may already be mounted, and marking those stale
    // would hide the very questions we are switching to.
    if (staleMessageKeys && staleForPath === targetPath) return;
    staleForPath = targetPath;
    const keys = new Set();
    for (const el of document.querySelectorAll("[data-message-id], [data-turn-id]")) {
      const key = CGXDom.stableKey(el);
      if (key) keys.add(key);
    }
    staleMessageKeys = keys.size ? keys : null;
    staleGuardUntil = Date.now() + STALE_GUARD_MS;
  }

  function dropStaleTurns(scan) {
    if (!staleMessageKeys) return scan;
    if (Date.now() > staleGuardUntil) {
      // Safety valve: never let the guard wedge the sidebar shut, e.g. if the
      // incoming conversation happens to be the one we just left.
      staleMessageKeys = null;
      return scan;
    }

    const keep = scan.turns.filter((t) => {
      const key = CGXDom.stableKey(t.el);
      return key == null || !staleMessageKeys.has(key);
    });
    if (keep.length === scan.turns.length) {
      staleMessageKeys = null;
      return scan;
    }

    const user = [];
    const assistant = [];
    for (const t of keep) {
      if (t.role === CGXDom.ROLE_USER) user.push(t.el);
      else if (t.role === CGXDom.ROLE_ASSISTANT) assistant.push(t.el);
    }
    return { strategy: scan.strategy, turns: keep, user, assistant };
  }

  function renderIfNeeded(changed, q) {
    if (changed || q !== lastRenderedFilter || forceFullScan) {
      renderList(currentIndex, q);
      lastRenderedFilter = q;
    }
  }

  // Insert or refresh a prompt in the cumulative store. Returns the entry plus
  // whether the ordered view needs rebuilding (new entry, or title/turn
  // changed). A moved DOM node (same id) just refreshes `el` silently.
  function upsertUserEntry(el, domIndex, seenThisScan) {
    let id = stableIdForElement(el, domIndex, CGXDom.ROLE_USER);

    // Two different prompts resolved to the same id — only possible via the
    // text-hash fallback, when a question was asked twice verbatim. Give the
    // later one its own id so both stay listed.
    if (seenThisScan?.has(id)) {
      let suffix = 2;
      while (seenThisScan.has(`${id}#${suffix}`)) suffix++;
      id = `${id}#${suffix}`;
      el.setAttribute(`data-${EXT_NS}-id`, id);
    }
    seenThisScan?.add(id);

    const title = getCachedTitle(el) || "[Media]";
    const turn = CGXDom.turnNumber(el);
    const existing = indexById.get(id);
    if (!existing) {
      const entry = {
        id,
        el,
        messageId: CGXDom.stableKey(el),
        title,
        titleLower: title.toLowerCase(),
        turn,
        rank: null,
        apiIndex: null,
        seq: discoverySeq++,
        idx: 0,
        anchorHint: ""
      };
      indexById.set(id, entry);
      return { entry, changed: true };
    }

    existing.el = el;
    if (!existing.messageId) existing.messageId = CGXDom.stableKey(el);
    let changed = false;
    // The API text is the whole prompt; the DOM version is whatever survived
    // rendering, so don't let a rescan downgrade it.
    if (existing.apiIndex == null && existing.title !== title) {
      existing.title = title;
      existing.titleLower = title.toLowerCase();
      changed = true;
    }
    // Never clobber a known turn number with null. Ordering switches to
    // relative ranks the moment a single entry loses its number, so a
    // transient read failure must not flip the whole list.
    if (turn != null && existing.turn !== turn) {
      existing.turn = turn;
      changed = true;
    }
    return { entry: existing, changed };
  }

  // ---------- Conversation API ----------
  // The API is authoritative for *which* prompts exist and in what order; the
  // DOM only supplies live elements to scroll to and fold. Everything here
  // degrades to null/no-op if the fetch fails, leaving the DOM path in charge.
  let apiOrder = null; // messageId -> position on the active branch
  let apiLoadedForPath = "";

  function titleFromApiMessage(message) {
    const files = dedupeStrings(message.attachments || []);
    const firstLine = (message.text || "").split("\n").find((line) => line.trim()) || message.text || "";
    const base = textPreview(firstLine, 90);
    if (files.length) return bracketUploadedFileNames(base, files) || `[${files[0]}]`;
    if (base) return bracketStandaloneFileTitle(base);
    return message.mediaCount ? "[Media]" : "[Empty]";
  }

  function mergeApiMessages(messages) {
    const keep = new Set();

    for (const message of messages) {
      if (message.role !== CGXDom.ROLE_USER) continue;
      const id = `${EXT_NS}_${message.id}`;
      keep.add(id);
      const title = titleFromApiMessage(message);
      const existing = indexById.get(id);
      if (existing) {
        existing.apiIndex = message.index;
        existing.messageId = message.id;
        if (existing.title !== title) {
          existing.title = title;
          existing.titleLower = title.toLowerCase();
        }
        continue;
      }
      indexById.set(id, {
        id,
        el: null,
        messageId: message.id,
        title,
        titleLower: title.toLowerCase(),
        turn: null,
        rank: null,
        apiIndex: message.index,
        seq: discoverySeq++,
        idx: 0,
        anchorHint: ""
      });
    }

    // Drop anything the API didn't list. A prompt that is on screen right now
    // is on the active branch by definition, so it survives even if it arrived
    // after the fetch; the rest are abandoned edit branches or leftovers from
    // a conversation we already navigated away from.
    for (const [id, entry] of Array.from(indexById)) {
      if (keep.has(id) || entry.el?.isConnected) continue;
      indexById.delete(id);
    }
  }

  async function loadFromApi(epoch) {
    const conversationId = CGXApi.conversationIdFromPath();
    if (!conversationId) return;

    const result = await CGXApi.fetchConversation(conversationId);
    if (!result || epoch !== routeEpoch) return;

    apiOrder = result.order;
    apiLoadedForPath = location.pathname;
    mergeApiMessages(result.messages);
    rebuildOrderedIndex();
    renderList(currentIndex, getSidebarFilterValue());
    // Re-attach element references for whatever ChatGPT has actually mounted.
    forceFullScan = true;
    await scanAndRender();
  }

  function mergeUserNodesIntoIndex(userNodes) {
    let changed = false;
    const seenThisScan = new Set();
    const observed = [];

    for (let i = 0; i < userNodes.length; i++) {
      const el = userNodes[i];
      if (CGXDom.isComposer(el)) continue;
      const { entry, changed: entryChanged } = upsertUserEntry(el, i, seenThisScan);
      if (entryChanged) changed = true;
      observed.push(entry);
    }

    // Keep relative ranks current even when absolute turn numbers are
    // available, so ordering survives ChatGPT dropping that attribute later.
    if (observed.length && CGXOrder.reconcile(observed, indexById.values())) changed = true;
    return changed;
  }

  // Rebuild the ordered render snapshot from the store. Turn-number collisions
  // (editing a prompt spawns a new branch that reuses turn numbers) are resolved
  // in favour of the live in-DOM entry, pruning the stale branch from the store.
  function rebuildOrderedIndex() {
    const entries = Array.from(indexById.values());
    if (!entries.length) {
      setCurrentIndex([]);
      return;
    }

    if (entries.every(CGXOrder.hasTurn)) {
      const byTurn = new Map();
      for (const e of entries) {
        const prev = byTurn.get(e.turn);
        if (!prev) {
          byTurn.set(e.turn, e);
          continue;
        }
        const eLive = !!e.el?.isConnected;
        const prevLive = !!prev.el?.isConnected;
        if (eLive !== prevLive ? eLive : e.seq > prev.seq) byTurn.set(e.turn, e);
      }
      if (byTurn.size !== entries.length) {
        const keep = new Set(byTurn.values());
        for (const [id, e] of indexById) {
          if (!keep.has(e)) indexById.delete(id);
        }
      }
    }

    const ordered = CGXOrder.sortEntries(indexById.values());
    for (let i = 0; i < ordered.length; i++) ordered[i].idx = i + 1;
    setCurrentIndex(ordered);
  }

  function renderPlaceholder(text) {
    const list = ensureSidebar().querySelector("#cgx-list");
    const existing = list.firstElementChild;
    if (list.childElementCount === 1 && existing?.classList?.contains("cgx-muted")) {
      if (existing.textContent !== text) existing.textContent = text;
      return;
    }
    const div = document.createElement("div");
    div.className = "cgx-muted";
    div.textContent = text;
    list.replaceChildren(div);
  }

  function renderList(indexItems, filterLower) {
    const sb = ensureSidebar();
    const list = sb.querySelector("#cgx-list");

    const items = (indexItems || []).filter((it) => {
      if (!filterLower) return true;
      if (typeof it.titleLower === "string") return it.titleLower.includes(filterLower);
      return (it.title || "").toLowerCase().includes(filterLower);
    });

    if (!items.length) {
      renderPlaceholder(filterLower ? "No questions match." : "No questions found.");
      return;
    }

    const existingById = new Map();
    for (const el of list.querySelectorAll(".cgx-item[data-cgx-id]")) {
      existingById.set(el.getAttribute("data-cgx-id"), el);
    }
    list.querySelector(".cgx-muted")?.remove();

    // Keyed, in-place reconciliation. Collecting the cards into a fragment and
    // re-appending would detach every child, which empties the list for an
    // instant and resets its scroll position — so walk the existing nodes and
    // only move the ones that are genuinely out of place. Appending a new
    // question at the end costs exactly one DOM insertion.
    let cursor = list.firstElementChild;
    for (const it of items) {
      let card = existingById.get(it.id);
      if (card) {
        existingById.delete(it.id);
        updateItemCard(card, it);
      } else {
        card = createItemCard(it);
      }
      if (card === cursor) {
        cursor = cursor.nextElementSibling;
        continue;
      }
      list.insertBefore(card, cursor);
    }
    for (const stale of existingById.values()) stale.remove();
  }

  function createItemCard(it) {
    const card = document.createElement("div");
    card.className = "cgx-item";
    const meta = document.createElement("div");
    meta.className = "meta";
    const spanIdx = document.createElement("span");
    spanIdx.textContent = `#${it.idx}`;
    const spanHint = document.createElement("span");
    spanHint.textContent = it.anchorHint || "";
    meta.append(spanIdx, spanHint);
    const q = document.createElement("div");
    q.className = "q";
    q.textContent = it.title || "";
    card.append(meta, q);
    card.setAttribute("data-cgx-id", it.id);
    return card;
  }

  function updateItemCard(card, it) {
    const qEl = card.querySelector(".q");
    if (qEl && qEl.textContent !== (it.title || "")) qEl.textContent = it.title || "";
    const idxEl = card.querySelector(".meta span");
    const idxText = `#${it.idx}`;
    if (idxEl && idxEl.textContent !== idxText) idxEl.textContent = idxText;
  }

  function getNodeSignaturePart(node, idx) {
    if (!node) return `i${idx}`;
    return (
      node.getAttribute?.("data-message-id") ||
      node.getAttribute?.("data-turn-id") ||
      node.getAttribute?.(`data-${EXT_NS}-id`) ||
      node.id ||
      `i${idx}`
    );
  }

  function buildNodeSignature(nodes) {
    const len = nodes?.length || 0;
    if (!len) return "0";
    if (len === 1) return `1:${getNodeSignaturePart(nodes[0], 0)}`;
    if (len === 2) return `2:${getNodeSignaturePart(nodes[0], 0)}|${getNodeSignaturePart(nodes[1], 1)}`;
    const mid = Math.floor((len - 1) / 2);
    return `${len}:${getNodeSignaturePart(nodes[0], 0)}|${getNodeSignaturePart(nodes[mid], mid)}|${getNodeSignaturePart(nodes[len - 1], len - 1)}`;
  }

  function syncAssistantToggles(assistantNodes) {
    for (let i = 0; i < assistantNodes.length; i++) {
      const el = assistantNodes[i];
      if (CGXDom.isComposer(el)) continue;
      const id = stableIdForElement(el, i, CGXDom.ROLE_ASSISTANT);
      const existing = el.querySelector?.(`button.${EXT_NS}-toggle`);
      if (!existing || existing.dataset?.cgxBound !== "1") {
        injectToggleForAssistant(el, id);
      }
    }
  }

  async function scanAndRender(options = {}) {
    if (!isChatRoute()) return;
    if (options.force) forceFullScan = true;

    const sb = ensureSidebar();
    const q = getSidebarFilterValue(sb);

    pauseObserver();
    try {
      const scan = dropStaleTurns(CGXDom.scanTurns());
      lastScanTurns = scan.turns;

      const userSignature = buildNodeSignature(scan.user);
      const assistantSignature = buildNodeSignature(scan.assistant);
      const userChanged = forceFullScan || userSignature !== lastUserSignature;
      const assistantChanged = forceFullScan || assistantSignature !== lastAssistantSignature;

      if (assistantChanged) syncAssistantToggles(scan.assistant);

      if (userChanged) {
        const changed = mergeUserNodesIntoIndex(scan.user);
        if (changed) rebuildOrderedIndex();
        renderIfNeeded(changed, q);
      } else {
        renderIfNeeded(false, q);
      }

      lastUserSignature = userSignature;
      lastAssistantSignature = assistantSignature;
      forceFullScan = false;
    } finally {
      resumeObserver();
    }
  }

  // ---------- Observe & init ----------
  let debounceTimer = null;
  let idleHandle = null;
  let pendingSince = 0;

  function runScheduledScan() {
    debounceTimer = null;
    pendingSince = 0;
    if (idleHandle && window.cancelIdleCallback) {
      cancelIdleCallback(idleHandle);
      idleHandle = null;
    }
    if (window.requestIdleCallback) {
      idleHandle = requestIdleCallback(
        () => {
          idleHandle = null;
          scanAndRender();
        },
        { timeout: IDLE_TIMEOUT_MS }
      );
    } else {
      scanAndRender();
    }
  }

  function scheduleScan() {
    if (!isChatRoute()) return;
    if (observeTarget && !document.contains(observeTarget)) startObserver();
    const now = Date.now();
    if (!pendingSince) pendingSince = now;
    // Plain debouncing never fires while an answer streams, because each
    // token resets it. Clamp the delay by how long we have already waited so
    // a scan always lands within MAX_SCAN_DELAY_MS of the first mutation.
    const delay = Math.max(0, Math.min(DEBOUNCE_MS, MAX_SCAN_DELAY_MS - (now - pendingSince)));
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(runScheduledScan, delay);
  }

  let mo = null;
  let observeTarget = null;
  let lastPath = "";
  let routeEpoch = 0;

  function clearScheduledScan() {
    pendingSince = 0;
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    if (idleHandle && window.cancelIdleCallback) {
      cancelIdleCallback(idleHandle);
      idleHandle = null;
    }
  }

  let observerPaused = false;
  function pauseObserver() { observerPaused = true; }
  function resumeObserver() {
    observerPaused = false;
    if (mo) mo.takeRecords();
  }

  function startObserver() {
    const nextTarget = CGXDom.conversationRoot();
    if (mo && observeTarget === nextTarget) return;
    stopObserver();
    observeTarget = nextTarget;
    mo = new MutationObserver((records) => {
      if (observerPaused) return;
      // The new thread rendering is frequently the first observable sign that
      // the route moved, since we cannot hook the page's navigation calls.
      // Catching it here rather than waiting for the next poll tick is what
      // keeps the incoming conversation from being merged into the outgoing
      // conversation's list.
      if (location.pathname !== lastPath) {
        void handleRouteChange();
        return;
      }
      const { hasChange, hasRemoval } = classifyMutations(records);
      if (!hasChange) return;
      if (hasRemoval) forceFullScan = true;
      scheduleScan();
    });
    mo.observe(observeTarget, { childList: true, subtree: true });
  }

  function stopObserver() {
    if (mo) {
      mo.disconnect();
      mo = null;
    }
    observeTarget = null;
    clearScheduledScan();
  }

  async function activateForChat(epoch) {
    setCurrentIndex([]);
    lastRenderedFilter = "";
    clearSearchRenderTimer();
    resetScanState();
    ensureSidebar();
    // Replace the outgoing conversation's questions straight away — leaving
    // them up while the new thread renders is what made switching feel slow.
    renderPlaceholder("Loading questions…");
    applySidebarDefaultVisibility();
    startObserver();

    // Start the fetch before anything else — it is what fills the sidebar for
    // long threads, and it runs while the DOM scan produces a partial list.
    const apiLoad = loadFromApi(epoch).catch(() => {});

    const loadedState = await loadState();
    if (epoch !== routeEpoch || !isChatRoute()) return;
    stateCache = loadedState;
    await scanAndRender();
    await apiLoad;
  }

  function deactivateForNonChat() {
    stopObserver();
    removeInjectedUI();
    setCurrentIndex([]);
    lastRenderedFilter = "";
    clearSearchRenderTimer();
    resetScanState();
  }

  async function handleRouteChange() {
    const path = location.pathname || "";
    if (path === lastPath) return;
    const epoch = ++routeEpoch;
    const wasChat = isChatRoute(lastPath);
    lastPath = path;
    if (isChatRoute(path)) {
      if (wasChat) beginConversationSwitch(path);
      stopObserver();
      await activateForChat(epoch);
    } else {
      deactivateForNonChat();
    }
  }

  function pathnameFromHref(href) {
    if (!href) return null;
    try {
      const url = new URL(href, location.href);
      if (url.origin !== location.origin) return null;
      return url.pathname;
    } catch {
      return null;
    }
  }

  function getNavIntentPath(event) {
    if (!event || event.defaultPrevented) return null;
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return null;
    const anchor = event.target?.closest?.("a[href]");
    if (!anchor) return null;
    if (anchor.target && anchor.target !== "_self") return null;
    return pathnameFromHref(anchor.getAttribute("href"));
  }

  let navIntentTimer = null;

  // Clicking a conversation link is the earliest notice we get that the thread
  // is about to change — it arrives before the URL does, and unlike pushState
  // the click event crosses into our world. Clearing here is what stops the
  // outgoing conversation's questions from sitting under the new ones.
  function applyFastNavIntent(path) {
    if (!path || path === location.pathname) return;
    if (!isChatRoute(path)) {
      deactivateForNonChat();
      return;
    }

    ensureSidebar();
    applySidebarDefaultVisibility();
    if (!isChatRoute()) return;

    beginConversationSwitch(path);
    renderPlaceholder("Loading questions…");

    // The click might not lead anywhere — a cancelled navigation, or a link
    // handled some other way. Restore what we were showing if the URL never
    // catches up.
    if (navIntentTimer) clearTimeout(navIntentTimer);
    navIntentTimer = setTimeout(() => {
      navIntentTimer = null;
      if (location.pathname === path || location.pathname !== lastPath) return;
      staleMessageKeys = null;
      staleForPath = "";
      renderList(currentIndex, getSidebarFilterValue());
    }, NAV_INTENT_TIMEOUT_MS);
  }

  function installRouteListeners() {
    if (window.__cgxRouteHooked) return;
    window.__cgxRouteHooked = true;
    const notify = () => {
      try { window.dispatchEvent(new Event("cgx:locationchange")); } catch {}
    };
    const wrap = (original) =>
      function (...args) {
        const ret = original.apply(this, args);
        notify();
        return ret;
      };
    try {
      if (history?.pushState && !history.pushState.__cgxWrapped) {
        history.pushState = wrap(history.pushState);
        history.pushState.__cgxWrapped = true;
      }
      if (history?.replaceState && !history.replaceState.__cgxWrapped) {
        history.replaceState = wrap(history.replaceState);
        history.replaceState.__cgxWrapped = true;
      }
    } catch {}
    window.addEventListener("popstate", notify, { passive: true });
    window.addEventListener("hashchange", notify, { passive: true });
    if (window.navigation?.addEventListener) {
      window.navigation.addEventListener("navigate", notify);
    }
    document.addEventListener(
      "click",
      (e) => {
        const intentPath = getNavIntentPath(e);
        if (!intentPath) return;
        applyFastNavIntent(intentPath);
      },
      { capture: true, passive: true }
    );
    window.addEventListener("cgx:locationchange", () => handleRouteChange());
  }

  async function init() {
    prefsCache = await loadPrefs();
    installRouteListeners();
    await handleRouteChange();
    applyThemeFromDom();
    const themeObserver = new MutationObserver(() => applyThemeFromDom());
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "data-theme", "data-color-mode", "data-color-scheme"]
    });
    if (document.body) {
      themeObserver.observe(document.body, {
        attributes: true,
        attributeFilter: ["class", "data-theme", "data-color-mode", "data-color-scheme"]
      });
    }
    let routePollTimer = null;
    function startRoutePoll() {
      if (routePollTimer) return;
      routePollTimer = setInterval(() => handleRouteChange(), ROUTE_POLL_MS);
    }
    function stopRoutePoll() {
      if (!routePollTimer) return;
      clearInterval(routePollTimer);
      routePollTimer = null;
    }
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") {
        stopRoutePoll();
      } else {
        handleRouteChange();
        startRoutePoll();
      }
    });
    if (document.visibilityState !== "hidden") startRoutePoll();

    window.addEventListener("keydown", (e) => {
      if (e.altKey && e.key.toLowerCase() === "n") {
        e.preventDefault();
        if (!isChatRoute()) return;
        const sb = document.getElementById(SIDEBAR_ID);
        if (!sb) return;
        if (isSidebarHidden(sb)) showSidebar();
        else hideSidebar();
      }
    });
  }

  setTimeout(init, INIT_DELAY_MS);
})();
