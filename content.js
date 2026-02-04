(() => {
  const EXT_NS = "cgx";
  const SIDEBAR_ID = "cgx-sidebar";
  const STORAGE_KEY_PREFIX = "cgx_state_v1";
  const DEBOUNCE_MS = 450;

  // ---------- Utilities ----------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function getConversationKey() {
    return `${STORAGE_KEY_PREFIX}:${location.host}${location.pathname}`;
  }

  function textPreview(s, max = 120) {
    if (!s) return "";
    const t = s.replace(/\s+/g, " ").trim();
    return t.length > max ? t.slice(0, max - 1) + "…" : t;
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

  function isChatRoute(pathname = location.pathname) {
    return /^\/c\/[^/]+/.test(pathname);
  }

  function removeInjectedUI() {
    document.getElementById(SIDEBAR_ID)?.remove();
    document.getElementById("cgx-show-pill")?.remove();
    document.querySelectorAll(`.${EXT_NS}-toggle, .${EXT_NS}-toggle-wrap`).forEach((el) => el.remove());
  }

  // Find message blocks: prefer role attribute, then article/group wrappers.
  function findAllMessageBlocks() {
    const roleNodes = document.querySelectorAll("[data-message-author-role]");
    if (roleNodes?.length) return Array.from(roleNodes);

    // Alternative: ChatGPT sometimes wraps in articles; use group or article as block.
    const articles = document.querySelectorAll("main article[class], main [data-message-id]");
    if (articles?.length) return Array.from(articles);

    const candidates = document.querySelectorAll("main div, main article, main section");
    const blocks = [];
    for (const el of candidates) {
      if (isComposerArea(el)) continue;
      const txt = (el.innerText || "").trim();
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
    const role = el.getAttribute?.("data-message-author-role");
    if (role === "user" || role === "assistant" || role === "system") return role;
    const t = (el.innerText || "").trim();
    const hasCopy = !!el.querySelector?.('button[aria-label*="Copy"], button[aria-label*="copy"]');
    if (/^you\b/i.test(t)) return "user";
    if (/chatgpt/i.test(t)) return "assistant";
    if (hasCopy && t.length > 80) return "assistant";
    return null;
  }

  function extractUserText(el) {
    // Try to get the direct textual content of the user message.
    // Prefer text from paragraphs; otherwise innerText.
    const txt = (el.innerText || "").trim();
    return txt;
  }

  function stableIdForElement(el, idx) {
    const existing = el.getAttribute(`data-${EXT_NS}-id`);
    if (existing) return existing;
    const dataId = el.getAttribute?.("data-message-id") ?? el.closest?.("[data-message-id]")?.getAttribute?.("data-message-id");
    const base = dataId || `${idx.toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
    const id = `${EXT_NS}_${base}`;
    el.setAttribute(`data-${EXT_NS}-id`, id);
    return id;
  }

  function ensureSidebar() {
    let sb = document.getElementById(SIDEBAR_ID);
    if (sb) return sb;

    sb = document.createElement("div");
    sb.id = SIDEBAR_ID;

    sb.innerHTML = `
      <div id="cgx-header">
        <div id="cgx-title-row">
          <div id="cgx-title"><span class="dot"></span> Chat index</div>
          <button class="cgx-btn" id="cgx-hide" title="Hide sidebar (Alt+N to show again)">Hide</button>
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

    // Hide button
    sb.querySelector("#cgx-hide").addEventListener("click", () => {
      sb.style.display = "none";
      ensureShowPill();
    });

    // Search filter
    const search = sb.querySelector("#cgx-search");
    search.addEventListener("input", () => {
      const q = (search.value || "").trim().toLowerCase();
      renderList(currentIndex, q);
    });

    // Refresh
    sb.querySelector("#cgx-refresh").addEventListener("click", () => scanAndRender());

    // Collapse/Expand all
    sb.querySelector("#cgx-collapse-all").addEventListener("click", () => setAllAssistantCollapsed(true));
    sb.querySelector("#cgx-expand-all").addEventListener("click", () => setAllAssistantCollapsed(false));

    return sb;
  }

  function ensureShowPill() {
    if (!isChatRoute()) return null;
    let pill = document.getElementById("cgx-show-pill");
    if (pill) return pill;

    pill = document.createElement("div");
    pill.id = "cgx-show-pill";
    pill.style.position = "fixed";
    pill.style.top = "48px";
    pill.style.right = "24px";
    pill.style.zIndex = "2147483647";
    pill.style.padding = "8px 10px";
    pill.style.borderRadius = "var(--cgx-radius)";
    pill.style.border = "1px solid rgba(0,0,0,0.12)";
    pill.style.background = "rgba(255,255,255,0.92)";
    pill.style.boxShadow = "0 10px 30px rgba(0,0,0,0.18)";
    pill.style.backdropFilter = "blur(10px)";
    pill.style.cursor = "pointer";
    pill.style.fontFamily =
      'ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, "Apple Color Emoji","Segoe UI Emoji"';
    pill.style.fontSize = "12px";
    pill.style.color = "rgba(0,0,0,0.86)";
    pill.textContent = "Show index";

    pill.addEventListener("click", () => {
      const sb = ensureSidebar();
      sb.style.display = "flex";
      pill.remove();
    });

    document.documentElement.appendChild(pill);
    return pill;
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

  // ---------- Collapse logic ----------
  let stateCache = { collapsed: {} };

  function isCollapsed(messageId) {
    return !!stateCache.collapsed?.[messageId];
  }

  async function setCollapsed(messageId, value) {
    stateCache.collapsed = stateCache.collapsed || {};
    if (value) stateCache.collapsed[messageId] = true;
    else delete stateCache.collapsed[messageId];
    await saveState(stateCache);
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
      btn.textContent = collapsed ? "Expand" : "Collapse";
    };

    if (!btn.dataset?.cgxBound) {
      btn.dataset.cgxBound = "1";
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const next = !isCollapsed(messageId);
        await setCollapsed(messageId, next);
        apply();
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

  function renderList(indexItems, filterLower) {
    const sb = ensureSidebar();
    const list = sb.querySelector("#cgx-list");
    const titleEl = sb.querySelector("#cgx-title");
    list.innerHTML = "";

    const items = (indexItems || []).filter((it) => {
      if (!filterLower) return true;
      return (it.title || "").toLowerCase().includes(filterLower);
    });

    if (titleEl) {
      const total = (indexItems || []).length;
      titleEl.innerHTML = total ? `<span class="dot"></span> Chat index <span class="cgx-count">(${total})</span>` : "<span class=\"dot\"></span> Chat index";
    }

    if (!items.length) {
      const div = document.createElement("div");
      div.className = "cgx-muted";
      div.textContent = "No questions found. Try \"Refresh\" after messages load.";
      list.appendChild(div);
      return;
    }

    for (const it of items) {
      const card = document.createElement("div");
      card.className = "cgx-item";
      card.innerHTML = `
        <div class="meta"><span>#${it.idx}</span><span>${it.anchorHint || ""}</span></div>
        <div class="q">${escapeHtml(it.title)}</div>
      `;
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
              if (toggleBtn) toggleBtn.textContent = "Collapse";
            }
          }
        }
      });
      list.appendChild(card);
    }
  }

  function escapeHtml(str) {
    return (str || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function scanIndex() {
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
      const raw = extractUserText(el);
      const title = textPreview(raw.split("\n").find(Boolean) || raw, 90);
      index.push({
        id,
        el,
        title: title || "(空)",
        idx: userCount,
        anchorHint: ""
      });
    }
    document.querySelectorAll(`.${EXT_NS}-toggle`).forEach((btn) => {
      if (!keepToggles.has(btn)) btn.remove();
    });
    return index;
  }

  async function scanAndRender() {
    if (!isChatRoute()) return;
    currentIndex = scanIndex();
    const sb = ensureSidebar();
    const q = (sb.querySelector("#cgx-search").value || "").trim().toLowerCase();
    renderList(currentIndex, q);
  }

  // ---------- Observe & init ----------
  let debounceTimer = null;
  function scheduleScan() {
    if (!isChatRoute()) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      scanAndRender();
    }, DEBOUNCE_MS);
  }

  let mo = null;
  let lastPath = "";

  function startObserver() {
    if (mo) return;
    const observeTarget = document.querySelector("main") || document.body;
    mo = new MutationObserver(() => scheduleScan());
    mo.observe(observeTarget, { childList: true, subtree: true });
  }

  function stopObserver() {
    if (mo) {
      mo.disconnect();
      mo = null;
    }
  }

  async function activateForChat() {
    stateCache = await loadState();
    stateCache.collapsed = stateCache.collapsed || {};
    ensureSidebar();
    await scanAndRender();
    startObserver();
  }

  function deactivateForNonChat() {
    stopObserver();
    removeInjectedUI();
  }

  async function handleRouteChange() {
    const path = location.pathname || "";
    if (path === lastPath) return;
    lastPath = path;
    if (isChatRoute(path)) {
      stopObserver();
      await activateForChat();
    } else {
      deactivateForNonChat();
    }
  }

  async function init() {
    await handleRouteChange();
    setInterval(handleRouteChange, 700);

    window.addEventListener("keydown", (e) => {
      if (e.altKey && e.key.toLowerCase() === "n") {
        e.preventDefault();
        if (!isChatRoute()) return;
        const sb = document.getElementById(SIDEBAR_ID);
        if (!sb) return;
        if (sb.style.display === "none") {
          sb.style.display = "flex";
          document.getElementById("cgx-show-pill")?.remove();
        } else {
          sb.style.display = "none";
          ensureShowPill();
        }
      }
    });
  }

  setTimeout(init, 600);
})();
