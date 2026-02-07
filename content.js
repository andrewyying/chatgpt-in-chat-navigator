(() => {
  const EXT_NS = "cgx";
  const SIDEBAR_ID = "cgx-sidebar";
  const STORAGE_KEY_PREFIX = "cgx_state_v1";
  const PREFS_KEY = "cgx_prefs_v1";
  const DEBOUNCE_MS = 450;
  const IDLE_TIMEOUT_MS = 1200;
  const MESSAGE_ROLE_SELECTOR = "[data-message-author-role]";
  const MESSAGE_ID_SELECTOR = "[data-message-id]";
  const TURN_SELECTOR = "article[data-testid^='conversation-turn-'], [data-turn-id]";
  const LIKELY_MESSAGE_SELECTOR = `${MESSAGE_ROLE_SELECTOR}, ${MESSAGE_ID_SELECTOR}, ${TURN_SELECTOR}`;
  const ATTACHMENT_NODE_SELECTOR = [
    "a[download]",
    "a[href*='/files/']",
    "a[href^='sandbox:']",
    "[data-testid*='attachment']",
    "[data-testid*='file']",
    "[aria-label*='attachment' i]",
    "[aria-label*='file' i]"
  ].join(", ");
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
    .map((ext) => ext.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
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
    if (/[\/\\]/.test(name)) return false;
    const dot = name.lastIndexOf(".");
    if (dot <= 0 || dot === name.length - 1) return false;
    const ext = name.slice(dot + 1).toLowerCase();
    return FILE_NAME_EXTENSIONS.has(ext);
  }

  function extractFileNamesFromText(value) {
    const text = String(value || "").replace(/\s+/g, " ").trim();
    if (!text) return [];
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
    const nodes = el.querySelectorAll(ATTACHMENT_NODE_SELECTOR);
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
    const clone = el.cloneNode(true);
    clone.querySelectorAll(ATTACHMENT_NODE_SELECTOR).forEach((node) => node.remove());
    return String(clone.textContent || "").replace(/\s+/g, " ").trim();
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
        out = out.replace(new RegExp(`${escapedName}\\s*${escapedExt}(?=\\b|\\s|$)`, "gi"), "");
      }
      out = out.replace(new RegExp(escapedName, "gi"), "");
    }

    const uniqueExts = dedupeStrings(exts);
    if (uniqueExts.length) {
      const extPattern = uniqueExts.map((ext) => escapeRegExp(ext)).join("|");
      out = out.replace(new RegExp(`\\b(?:${extPattern})\\b`, "gi"), "");
      out = out.replace(new RegExp(`(^|\\s)(?:${extPattern})(?=[A-Za-z])`, "gi"), "$1");
    }

    return out.replace(/\s+/g, " ").trim();
  }

  function extractAttachmentLikeFileNamesFromText(textInput) {
    const text = String(textInput || "").replace(/\s+/g, " ").trim();
    if (!text) return [];
    const candidates = extractFileNamesFromText(text);
    if (!candidates.length) return [];

    const out = [];
    for (const name of candidates) {
      const idx = text.toLowerCase().indexOf(name.toLowerCase());
      if (idx < 0) continue;
      const after = text.slice(idx + name.length);
      const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "";
      const extBadgePattern = ext ? new RegExp(`^\\s*${escapeRegExp(ext)}\\b`, "i") : null;
      const hasBadge = !!extBadgePattern?.test(after);
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

  function isElementVisible(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function isComposerArea(el) {
    if (!el || !el.querySelector) return false;
    return !!el.querySelector("textarea, [contenteditable='true'], [data-testid*='prompt']");
  }

  function detectThemeFromDom() {
    const attrKeys = ["data-theme", "data-color-mode", "data-color-scheme"];
    const els = [document.documentElement, document.body];
    for (const el of els) {
      if (!el) continue;
      for (const key of attrKeys) {
        const val = el.getAttribute?.(key);
        if (val) {
          const v = String(val).toLowerCase();
          if (v.includes("dark")) return "dark";
          if (v.includes("light")) return "light";
        }
      }
      const cls = el.className || "";
      if (/\bdark\b/i.test(cls)) return "dark";
      if (/\blight\b/i.test(cls)) return "light";
    }
    return null;
  }

  function applyThemeFromDom() {
    const theme = detectThemeFromDom();
    if (theme) document.documentElement.setAttribute("data-cgx-theme", theme);
    else document.documentElement.removeAttribute("data-cgx-theme");
  }

  function isChatRoute(pathname = location.pathname) {
    return /^\/c\/[^/]+/.test(pathname);
  }

  function removeInjectedUI() {
    document.getElementById(SIDEBAR_ID)?.remove();
    document.getElementById("cgx-show-pill")?.remove();
    document.querySelectorAll(`.${EXT_NS}-toggle, .${EXT_NS}-toggle-wrap`).forEach((el) => el.remove());
  }

  function isLikelyMessageNode(node) {
    if (!node || (node.nodeType !== 1 && node.nodeType !== 11)) return false;
    const el = node;
    if (el.matches?.(LIKELY_MESSAGE_SELECTOR)) return true;
    return !!el.querySelector?.(LIKELY_MESSAGE_SELECTOR);
  }

  function mutationHasMessageChange(records) {
    for (const m of records) {
      if (m.type !== "childList") continue;
      if (m.addedNodes) {
        for (const node of m.addedNodes) {
          if (isLikelyMessageNode(node)) return true;
        }
      }
      if (m.removedNodes) {
        for (const node of m.removedNodes) {
          if (isLikelyMessageNode(node)) return true;
        }
      }
    }
    return false;
  }

  // Find message blocks: prefer role attribute, then article/group wrappers.
  function findAllMessageBlocks() {
    const roleNodes = document.querySelectorAll(MESSAGE_ROLE_SELECTOR);
    if (roleNodes?.length) return Array.from(roleNodes);

    // Alternative: ChatGPT sometimes wraps turns in articles; prefer turn/message IDs.
    const turns = document.querySelectorAll(`main ${TURN_SELECTOR}, main ${MESSAGE_ID_SELECTOR}`);
    if (turns?.length) return Array.from(turns);

    const candidates = document.querySelectorAll("main div, main article, main section");
    const blocks = [];
    for (const el of candidates) {
      if (isComposerArea(el)) continue;
      const txt = (el.textContent || "").trim();
      if (txt.length < 5) continue;
      const pCount = el.querySelectorAll("p").length;
      if (pCount === 0 && txt.length < 40) continue;
      const rect = el.getBoundingClientRect();
      if (rect.height < 20) continue;
      blocks.push(el);
    }
    return blocks;
  }

  function getRole(el) {
    const role =
      el.getAttribute?.("data-message-author-role") ||
      el.getAttribute?.("data-turn") ||
      el.closest?.("[data-turn]")?.getAttribute?.("data-turn");
    if (typeof role === "string" && role.length) return role;
    const t = (el.textContent || "").trim();
    const hasCopy = !!el.querySelector?.('button[aria-label*="Copy"], button[aria-label*="copy"]');
    if (/^you\b/i.test(t)) return "user";
    if (/chatgpt/i.test(t)) return "assistant";
    if (hasCopy && t.length > 80) return "assistant";
    return null;
  }

  function extractUserText(el, uploadedFiles) {
    const files = Array.isArray(uploadedFiles) ? uploadedFiles : extractUploadedFileNames(el);
    const txtWithoutAttachments = extractTextWithoutAttachmentNodes(el);
    if (!files.length) return txtWithoutAttachments;
    const cleanedPromptText = stripFileArtifactsFromText(txtWithoutAttachments, files);
    return bracketUploadedFileNames(cleanedPromptText, files);
  }

  function getCachedTitle(el) {
    const uploadedFiles = dedupeStrings([
      ...extractUploadedFileNames(el),
      ...extractAttachmentLikeFileNamesFromMessageText(el)
    ]);
    const raw = extractUserText(el, uploadedFiles);
    const baseTitle = textPreview(raw.split("\n").find(Boolean) || raw, 90);
    const title = normalizeAttachmentArtifactsInTitle(bracketStandaloneFileTitle(baseTitle) || "[Media]");
    const cached = el.getAttribute?.(`data-${EXT_NS}-title`);
    if (cached !== title) el.setAttribute?.(`data-${EXT_NS}-title`, title);
    return title;
  }

  function stableIdForElement(el, idx) {
    const existing = el.getAttribute(`data-${EXT_NS}-id`);
    if (existing) return existing;
    const dataId =
      el.getAttribute?.("data-message-id") ?? el.closest?.("[data-message-id]")?.getAttribute?.("data-message-id");
    const turnId = el.getAttribute?.("data-turn-id") ?? el.closest?.("[data-turn-id]")?.getAttribute?.("data-turn-id");
    const base = dataId || turnId || `${idx.toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
    const id = `${EXT_NS}_${base}`;
    el.setAttribute(`data-${EXT_NS}-id`, id);
    return id;
  }

  function ensureSidebar() {
    let sb = document.getElementById(SIDEBAR_ID);
    if (sb) {
      syncHiddenByDefaultToggle(sb);
      return sb;
    }

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
    search.addEventListener("input", () => {
      const q = (search.value || "").trim().toLowerCase();
      renderList(currentIndex, q);
      lastRenderedFilter = q;
    });

    // Refresh
    sb.querySelector("#cgx-refresh").addEventListener("click", () => scanAndRender());

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
      chrome.storage.local.get([key], (res) => resolve(res[key] || { collapsed: {} }));
    });
  }

  async function saveState(state) {
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
  let stateCache = { collapsed: {} };

  function isCollapsed(messageId) {
    return !!stateCache.collapsed?.[messageId];
  }

  function setCollapsed(messageId, value) {
    stateCache.collapsed = stateCache.collapsed || {};
    if (value) stateCache.collapsed[messageId] = true;
    else delete stateCache.collapsed[messageId];
    saveState(stateCache);
  }

  function findAssistantContentContainer(blockEl) {
    if (!blockEl) return null;
    if (isComposerArea(blockEl)) return null;
    const md = blockEl.querySelector?.(".markdown, [class*='markdown'], [class*='prose']");
    if (md && !isComposerArea(md)) return md;
    const textBlock =
      blockEl.querySelector?.("[data-message-author-role='assistant']") ||
      blockEl.querySelector?.("[class*='text']");
    if (textBlock && textBlock !== blockEl && !isComposerArea(textBlock)) return textBlock;
    const leaf = blockEl.querySelector?.("p, pre, code, li");
    if (leaf) {
      const closest = leaf.closest?.("div, article, section") || leaf;
      if (!isComposerArea(closest)) return closest;
    }
    const tag = blockEl.tagName?.toUpperCase?.();
    if (blockEl.getAttribute?.("data-message-author-role") === "assistant" && tag && !["BODY", "HTML", "MAIN"].includes(tag)) {
      return blockEl;
    }
    return null;
  }

  function injectToggleForAssistant(blockEl, messageId) {
    const content = findAssistantContentContainer(blockEl);
    if (!content || isComposerArea(content)) return null;

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
      const collapsed = isCollapsed(messageId);
      if (collapsed) content.classList.add("cgx-collapsed");
      else content.classList.remove("cgx-collapsed");
      btn.innerHTML = collapsed ? EXPAND_SVG : COLLAPSE_SVG;
      btn.setAttribute("aria-label", collapsed ? "Expand" : "Collapse");
      btn.setAttribute("title", collapsed ? "Expand" : "Collapse");
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
        const targetContent = findAssistantContentContainer(targetEl);
        if (!targetContent) return;
        const next = !isCollapsed(targetId);
        setCollapsed(targetId, next);
        if (next) targetContent.classList.add("cgx-collapsed");
        else targetContent.classList.remove("cgx-collapsed");
        btn.innerHTML = next ? EXPAND_SVG : COLLAPSE_SVG;
        btn.setAttribute("aria-label", next ? "Expand" : "Collapse");
        btn.setAttribute("title", next ? "Expand" : "Collapse");
      });
    }

    apply();
    return btn;
  }

  async function setAllAssistantCollapsed(value) {
    const blocks = findAllMessageBlocks();
    let changed = false;

    for (let i = 0; i < blocks.length; i++) {
      const el = blocks[i];
      const role = getRole(el);
      if (isComposerArea(el)) continue;
      if (role !== "assistant") continue;
      const id = stableIdForElement(el, i);
      if (value && !isCollapsed(id)) {
        stateCache.collapsed[id] = true;
        changed = true;
      } else if (!value && isCollapsed(id)) {
        delete stateCache.collapsed[id];
        changed = true;
      }
      // Apply immediately
      injectToggleForAssistant(el, id);
      const content = findAssistantContentContainer(el);
      if (!content) continue;
      if (value) content.classList.add("cgx-collapsed");
      else content.classList.remove("cgx-collapsed");
    }

    if (changed) await saveState(stateCache);
  }

  // ---------- Sidebar index ----------
  let currentIndex = []; // {id, el, title, idx}
  let lastRenderedFilter = "";

  function isSameIndex(prev, next) {
    if (prev.length !== next.length) return false;
    for (let i = 0; i < next.length; i++) {
      if (prev[i].id !== next[i].id) return false;
      if (prev[i].title !== next[i].title) return false;
    }
    return true;
  }

  function renderList(indexItems, filterLower) {
    const sb = ensureSidebar();
    const list = sb.querySelector("#cgx-list");
    list.innerHTML = "";

    const items = (indexItems || []).filter((it) => {
      if (!filterLower) return true;
      return (it.title || "").toLowerCase().includes(filterLower);
    });

    if (!items.length) {
      const div = document.createElement("div");
      div.className = "cgx-muted";
      div.textContent = "No questions found.";
      list.appendChild(div);
      return;
    }

    const fragment = document.createDocumentFragment();
    for (const it of items) {
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
      card.addEventListener("click", () => {
        if (!it.el || !document.contains(it.el)) {
          scanAndRender();
          return;
        }
        it.el.scrollIntoView({ behavior: "smooth", block: "start" });
        it.el.classList.remove("cgx-highlight");
        void it.el.offsetWidth;
        it.el.classList.add("cgx-highlight");
        setTimeout(() => it.el?.classList?.remove("cgx-highlight"), 1300);

        const blocks = findAllMessageBlocks();
        const idx = blocks.indexOf(it.el);
        if (idx >= 0 && blocks[idx + 1]) {
          const next = blocks[idx + 1];
          if (getRole(next) === "assistant") {
            const nextId = next.getAttribute?.(`data-${EXT_NS}-id`);
            if (nextId && isCollapsed(nextId)) {
              stateCache.collapsed = stateCache.collapsed || {};
              delete stateCache.collapsed[nextId];
              saveState(stateCache);
              const content = findAssistantContentContainer(next);
              content?.classList?.remove("cgx-collapsed");
              const toggleBtn = next.querySelector?.(`.${EXT_NS}-toggle`);
              if (toggleBtn) {
                toggleBtn.innerHTML = COLLAPSE_SVG;
                toggleBtn.setAttribute("aria-label", "Collapse");
                toggleBtn.setAttribute("title", "Collapse");
              }
            }
          }
        }
      });
      fragment.appendChild(card);
    }
    list.appendChild(fragment);
  }

  function getRoleNodesFast() {
    const userNodes = document.querySelectorAll("[data-message-author-role='user']");
    const assistantNodes = document.querySelectorAll("[data-message-author-role='assistant']");
    if (!userNodes.length && !assistantNodes.length) return null;
    return { userNodes, assistantNodes };
  }

  function scanIndexFast(userNodes, assistantNodes) {
    const index = [];
    let userCount = 0;

    for (let i = 0; i < assistantNodes.length; i++) {
      const el = assistantNodes[i];
      if (isComposerArea(el)) continue;
      const id = stableIdForElement(el, i);
      const existing = el.querySelector?.(`button.${EXT_NS}-toggle`);
      if (!existing || existing.dataset?.cgxBound !== "1") {
        injectToggleForAssistant(el, id);
      }
    }

    for (let i = 0; i < userNodes.length; i++) {
      const el = userNodes[i];
      if (isComposerArea(el)) continue;
      userCount++;
      const id = stableIdForElement(el, i);
      const title = getCachedTitle(el);
      index.push({
        id,
        el,
        title: title || "[Media]",
        idx: userCount,
        anchorHint: ""
      });
    }

    return index;
  }

  function scanIndexFallback() {
    const blocks = findAllMessageBlocks();
    const index = [];
    let userCount = 0;
    const keepToggles = new Set();

    for (let i = 0; i < blocks.length; i++) {
      const el = blocks[i];
      const role = getRole(el);
      if (isComposerArea(el)) continue;

      if (role === "assistant") {
        const id = stableIdForElement(el, i);
        const btn = injectToggleForAssistant(el, id);
        if (btn) keepToggles.add(btn);
        continue;
      }

      if (role !== "user") continue;
      if (!isElementVisible(el)) continue;

      userCount++;
      const id = stableIdForElement(el, i);
      const title = getCachedTitle(el);
      index.push({
        id,
        el,
        title: title || "[Media]",
        idx: userCount,
        anchorHint: ""
      });
    }
    document.querySelectorAll(`.${EXT_NS}-toggle`).forEach((btn) => {
      if (!keepToggles.has(btn)) btn.remove();
    });
    document.querySelectorAll(`.${EXT_NS}-toggle-wrap`).forEach((wrap) => {
      const btn = wrap.querySelector?.(`.${EXT_NS}-toggle`);
      if (!btn || !keepToggles.has(btn)) wrap.remove();
    });
    return index;
  }

  function scanIndex() {
    const roleNodes = getRoleNodesFast();
    if (roleNodes) return scanIndexFast(roleNodes.userNodes, roleNodes.assistantNodes);
    return scanIndexFallback();
  }

  async function scanAndRender() {
    if (!isChatRoute()) return;
    const nextIndex = scanIndex();
    const changed = !isSameIndex(currentIndex, nextIndex);
    currentIndex = nextIndex;
    const sb = ensureSidebar();
    const q = (sb.querySelector("#cgx-search").value || "").trim().toLowerCase();
    if (changed || q !== lastRenderedFilter) {
      renderList(currentIndex, q);
      lastRenderedFilter = q;
    }
  }

  // ---------- Observe & init ----------
  let debounceTimer = null;
  let idleHandle = null;
  function scheduleScan() {
    if (!isChatRoute()) return;
    if (observeTarget && !document.contains(observeTarget)) startObserver();
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
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
    }, DEBOUNCE_MS);
  }

  let mo = null;
  let observeTarget = null;
  let lastPath = "";
  let routeEpoch = 0;

  function clearScheduledScan() {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    if (idleHandle && window.cancelIdleCallback) {
      cancelIdleCallback(idleHandle);
      idleHandle = null;
    }
  }

  function startObserver() {
    const nextTarget = document.querySelector("main") || document.body;
    if (mo && observeTarget === nextTarget) return;
    stopObserver();
    observeTarget = nextTarget;
    mo = new MutationObserver((records) => {
      if (!mutationHasMessageChange(records)) return;
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
    currentIndex = [];
    lastRenderedFilter = "";
    ensureSidebar();
    applySidebarDefaultVisibility();
    startObserver();

    const loadedState = await loadState();
    if (epoch !== routeEpoch || !isChatRoute()) return;
    stateCache = loadedState || { collapsed: {} };
    stateCache.collapsed = stateCache.collapsed || {};
    await scanAndRender();
  }

  function deactivateForNonChat() {
    stopObserver();
    removeInjectedUI();
    currentIndex = [];
    lastRenderedFilter = "";
  }

  async function handleRouteChange() {
    const path = location.pathname || "";
    if (path === lastPath) return;
    const epoch = ++routeEpoch;
    lastPath = path;
    if (isChatRoute(path)) {
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

  function applyFastNavIntent(path) {
    if (!path || path === location.pathname) return;
    if (isChatRoute(path)) {
      ensureSidebar();
      applySidebarDefaultVisibility();
      return;
    }
    deactivateForNonChat();
  }

  function installRouteListeners() {
    if (window.__cgxRouteHooked) return;
    window.__cgxRouteHooked = true;
    const notify = () => window.dispatchEvent(new Event("cgx:locationchange"));
    const wrap = (fn) =>
      function (...args) {
        const ret = fn.apply(this, args);
        notify();
        return ret;
      };
    if (history?.pushState) history.pushState = wrap(history.pushState);
    if (history?.replaceState) history.replaceState = wrap(history.replaceState);
    window.addEventListener("popstate", notify);
    window.addEventListener("hashchange", notify);
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
      true
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
    setInterval(handleRouteChange, 800);

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

  setTimeout(init, 600);
})();
