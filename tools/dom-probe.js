/**
 * ChatGPT Navigator — DOM probe
 *
 * Paste this whole file into the DevTools console on an *open ChatGPT
 * conversation* (a /c/... URL with several user + assistant turns), then run:
 *
 *     copy(cgxProbe())      // copies the report to your clipboard
 *
 * The report is structural only: tag names, class names, attribute *names*,
 * and attribute values that look like ids. All message text is replaced with
 * `#text(<length>)`, so nothing you actually said or received is included.
 */
(() => {
  const MAX_SKELETON_DEPTH = 6;
  const MAX_CHILDREN_PER_NODE = 8;
  const MAX_CLASS_CHARS = 160;

  const LEGACY_SELECTORS = {
    messageRole: "[data-message-author-role]",
    messageId: "[data-message-id]",
    turnTestId: "article[data-testid^='conversation-turn-']",
    turnId: "[data-turn-id]",
    turnAttr: "[data-turn]",
    markdownClass: ".markdown",
    markdownLike: "[class*='markdown']",
    proseLike: "[class*='prose']",
    composerTextarea: "textarea",
    composerEditable: "[contenteditable='true']",
    composerTestId: "[data-testid*='prompt']",
    main: "main",
    article: "main article"
  };

  function sanitizeAttrValue(name, value) {
    const v = String(value ?? "");
    if (!v) return "";
    // Attribute values are mostly ids/enums; collapse anything long or
    // sentence-like so a prompt pasted into an aria-label can't leak.
    if (v.length > 60 || /\s{1}\S+\s{1}\S+\s{1}\S+/.test(v)) return `#value(${v.length})`;
    return v;
  }

  function describeAttrs(el) {
    const out = {};
    for (const attr of el.attributes || []) {
      const name = attr.name;
      if (name === "class" || name === "style") continue;
      out[name] = sanitizeAttrValue(name, attr.value);
    }
    return out;
  }

  function describeClasses(el) {
    const cls = typeof el.className === "string" ? el.className : el.getAttribute?.("class") || "";
    const trimmed = cls.replace(/\s+/g, " ").trim();
    if (trimmed.length <= MAX_CLASS_CHARS) return trimmed;
    return `${trimmed.slice(0, MAX_CLASS_CHARS)}… (+${trimmed.length - MAX_CLASS_CHARS} chars)`;
  }

  function directTextLength(el) {
    let len = 0;
    for (const node of el.childNodes) {
      if (node.nodeType === 3) len += (node.nodeValue || "").trim().length;
    }
    return len;
  }

  function skeleton(el, depth = 0) {
    if (!el || el.nodeType !== 1 || depth > MAX_SKELETON_DEPTH) return null;
    const node = {
      tag: el.tagName.toLowerCase(),
      class: describeClasses(el),
      attrs: describeAttrs(el)
    };
    const textLen = directTextLength(el);
    if (textLen) node.text = `#text(${textLen})`;
    const kids = Array.from(el.children).slice(0, MAX_CHILDREN_PER_NODE);
    if (kids.length) {
      node.children = kids.map((k) => skeleton(k, depth + 1)).filter(Boolean);
      const hidden = el.children.length - kids.length;
      if (hidden > 0) node.childrenTruncated = hidden;
    }
    return node;
  }

  function ancestry(el, stopAt = document.body) {
    const chain = [];
    let cur = el;
    while (cur && cur !== stopAt && chain.length < 12) {
      chain.push({
        tag: cur.tagName.toLowerCase(),
        class: describeClasses(cur),
        attrs: describeAttrs(cur)
      });
      cur = cur.parentElement;
    }
    return chain;
  }

  function legacyCounts() {
    const out = {};
    for (const [key, sel] of Object.entries(LEGACY_SELECTORS)) {
      try {
        out[key] = { selector: sel, count: document.querySelectorAll(sel).length };
      } catch (err) {
        out[key] = { selector: sel, error: String(err && err.message) };
      }
    }
    return out;
  }

  // Frequency map of every data-*/aria-*/role attribute name under the chat
  // area. This is what tells us the new naming scheme even if nothing we
  // currently look for matches.
  function attributeCensus(root) {
    const census = new Map();
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    let el = root;
    let scanned = 0;
    while (el) {
      scanned++;
      for (const attr of el.attributes || []) {
        const name = attr.name;
        if (!/^(data-|aria-)/.test(name) && name !== "role") continue;
        let entry = census.get(name);
        if (!entry) {
          entry = { count: 0, samples: new Set() };
          census.set(name, entry);
        }
        entry.count++;
        if (entry.samples.size < 3) {
          const v = sanitizeAttrValue(name, attr.value);
          if (v) entry.samples.add(v);
        }
      }
      el = walker.nextNode();
    }
    const out = {};
    for (const [name, entry] of [...census].sort((a, b) => b[1].count - a[1].count)) {
      out[name] = { count: entry.count, samples: [...entry.samples] };
    }
    return { scannedElements: scanned, attributes: out };
  }

  // Heuristic guess at where turns live: the deepest ancestor that repeats
  // many times and holds a meaningful amount of text.
  function guessTurnContainers(root) {
    const counts = new Map();
    for (const el of root.querySelectorAll("article, section, div")) {
      const parent = el.parentElement;
      if (!parent) continue;
      const text = (el.textContent || "").trim();
      if (text.length < 20) continue;
      const key = parent;
      let entry = counts.get(key);
      if (!entry) {
        entry = { parent, kids: [] };
        counts.set(key, entry);
      }
      entry.kids.push(el);
    }
    const ranked = [...counts.values()]
      .filter((e) => e.kids.length >= 4)
      .sort((a, b) => b.kids.length - a.kids.length)
      .slice(0, 3);
    return ranked.map((e) => ({
      repeatCount: e.kids.length,
      parent: { tag: e.parent.tagName.toLowerCase(), class: describeClasses(e.parent), attrs: describeAttrs(e.parent) },
      childSample: { tag: e.kids[0].tagName.toLowerCase(), class: describeClasses(e.kids[0]), attrs: describeAttrs(e.kids[0]) }
    }));
  }

  function findScrollContainer(root) {
    let best = null;
    for (const el of root.querySelectorAll("div")) {
      if (el.scrollHeight <= el.clientHeight + 40) continue;
      const overflow = getComputedStyle(el).overflowY;
      if (overflow !== "auto" && overflow !== "scroll") continue;
      if (!best || el.scrollHeight > best.scrollHeight) best = el;
    }
    return best
      ? { tag: best.tagName.toLowerCase(), class: describeClasses(best), attrs: describeAttrs(best) }
      : null;
  }

  function pickSample(role) {
    const byAttr = document.querySelector(`[data-message-author-role='${role}']`);
    if (byAttr) return { via: "data-message-author-role", el: byAttr };
    const byTurn = document.querySelector(`[data-turn='${role}']`);
    if (byTurn) return { via: "data-turn", el: byTurn };
    return null;
  }

  function report() {
    const main = document.querySelector("main") || document.body;
    const userSample = pickSample("user");
    const assistantSample = pickSample("assistant");

    const out = {
      capturedOn: location.pathname,
      userAgent: navigator.userAgent,
      legacySelectors: legacyCounts(),
      attributeCensus: attributeCensus(main),
      guessedTurnContainers: guessTurnContainers(main),
      scrollContainer: findScrollContainer(main)
    };

    if (userSample) {
      out.userTurn = { matchedVia: userSample.via, ancestry: ancestry(userSample.el, main), skeleton: skeleton(userSample.el) };
    }
    if (assistantSample) {
      out.assistantTurn = {
        matchedVia: assistantSample.via,
        ancestry: ancestry(assistantSample.el, main),
        skeleton: skeleton(assistantSample.el)
      };
    }
    if (!userSample && !assistantSample) {
      // Nothing we know about matched — dump the top of the chat area so we can
      // read the new structure directly.
      out.mainSkeleton = skeleton(main);
    }

    return JSON.stringify(out, null, 2);
  }

  window.cgxProbe = report;
  const text = report();
  console.log("%cChatGPT Navigator DOM probe", "font-weight:bold");
  console.log("Run  copy(cgxProbe())  to copy the full report.");
  console.log(text);
  return text;
})();
