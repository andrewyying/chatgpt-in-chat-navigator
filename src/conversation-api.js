/**
 * Reads the open conversation from ChatGPT's own backend.
 *
 * Scraping the DOM can only ever see the turns ChatGPT has mounted, which is a
 * sliding window over long threads. This asks the site for the conversation
 * directly — the same endpoint the page itself uses, on the same origin, with
 * the session already in the browser — so the sidebar can list every prompt
 * immediately instead of waiting for turns to scroll into existence.
 *
 * Nothing leaves the browser: the only hosts touched are chatgpt.com's own.
 * Every failure path returns null so the caller silently falls back to reading
 * the DOM.
 */
var CGXApi = (function () {
  "use strict";

  const SESSION_URL = "/api/auth/session";
  const CONVERSATION_URL = "/backend-api/conversation/";
  const TOKEN_TTL_MS = 15 * 60 * 1000;
  const REQUEST_TIMEOUT_MS = 8000;

  let tokenCache = { value: null, fetchedAt: 0 };

  function conversationIdFromPath(pathname) {
    const path = pathname == null ? location.pathname : pathname;
    const m = /\/c\/([^/?#]+)/.exec(path);
    return m ? m[1] : null;
  }

  // One controller that trips on either the caller's abort or our timeout.
  function linkedSignal(external, ms) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    if (external) {
      if (external.aborted) ctrl.abort();
      else external.addEventListener("abort", () => ctrl.abort(), { once: true });
    }
    return { signal: ctrl.signal, done: () => clearTimeout(timer) };
  }

  async function getJson(url, { signal, headers } = {}) {
    const link = linkedSignal(signal, REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        credentials: "include",
        headers: { accept: "application/json", ...(headers || {}) },
        signal: link.signal
      });
      if (!res.ok) return { ok: false, status: res.status, data: null };
      return { ok: true, status: res.status, data: await res.json() };
    } catch {
      return { ok: false, status: 0, data: null };
    } finally {
      link.done();
    }
  }

  async function getAccessToken(signal, force) {
    const fresh = !force && tokenCache.value && Date.now() - tokenCache.fetchedAt < TOKEN_TTL_MS;
    if (fresh) return tokenCache.value;
    const { ok, data } = await getJson(SESSION_URL, { signal });
    const token = ok && data && typeof data.accessToken === "string" ? data.accessToken : null;
    tokenCache = { value: token, fetchedAt: Date.now() };
    return token;
  }

  function textFromMessage(message) {
    const content = message?.content;
    if (!content) return "";
    const parts = Array.isArray(content.parts) ? content.parts : [];
    // multimodal_text mixes plain strings with image/file pointer objects.
    const text = parts.filter((p) => typeof p === "string").join("\n").trim();
    if (text) return text;
    if (typeof content.text === "string") return content.text.trim();
    return "";
  }

  function attachmentsFromMessage(message) {
    const raw = message?.metadata?.attachments;
    if (!Array.isArray(raw)) return [];
    return raw.map((a) => (typeof a === "string" ? a : a?.name)).filter((n) => typeof n === "string" && n.trim());
  }

  function countNonTextParts(message) {
    const parts = message?.content?.parts;
    if (!Array.isArray(parts)) return 0;
    return parts.filter((p) => p && typeof p === "object").length;
  }

  // ChatGPT keeps system prompts, custom instructions and tool traffic in the
  // same mapping as real turns. Only things the user would recognise as a
  // message in the thread should reach the sidebar.
  function isVisibleTurn(message) {
    if (!message) return false;
    const role = message.author?.role;
    if (role !== "user" && role !== "assistant") return false;
    if (message.metadata?.is_visually_hidden_from_conversation) return false;
    const type = message.content?.content_type;
    if (type === "user_editable_context" || type === "system_error") return false;
    if (role === "user" && !textFromMessage(message) && !attachmentsFromMessage(message).length && !countNonTextParts(message)) {
      return false;
    }
    return true;
  }

  /**
   * Fetch the conversation and return the messages on the branch the user is
   * actually looking at, oldest first.
   *
   * Walking back from `current_node` is what makes edited prompts behave:
   * abandoned branches simply aren't on the path, so they never get listed.
   *
   * Resolves to null on any failure — caller falls back to the DOM.
   */
  async function fetchConversation(conversationId, signal) {
    const id = conversationId || conversationIdFromPath();
    if (!id) return null;

    let token = await getAccessToken(signal);
    let res = await getJson(CONVERSATION_URL + encodeURIComponent(id), {
      signal,
      headers: token ? { Authorization: `Bearer ${token}` } : undefined
    });

    // A cached token that expired mid-session looks exactly like a logged-out
    // user; retry once with a fresh one before giving up.
    if (!res.ok && (res.status === 401 || res.status === 403)) {
      token = await getAccessToken(signal, true);
      if (token) {
        res = await getJson(CONVERSATION_URL + encodeURIComponent(id), {
          signal,
          headers: { Authorization: `Bearer ${token}` }
        });
      }
    }

    if (!res.ok || !res.data) return null;

    const mapping = res.data.mapping;
    if (!mapping || typeof mapping !== "object") return null;

    const branch = [];
    let cursor = res.data.current_node;
    const guard = new Set();
    while (cursor && mapping[cursor] && !guard.has(cursor)) {
      guard.add(cursor);
      branch.push(mapping[cursor]);
      cursor = mapping[cursor].parent;
    }
    branch.reverse();
    if (!branch.length) return null;

    const messages = [];
    const order = new Map();
    for (const node of branch) {
      const message = node?.message;
      if (!isVisibleTurn(message)) continue;
      const messageId = message.id || node.id;
      if (!messageId) continue;
      const index = messages.length;
      order.set(messageId, index);
      messages.push({
        id: messageId,
        index,
        role: message.author.role,
        text: textFromMessage(message),
        attachments: attachmentsFromMessage(message),
        mediaCount: countNonTextParts(message)
      });
    }
    if (!messages.length) return null;

    return { conversationId: id, messages, order, title: typeof res.data.title === "string" ? res.data.title : "" };
  }

  function resetTokenCache() {
    tokenCache = { value: null, fetchedAt: 0 };
  }

  return { conversationIdFromPath, fetchConversation, resetTokenCache };
})();

if (typeof module !== "undefined" && module.exports) module.exports = CGXApi;
