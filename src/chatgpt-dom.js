/**
 * ChatGPT DOM adapter.
 *
 * Every selector that knows something about ChatGPT's markup lives in this
 * file. When ChatGPT ships a UI revision this should be the only file that
 * needs editing: put the new shape at the front of the relevant cascade and
 * leave the old entries behind as fallbacks.
 *
 * Nothing here touches the sidebar or extension state — it only answers
 * questions about the page: where are the turns, who wrote each one, what
 * order do they go in, and which part of an answer is collapsible.
 */
var CGXDom = (function () {
  "use strict";

  const ROLE_USER = "user";
  const ROLE_ASSISTANT = "assistant";

  // ---------- Selector inventory ----------

  // Markers that identify an assistant answer body. Ordered most- to
  // least-specific; the first hit wins when picking a collapse target.
  const ASSISTANT_CONTENT_CASCADE = [
    ".markdown",
    "[data-message-content]",
    "[data-testid='markdown-content']",
    "[class*='markdown']",
    "[class*='prose']"
  ];

  // Buttons that only ever appear on an assistant turn.
  const ASSISTANT_ACTION_SELECTOR = [
    // Only answers record which model produced them.
    "[data-message-model-slug]",
    "[data-testid='good-response-turn-action-button']",
    "[data-testid='bad-response-turn-action-button']",
    "[data-testid='voice-play-turn-action-button']",
    "button[aria-label*='Read aloud' i]",
    "button[aria-label*='Good response' i]",
    "button[aria-label*='Bad response' i]",
    "button[aria-label*='Switch model' i]"
  ].join(", ");

  // Markers that only ever appear on a user turn.
  const USER_BUBBLE_SELECTOR = [
    "[data-testid='user-message']",
    "[data-message-author-role='user']",
    "[class*='user-message-bubble']",
    "button[aria-label*='Edit message' i]",
    "[data-testid='edit-message-button']"
  ].join(", ");

  // Nodes that represent a file the user attached, rather than prose they
  // typed. Used to keep attachment chrome out of sidebar titles.
  const ATTACHMENT_SELECTOR = [
    "a[download]",
    "a[href*='/files/']",
    "a[href^='sandbox:']",
    "[data-testid*='attachment']",
    "[data-testid*='file']",
    "[aria-label*='attachment' i]",
    "[aria-label*='file' i]"
  ].join(", ");

  // Parts that belong to the message composer specifically.
  const COMPOSER_ROOT_SELECTOR = [
    "#prompt-textarea",
    "form[data-type='unified-composer']",
    "[data-testid='send-button']",
    "[data-testid='composer-speech-button']",
    "[data-testid*='prompt-textarea']"
  ].join(", ");

  // Weaker signal, used only once the specific markers above have all missed.
  const EDITABLE_SELECTOR = "textarea, [contenteditable='true'], [data-testid*='prompt']";

  // Anything that marks an element as living inside a conversation turn.
  const TURN_HOST_SELECTOR = [
    "[data-message-author-role]",
    "[data-message-id]",
    "[data-turn-id]",
    "[data-turn-id-container]",
    "[data-turn='user']",
    "[data-turn='assistant']",
    "[data-testid^='conversation-turn-']"
  ].join(", ");

  // Block-level tags used to locate an answer body when no class/attribute
  // marker matches — the common ancestor of these is the readable content.
  const BLOCK_CHILD_SELECTOR = "p, pre, ul, ol, table, blockquote, h1, h2, h3, h4, h5, h6";

  // Deliberately broad: this only decides whether a DOM mutation is worth a
  // (debounced) rescan, so a false positive costs far less than a miss.
  const MESSAGE_HINT_ATTRS = [
    "data-message-author-role",
    "data-message-id",
    "data-turn-id",
    // Wrapper ChatGPT mounts/unmounts turns inside, paired with
    // data-is-intersecting. Watching it catches virtualisation churn.
    "data-turn-id-container",
    "data-turn"
  ];
  const MESSAGE_HINT_SELECTOR = [
    ...MESSAGE_HINT_ATTRS.map((a) => `[${a}]`),
    "[data-testid^='conversation-turn-']",
    "article"
  ].join(", ");

  // ---------- Small helpers ----------

  const composerCache = new WeakMap();

  /**
   * Is this element part of the message composer (as opposed to a message)?
   *
   * Presence of a textarea is not enough to decide: editing a prompt swaps the
   * bubble for a textarea *inside the turn*, and treating that as composer
   * chrome makes the question disappear from the sidebar while it is being
   * edited. So anything sitting inside a conversation turn is never the
   * composer, however editable it looks.
   */
  function isComposer(el) {
    if (!el || !el.querySelector) return false;
    const cached = composerCache.get(el);
    if (cached !== undefined) return cached;

    let result;
    if (el.closest?.(TURN_HOST_SELECTOR)) {
      result = false;
    } else if (el.matches?.(COMPOSER_ROOT_SELECTOR) || el.querySelector(COMPOSER_ROOT_SELECTOR)) {
      result = true;
    } else {
      result = !!(el.matches?.(EDITABLE_SELECTOR) || el.querySelector(EDITABLE_SELECTOR));
    }

    composerCache.set(el, result);
    return result;
  }

  function conversationRoot() {
    return document.querySelector("main") || document.body;
  }

  function isChatRoute(pathname) {
    const path = pathname == null ? location.pathname : pathname;
    // Standalone chats (/c/<id>) and chats inside a project or GPT
    // (/g/<slug>/c/<id>, /project/<id>/c/<id>) all contain a /c/ segment.
    return /\/c\/[^/]+/.test(path);
  }

  function intFromAttr(el, name) {
    const raw = el?.getAttribute?.(name);
    if (raw == null || raw === "") return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }

  // ---------- Role detection ----------

  function normalizeRole(value) {
    if (typeof value !== "string") return null;
    const v = value.trim().toLowerCase();
    if (v === ROLE_USER || v === "human") return ROLE_USER;
    if (v === ROLE_ASSISTANT || v === "bot" || v === "gpt" || v === "ai") return ROLE_ASSISTANT;
    return null;
  }

  // Work out who wrote a turn when the wrapper itself carries no role
  // attribute. Explicit markers first, then structural tells, so a renamed
  // wrapper still resolves as long as *something* inside it is recognisable.
  function inferRole(el) {
    if (!el || el.nodeType !== 1) return null;

    const direct =
      normalizeRole(el.getAttribute?.("data-message-author-role")) ||
      normalizeRole(el.getAttribute?.("data-turn")) ||
      normalizeRole(el.getAttribute?.("data-author-role")) ||
      normalizeRole(el.getAttribute?.("data-role"));
    if (direct) return direct;

    const inner = el.querySelector?.("[data-message-author-role], [data-turn='user'], [data-turn='assistant']");
    if (inner) {
      const innerRole =
        normalizeRole(inner.getAttribute("data-message-author-role")) || normalizeRole(inner.getAttribute("data-turn"));
      if (innerRole) return innerRole;
    }

    // Definitive per-role controls beat content sniffing: an assistant answer
    // can quote a user message and vice versa, but the action rows don't move.
    if (el.querySelector?.(ASSISTANT_ACTION_SELECTOR)) return ROLE_ASSISTANT;
    if (el.querySelector?.(USER_BUBBLE_SELECTOR)) return ROLE_USER;

    for (const sel of ASSISTANT_CONTENT_CASCADE) {
      if (el.querySelector?.(sel)) return ROLE_ASSISTANT;
    }
    return null;
  }

  // Fill in unknown roles by alternation. ChatGPT strictly alternates
  // user/assistant, so one recognised turn is enough to label its neighbours.
  function fillRolesByAlternation(turns) {
    if (!turns.length) return turns;
    const firstKnown = turns.findIndex((t) => t.role);
    if (firstKnown === -1) {
      // Nothing recognisable at all — conversations always open with a user
      // turn, so index parity is the best available guess.
      for (let i = 0; i < turns.length; i++) turns[i].role = i % 2 === 0 ? ROLE_USER : ROLE_ASSISTANT;
      return turns;
    }
    for (let i = firstKnown - 1; i >= 0; i--) {
      turns[i].role = turns[i + 1].role === ROLE_USER ? ROLE_ASSISTANT : ROLE_USER;
    }
    for (let i = firstKnown + 1; i < turns.length; i++) {
      if (turns[i].role) continue;
      turns[i].role = turns[i - 1].role === ROLE_USER ? ROLE_ASSISTANT : ROLE_USER;
    }
    return turns;
  }

  // ---------- Turn discovery ----------

  function queryIn(selector) {
    return conversationRoot().querySelectorAll(selector);
  }

  // Drop nodes nested inside another matched node, so a wrapper and the
  // message inside it don't both count as turns.
  //
  // querySelectorAll returns document order, which makes this a single pass:
  // if some kept node is an ancestor of `el`, it has to be the most recently
  // kept one. Anything earlier either already closed before `el` or contains
  // the most recent keep too, in which case that keep was itself skipped.
  function dropNestedMatches(nodes) {
    const list = Array.from(nodes);
    if (list.length < 2) return list;
    const out = [];
    for (const el of list) {
      const last = out[out.length - 1];
      if (last && last.contains(el)) continue;
      out.push(el);
    }
    return out;
  }

  function heuristicTurnNodes() {
    // Last resort: find the repeated sibling group under the chat area that
    // carries most of the text. Virtualised lists still render their window as
    // siblings, so this holds even when every attribute we know is gone.
    const root = conversationRoot();
    const groups = new Map();
    for (const el of root.querySelectorAll("article, section, div")) {
      const parent = el.parentElement;
      if (!parent || isComposer(el)) continue;
      const text = (el.textContent || "").trim();
      if (text.length < 20) continue;
      if (el.offsetHeight < 20) continue;
      let group = groups.get(parent);
      if (!group) {
        group = [];
        groups.set(parent, group);
      }
      group.push(el);
    }
    let best = null;
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      if (!best || group.length > best.length) best = group;
    }
    return best || [];
  }

  // Ordered cascade of ways to find conversation turns. `probe` runs cheaply
  // and the first strategy that yields usable turns is remembered.
  const TURN_STRATEGIES = [
    { name: "author-role", select: () => document.querySelectorAll("[data-message-author-role]") },
    { name: "turn-attr", select: () => document.querySelectorAll("[data-turn='user'], [data-turn='assistant']") },
    // Deliberately tag-agnostic. This used to be pinned to `article`, and
    // broke in Aug 2026 when ChatGPT re-tagged the turn wrapper as `section`
    // while keeping the test id identical.
    { name: "testid-turn", select: () => document.querySelectorAll("[data-testid^='conversation-turn-']") },
    { name: "turn-id", select: () => document.querySelectorAll("[data-turn-id]") },
    { name: "message-id", select: () => document.querySelectorAll("[data-message-id]") },
    { name: "turn-wrapper", select: () => queryIn("[data-turn-id-container]") },
    { name: "article", select: () => queryIn("article, section") },
    { name: "aria-listitem", select: () => queryIn("[role='listitem'], [role='article']") },
    // Only this last resort is allowed to label turns purely by alternation.
    // Everything above it must recognise at least one author, so that a
    // selector accidentally matching page chrome is rejected rather than
    // listed as questions.
    { name: "heuristic", select: heuristicTurnNodes, allowAlternationOnly: true, minTurns: 4 }
  ];

  let activeStrategy = null;

  function buildTurns(nodes) {
    const turns = [];
    for (const el of dropNestedMatches(nodes)) {
      if (isComposer(el)) continue;
      turns.push({ el, role: inferRole(el) });
    }
    return turns;
  }

  function strategyIsUsable(strategy, turns) {
    if (turns.length < (strategy.minTurns || 1)) return false;
    if (turns.some((t) => t.role === ROLE_USER || t.role === ROLE_ASSISTANT)) return true;
    // Nothing named an author. Only the alternation-only fallback may proceed
    // on that basis; for every other strategy it means we matched layout
    // chrome rather than messages.
    return !!strategy.allowAlternationOnly;
  }

  /**
   * Find every mounted conversation turn, in document order.
   * Returns { strategy, turns: [{el, role}], user: [el], assistant: [el] }.
   */
  function scanTurns() {
    const ordered = activeStrategy
      ? [activeStrategy, ...TURN_STRATEGIES.filter((s) => s !== activeStrategy)]
      : TURN_STRATEGIES;

    for (const strategy of ordered) {
      let nodes = null;
      try {
        nodes = strategy.select();
      } catch {
        continue;
      }
      if (!nodes || !nodes.length) continue;
      const turns = buildTurns(nodes);
      if (!strategyIsUsable(strategy, turns)) continue;

      activeStrategy = strategy;
      fillRolesByAlternation(turns);
      const user = [];
      const assistant = [];
      for (const t of turns) {
        if (t.role === ROLE_USER) user.push(t.el);
        else if (t.role === ROLE_ASSISTANT) assistant.push(t.el);
      }
      return { strategy: strategy.name, turns, user, assistant };
    }

    activeStrategy = null;
    return { strategy: null, turns: [], user: [], assistant: [] };
  }

  function resetStrategy() {
    activeStrategy = null;
  }

  function currentStrategy() {
    return activeStrategy?.name || null;
  }

  // ---------- Absolute ordering ----------

  // ChatGPT windows long conversations, so a turn's position in the DOM only
  // describes the mounted slice. These attributes carry an absolute position
  // that survives unmounting; `null` means the caller has to fall back to
  // relative ordering.
  function turnNumber(el) {
    if (!el) return null;

    const testIdHost = el.closest?.("[data-testid^='conversation-turn-']");
    const testId = testIdHost?.getAttribute?.("data-testid");
    if (testId) {
      const n = Number(testId.slice("conversation-turn-".length));
      if (Number.isFinite(n)) return n;
    }

    for (const name of ["aria-posinset", "data-turn-index", "data-message-index", "data-index"]) {
      const host = el.closest?.(`[${name}]`);
      const n = intFromAttr(host, name);
      if (n != null) return n;
    }
    return null;
  }

  // A value that identifies a turn across re-mounts, used to key saved
  // collapse state. Falls back to null so the caller can mint its own id.
  function stableKey(el) {
    if (!el) return null;
    for (const name of ["data-message-id", "data-turn-id"]) {
      const own = el.getAttribute?.(name);
      if (own) return own;
      const host = el.closest?.(`[${name}]`);
      const inherited = host?.getAttribute?.(name);
      if (inherited) return inherited;
    }
    return null;
  }

  // ---------- Assistant content ----------

  function commonBlockAncestor(root) {
    const blocks = root.querySelectorAll?.(BLOCK_CHILD_SELECTOR);
    if (!blocks || !blocks.length) return null;
    let ancestor = blocks[0].parentElement;
    for (let i = 1; i < blocks.length && ancestor; i++) {
      while (ancestor && !ancestor.contains(blocks[i])) ancestor = ancestor.parentElement;
    }
    if (!ancestor || !root.contains(ancestor)) return null;
    return ancestor;
  }

  /**
   * The part of an assistant turn that should collapse. Prefers a tagged
   * markdown body, then the common ancestor of the answer's block elements,
   * then the turn itself.
   */
  function assistantContent(blockEl) {
    if (!blockEl || isComposer(blockEl)) return null;

    for (const sel of ASSISTANT_CONTENT_CASCADE) {
      const found = blockEl.matches?.(sel) ? blockEl : blockEl.querySelector?.(sel);
      if (found && !isComposer(found)) return found;
    }

    const grouped = commonBlockAncestor(blockEl);
    if (grouped && !isComposer(grouped)) return grouped;

    const tag = blockEl.tagName?.toUpperCase?.();
    if (tag && !["BODY", "HTML", "MAIN"].includes(tag)) return blockEl;
    return null;
  }

  // ---------- Mutation triage ----------

  function looksLikeMessage(node) {
    if (!node || node.nodeType !== 1) return false;
    for (const attr of MESSAGE_HINT_ATTRS) {
      if (node.hasAttribute(attr)) return true;
    }
    const testId = node.getAttribute("data-testid");
    if (typeof testId === "string" && testId.startsWith("conversation-turn-")) return true;
    return node.tagName === "ARTICLE";
  }

  function containsMessage(node) {
    if (looksLikeMessage(node)) return true;
    if (node?.nodeType !== 1 || !node.childElementCount) return false;
    return !!node.querySelector?.(MESSAGE_HINT_SELECTOR);
  }

  // ---------- Theme ----------

  function detectTheme() {
    const attrKeys = ["data-theme", "data-color-mode", "data-color-scheme"];
    for (const el of [document.documentElement, document.body]) {
      if (!el) continue;
      for (const key of attrKeys) {
        const val = el.getAttribute?.(key);
        if (!val) continue;
        const v = String(val).toLowerCase();
        if (v.includes("dark")) return "dark";
        if (v.includes("light")) return "light";
      }
      const cls = typeof el.className === "string" ? el.className : "";
      if (/\bdark\b/i.test(cls)) return "dark";
      if (/\blight\b/i.test(cls)) return "light";
    }
    return null;
  }

  return {
    ROLE_USER,
    ROLE_ASSISTANT,
    ASSISTANT_CONTENT_CASCADE,
    ATTACHMENT_SELECTOR,
    MESSAGE_HINT_SELECTOR,
    assistantContent,
    containsMessage,
    conversationRoot,
    currentStrategy,
    detectTheme,
    inferRole,
    isChatRoute,
    isComposer,
    looksLikeMessage,
    resetStrategy,
    scanTurns,
    stableKey,
    turnNumber
  };
})();

if (typeof module !== "undefined" && module.exports) module.exports = CGXDom;
