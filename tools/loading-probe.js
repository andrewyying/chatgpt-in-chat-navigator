/**
 * ChatGPT Navigator — loading / virtualisation probe
 *
 * Answers three questions the DOM probe couldn't:
 *   1. When ChatGPT unmounts a turn, does a placeholder stay behind?
 *      (Decides whether we can scroll to a prompt that isn't rendered.)
 *   2. What actually scrolls the thread?
 *   3. Can we read the full conversation from ChatGPT's own API instead of
 *      scraping the DOM?
 *
 * Run it on a LONG conversation (30+ turns), scrolled to the BOTTOM:
 *
 *     await cgxLoadingProbe()      // paste file, then run this
 *     copy(cgxLoadingReport)       // copies the result
 *
 * Structural only: counts, tag names, attribute names, and the *shape* of API
 * responses. No message text is included — string fields are reported as
 * `#text(<length>)`.
 */
(() => {
  function describe(el) {
    if (!el) return null;
    return {
      tag: el.tagName?.toLowerCase?.() || String(el),
      id: el.id || undefined,
      class: String(el.className || "").replace(/\s+/g, " ").trim().slice(0, 120) || undefined,
      attrs: Object.fromEntries(
        Array.from(el.attributes || [])
          .filter((a) => a.name !== "class" && a.name !== "style")
          .map((a) => [a.name, a.value.length > 48 ? `#value(${a.value.length})` : a.value])
      )
    };
  }

  // ---- 1. Virtualisation -------------------------------------------------
  function virtualisation() {
    const containers = Array.from(document.querySelectorAll("[data-turn-id-container]"));
    // The <section> also carries the container attribute; the placeholder we
    // care about is the wrapper that does *not* also carry data-turn-id.
    const wrappers = containers.filter((el) => !el.hasAttribute("data-turn-id"));
    const mounted = document.querySelectorAll("[data-message-id]");
    const sections = document.querySelectorAll("[data-testid^='conversation-turn-']");

    const turnNumbers = Array.from(sections)
      .map((el) => Number(String(el.getAttribute("data-testid")).slice("conversation-turn-".length)))
      .filter(Number.isFinite)
      .sort((a, b) => a - b);

    const wrapperDetail = wrappers.map((el) => ({
      turnId: el.getAttribute("data-turn-id-container")?.slice(0, 8),
      intersecting: el.getAttribute("data-is-intersecting"),
      hasMountedMessage: !!el.querySelector("[data-message-id]"),
      offsetHeight: el.offsetHeight,
      childCount: el.childElementCount
    }));

    const empty = wrapperDetail.filter((w) => !w.hasMountedMessage);

    return {
      wrapperCount: wrappers.length,
      sectionCount: sections.length,
      mountedMessageCount: mounted.length,
      turnNumberRange: turnNumbers.length ? { min: turnNumbers[0], max: turnNumbers[turnNumbers.length - 1] } : null,
      turnNumbersSeen: turnNumbers,
      // The key question: do wrappers survive with reserved height once their
      // content is unmounted? If yes we can scroll to any prompt. If this is
      // empty, unmounted turns leave nothing behind at all.
      emptyWrapperCount: empty.length,
      emptyWrappersKeepHeight: empty.filter((w) => w.offsetHeight > 0).length,
      wrapperSample: wrapperDetail.slice(0, 4),
      emptyWrapperSample: empty.slice(0, 4)
    };
  }

  // ---- 2. Scrolling ------------------------------------------------------
  function scrolling() {
    const anchor = document.querySelector("[data-message-id]") || document.querySelector("main");
    const chain = [];
    let el = anchor;
    while (el && el !== document.documentElement && chain.length < 14) {
      const cs = getComputedStyle(el);
      const scrollable = el.scrollHeight > el.clientHeight + 8;
      if (scrollable || cs.overflowY === "auto" || cs.overflowY === "scroll") {
        chain.push({
          ...describe(el),
          overflowY: cs.overflowY,
          scrollHeight: el.scrollHeight,
          clientHeight: el.clientHeight,
          scrollTop: el.scrollTop
        });
      }
      el = el.parentElement;
    }
    return {
      candidates: chain,
      documentScrolls: document.scrollingElement
        ? {
            scrollHeight: document.scrollingElement.scrollHeight,
            clientHeight: document.scrollingElement.clientHeight,
            scrollTop: document.scrollingElement.scrollTop
          }
        : null
    };
  }

  // ---- 3. Conversation API ----------------------------------------------
  function shapeOf(value, depth = 0) {
    if (value === null) return "null";
    if (Array.isArray(value)) {
      return depth > 3 ? `array(${value.length})` : { array: value.length, of: value.length ? shapeOf(value[0], depth + 1) : null };
    }
    const t = typeof value;
    if (t === "string") return `#text(${value.length})`;
    if (t !== "object") return t;
    if (depth > 3) return "object";
    const out = {};
    for (const [k, v] of Object.entries(value).slice(0, 24)) out[k] = shapeOf(v, depth + 1);
    return out;
  }

  async function conversationApi() {
    const out = { conversationId: location.pathname.match(/\/c\/([^/?#]+)/)?.[1] || null };
    if (!out.conversationId) return { ...out, skipped: "not on a conversation URL" };

    try {
      const sres = await fetch("/api/auth/session", { credentials: "include" });
      out.sessionStatus = sres.status;
      const session = sres.ok ? await sres.json() : null;
      out.hasAccessToken = !!session?.accessToken;
      out.sessionKeys = session ? Object.keys(session) : [];

      const headers = { accept: "*/*" };
      if (session?.accessToken) headers.Authorization = `Bearer ${session.accessToken}`;

      const cres = await fetch(`/backend-api/conversation/${out.conversationId}`, {
        credentials: "include",
        headers
      });
      out.conversationStatus = cres.status;
      if (!cres.ok) {
        out.conversationError = (await cres.text()).slice(0, 200);
        return out;
      }

      const data = await cres.json();
      out.topLevelKeys = Object.keys(data);
      const mapping = data.mapping || {};
      const ids = Object.keys(mapping);
      out.mappingNodeCount = ids.length;
      out.hasCurrentNode = !!data.current_node;

      // Walk the active branch from current_node back to the root — this is
      // the thread the user is actually looking at.
      const branch = [];
      let cursor = data.current_node;
      const guard = new Set();
      while (cursor && mapping[cursor] && !guard.has(cursor)) {
        guard.add(cursor);
        branch.push(mapping[cursor]);
        cursor = mapping[cursor].parent;
      }
      branch.reverse();

      const roleOf = (n) => n?.message?.author?.role || null;
      out.branchLength = branch.length;
      out.branchUserMessages = branch.filter((n) => roleOf(n) === "user").length;
      out.branchAssistantMessages = branch.filter((n) => roleOf(n) === "assistant").length;
      out.branchRoles = branch.map(roleOf).filter(Boolean).slice(0, 12);

      const sampleUser = branch.find((n) => roleOf(n) === "user");
      out.userNodeShape = sampleUser ? shapeOf(sampleUser) : null;
      out.contentTypesSeen = Array.from(
        new Set(branch.map((n) => n?.message?.content?.content_type).filter(Boolean))
      );
      out.timing = { hasCreateTime: branch.some((n) => n?.message?.create_time != null) };
    } catch (err) {
      out.error = String(err && err.message);
    }
    return out;
  }

  async function run() {
    const report = {
      capturedOn: location.pathname,
      virtualisation: virtualisation(),
      scrolling: scrolling(),
      api: await conversationApi()
    };
    const text = JSON.stringify(report, null, 2);
    window.cgxLoadingReport = text;
    console.log("%cChatGPT Navigator loading probe", "font-weight:bold");
    console.log("Run  copy(cgxLoadingReport)  to copy it.");
    console.log(text);
    return text;
  }

  window.cgxLoadingProbe = run;
  console.log("Loaded. Now run:  await cgxLoadingProbe()");
})();
