/**
 * Tests the API-backed prompt index — run with: node tools/test-api-index.js
 *
 * The scenario is the one that motivated it: a long conversation where ChatGPT
 * has only mounted the last few turns. Scraping the DOM can see 2 questions;
 * the sidebar has to list all 10.
 *
 * The container here fakes ChatGPT's virtualisation — setting scrollTop mounts
 * a different window of turns — so clicking a question that isn't rendered
 * exercises the real scroll-hunt rather than a stub.
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { JSDOM } = require("jsdom");

let failures = 0;
let checks = 0;

function check(label, cond, detail) {
  checks++;
  if (cond) return;
  failures++;
  console.error(`  FAIL  ${label}${detail ? `\n        ${detail}` : ""}`);
}

function eq(label, actual, expected) {
  check(label, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const ROOT = path.join(__dirname, "..");
const MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
const SCRIPTS = MANIFEST.content_scripts[0].js;

const PAIRS = 10; // 10 questions + 10 answers
const WINDOW = 4; // turns ChatGPT keeps mounted
const ROW_PX = 400; // height of a mounted turn
const PLACEHOLDER_PX = 100; // reserved height of an unmounted one
const VIEWPORT_PX = 768;

function questionText(n) {
  return `Question number ${n} about the topic`;
}

/** The conversation as ChatGPT's backend would return it. */
function conversationPayload({ attachmentsOn = null } = {}) {
  const mapping = { root: { id: "root", message: null, parent: null, children: [] } };
  let last = "root";
  for (let i = 0; i < PAIRS * 2; i++) {
    const isUser = i % 2 === 0;
    const n = Math.floor(i / 2) + 1;
    const id = isUser ? `u-${n}` : `a-${n}`;
    const metadata = {};
    if (isUser && attachmentsOn === n) metadata.attachments = [{ id: "f1", name: "quarterly-report.pdf" }];
    mapping[id] = {
      id,
      parent: last,
      children: [],
      message: {
        id,
        author: { role: isUser ? "user" : "assistant" },
        content: { content_type: "text", parts: [isUser ? questionText(n) : `Answer number ${n}`] },
        metadata
      }
    };
    mapping[last].children.push(id);
    last = id;
  }
  return { title: "Long thread", current_node: last, mapping };
}

function turnHtml(index) {
  const isUser = index % 2 === 0;
  const n = Math.floor(index / 2) + 1;
  const uid = isUser ? `u-${n}` : `a-${n}`;
  const body = isUser
    ? `<div class="user-message-bubble-color"><div class="whitespace-pre-wrap">${questionText(n)}</div></div>`
    : `<div class="markdown prose"><p>Answer number ${n}</p></div>`;
  return `
    <div data-turn-id-container="${uid}" data-is-intersecting="true">
      <section data-turn-id="${uid}" data-testid="conversation-turn-${index + 1}" data-turn="${isUser ? "user" : "assistant"}">
        <div data-message-author-role="${isUser ? "user" : "assistant"}" data-message-id="${uid}"
             ${isUser ? "" : 'data-message-model-slug="gpt-5-5"'}>
          <div class="flex w-full flex-col gap-1 empty:hidden">${body}</div>
        </div>
      </section>
    </div>`;
}

function jsonResponse(window, body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body)
  };
}

function boot({ apiFails = false, attachmentsOn = null } = {}) {
  const dom = new JSDOM(
    `<!doctype html><html class="dark"><body><main>
       <div id="scroller"><div id="turn-host"></div></div>
       <form data-type="unified-composer">
         <div id="prompt-textarea" contenteditable="true"></div>
         <button data-testid="send-button"></button>
       </form>
     </main></body></html>`,
    {
      url: "https://chatgpt.com/c/long-thread-1",
      runScripts: "outside-only",
      pretendToBeVisual: true
    }
  );
  const { window } = dom;
  const doc = window.document;

  Object.defineProperty(window.HTMLElement.prototype, "offsetHeight", { configurable: true, get: () => 50 });
  Object.defineProperty(window.HTMLElement.prototype, "offsetWidth", { configurable: true, get: () => 300 });

  // --- fake virtualisation -------------------------------------------------
  //
  // The important detail is that an unmounted turn is *shorter* than a mounted
  // one: ChatGPT reserves an estimate and replaces it with real content when
  // the turn renders. So scrolling somewhere mounts turns, mounting changes
  // the height of everything above, and the place you were aiming for moves.
  // That drift is what strands a smooth scroll partway.
  const scroller = doc.getElementById("scroller");
  const host = doc.getElementById("turn-host");
  scroller.style.overflowY = "auto";
  const totalTurns = PAIRS * 2;
  const state = { mountedFrom: -1, scrollWrites: 0 };
  let scrollTop = 0;

  const isMounted = (i) => i >= state.mountedFrom && i < state.mountedFrom + WINDOW;
  const heightOf = (i) => (isMounted(i) ? ROW_PX : PLACEHOLDER_PX);

  function offsetOf(index) {
    let y = 0;
    for (let i = 0; i < index; i++) y += heightOf(i);
    return y;
  }
  const contentHeight = () => offsetOf(totalTurns);

  function indexAtOffset(y) {
    let acc = 0;
    for (let i = 0; i < totalTurns; i++) {
      const h = heightOf(i);
      if (y < acc + h) return i;
      acc += h;
    }
    return totalTurns - 1;
  }

  function mountWindow() {
    // One turn of overscan above, so mounting changes heights *above* the
    // target and not just below it.
    const first = Math.max(0, Math.min(totalTurns - WINDOW, indexAtOffset(scrollTop) - 1));
    if (first === state.mountedFrom) return;
    state.mountedFrom = first;
    let html = "";
    for (let i = first; i < first + WINDOW; i++) html += turnHtml(i);
    host.innerHTML = html;
  }

  Object.defineProperty(scroller, "scrollHeight", { configurable: true, get: contentHeight });
  Object.defineProperty(scroller, "clientHeight", { configurable: true, get: () => VIEWPORT_PX });
  Object.defineProperty(scroller, "scrollTop", {
    configurable: true,
    get: () => scrollTop,
    set(value) {
      scrollTop = Math.max(0, Math.min(Math.max(0, contentHeight() - VIEWPORT_PX), Number(value) || 0));
      state.scrollWrites++;
      mountWindow();
    }
  });
  scroller.scrollTop = Number.MAX_SAFE_INTEGER; // start pinned to the bottom

  // jsdom reports every rect as all-zero, which would make "is the target
  // resting near the top of the viewport?" trivially true.
  function turnIndexOf(el) {
    const container = el.closest?.("[data-turn-id-container]");
    const uid = container?.getAttribute("data-turn-id-container") || "";
    const m = /^([ua])-(\d+)$/.exec(uid);
    if (!m) return null;
    return (Number(m[2]) - 1) * 2 + (m[1] === "u" ? 0 : 1);
  }
  window.HTMLElement.prototype.getBoundingClientRect = function () {
    const index = turnIndexOf(this);
    const top = index == null ? 0 : offsetOf(index) - scrollTop;
    const height = index == null ? 0 : heightOf(index);
    return { top, bottom: top + height, left: 0, right: 300, width: 300, height, x: 0, y: top };
  };
  window.HTMLElement.prototype.scrollIntoView = function () {
    const index = turnIndexOf(this);
    if (index == null) return;
    scroller.scrollTop = offsetOf(index);
  };

  // --- stubs ---------------------------------------------------------------
  const calls = [];
  window.fetch = async (url) => {
    const href = String(url);
    calls.push(href);
    if (apiFails) return jsonResponse(window, { detail: "nope" }, 500);
    if (href.includes("/api/auth/session")) return jsonResponse(window, { accessToken: "test-token" });
    if (href.includes("/backend-api/conversation/")) return jsonResponse(window, conversationPayload({ attachmentsOn }));
    return jsonResponse(window, {}, 404);
  };

  const store = {};
  window.chrome = {
    storage: {
      local: {
        get(keys, cb) {
          const out = {};
          for (const k of [].concat(keys)) if (k in store) out[k] = store[k];
          cb(out);
        },
        set(obj, cb) {
          Object.assign(store, obj);
          if (cb) cb();
        }
      }
    }
  };

  const ctx = dom.getInternalVMContext();
  for (const rel of SCRIPTS) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, rel), "utf8"), ctx, { filename: rel });
  }
  return { dom, window, doc, calls, state, evaluate: (e) => vm.runInContext(e, ctx) };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const titles = (doc) => Array.from(doc.querySelectorAll("#cgx-list .cgx-item .q")).map((el) => el.textContent);

(async () => {
  // ---- 1. The whole thread is listed, not just what is mounted ------------
  {
    const { doc, calls } = boot();
    await wait(1500);

    const mountedQuestions = doc.querySelectorAll("[data-message-author-role='user']").length;
    check("only part of the thread is mounted", mountedQuestions < PAIRS, `${mountedQuestions} mounted`);

    const listed = titles(doc);
    eq("every question is listed", listed.length, PAIRS);
    eq("in conversation order, oldest first", listed[0], questionText(1));
    eq("through to the newest", listed[PAIRS - 1], questionText(PAIRS));
    check("the session endpoint was used", calls.some((c) => c.includes("/api/auth/session")));
    check("the conversation endpoint was used", calls.some((c) => c.includes("/backend-api/conversation/")));
    check("only chatgpt.com's own paths were requested", calls.every((c) => c.startsWith("/")));
  }

  // ---- 2. Attachment names come from the API, not from guessing at text ---
  {
    const { doc } = boot({ attachmentsOn: 3 });
    await wait(1500);
    const listed = titles(doc);
    check(
      "an attached file is named in the title",
      listed[2]?.includes("[quarterly-report.pdf]"),
      `got ${JSON.stringify(listed[2])}`
    );
  }

  // ---- 3. Clicking a question ChatGPT hasn't rendered scrolls to it -------
  {
    const { doc, window, state } = boot();
    await wait(1500);

    // Question 4 rather than question 1: turns above it have to grow from
    // placeholder to full height, which is what makes the target drift.
    const cards = doc.querySelectorAll("#cgx-list .cgx-item");
    const wanted = cards[3];
    eq("targeting the fourth question", wanted?.querySelector(".q")?.textContent, questionText(4));
    check("it is not mounted to begin with", !doc.querySelector("[data-message-id='u-4']"));

    const before = state.scrollWrites;
    wanted.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));

    // Poll rather than sampling at a fixed moment: the jump takes a variable
    // number of settle passes, and the highlight clears itself after 1.3s.
    let highlighted = false;
    for (let i = 0; i < 60; i++) {
      if (doc.querySelector("[data-message-id='u-4']")?.classList.contains("cgx-highlight")) {
        highlighted = true;
        break;
      }
      await wait(25);
    }

    check("the hunt scrolled the thread", state.scrollWrites > before);
    const target = doc.querySelector("[data-message-id='u-4']");
    check("the question is now mounted", !!target);
    check("and the mounted node is the one highlighted", highlighted);

    // The jump has to land, not stop partway. Without the settle pass the
    // target ends up mounted but still off-screen, which is what made a second
    // click necessary.
    const rect = target?.getBoundingClientRect();
    check(
      "and comes to rest in view, in one click",
      rect && rect.top >= 0 && rect.top <= VIEWPORT_PX / 2,
      `rect.top = ${rect?.top}, viewport = ${VIEWPORT_PX}`
    );
  }

  // ---- 3b. A new question must not rebuild the whole list ----------------
  // Collecting the cards into a fragment and re-appending detaches every
  // child, which collapses the list's scroll height and sends the user back to
  // the top mid-scroll. Node identity is the observable proof that the
  // reconciliation touches only what changed.
  {
    const { doc } = boot();
    await wait(1500);

    const list = doc.getElementById("cgx-list");
    const before = Array.from(list.querySelectorAll(".cgx-item"));
    eq("all questions rendered", before.length, PAIRS);

    // A question asked after the API fetch arrives via the DOM only.
    doc.getElementById("turn-host").insertAdjacentHTML(
      "beforeend",
      `<div data-turn-id-container="u-new" data-is-intersecting="true">
         <section data-turn-id="u-new" data-testid="conversation-turn-99" data-turn="user">
           <div data-message-author-role="user" data-message-id="u-new">
             <div class="user-message-bubble-color"><div class="whitespace-pre-wrap">A brand new question</div></div>
           </div>
         </section>
       </div>`
    );
    await wait(1200);

    const after = Array.from(list.querySelectorAll(".cgx-item"));
    eq("the new question is appended", after.length, PAIRS + 1);
    eq("and lands last", after[PAIRS]?.querySelector(".q")?.textContent, "A brand new question");
    check(
      "every existing card is the same DOM node, in the same order",
      before.every((card, i) => after[i] === card)
    );
  }

  // ---- 4. A failing API degrades to reading the DOM ----------------------
  {
    const { doc } = boot({ apiFails: true });
    await wait(1500);

    const listed = titles(doc);
    check("the sidebar still works without the API", listed.length > 0, `${listed.length} listed`);
    check(
      "listing what is mounted",
      listed.length <= PAIRS && listed.every((t) => t.startsWith("Question number")),
      JSON.stringify(listed)
    );
  }

  console.log(`\n${checks - failures}/${checks} checks passed`);
  process.exit(failures ? 1 : 0);
})();
