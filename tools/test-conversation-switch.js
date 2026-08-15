/**
 * Conversation switching — run with: node tools/test-conversation-switch.js
 *
 * Reproduces what ChatGPT actually does when you click another conversation:
 * the URL changes first, and the outgoing thread stays in the DOM for a few
 * hundred milliseconds before React swaps in the new one. During that overlap
 * the sidebar must never show the two conversations mixed together.
 *
 * The sidebar is sampled continuously through the transition, so a wrong list
 * that only exists for a few frames still fails the test.
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

// Two conversations with clearly distinguishable prompts.
const THREADS = {
  alpha: { prefix: "Alpha", pairs: 6 },
  beta: { prefix: "Beta", pairs: 4 }
};

function questionText(prefix, n) {
  return `${prefix} question ${n}`;
}

function payloadFor(key) {
  const { prefix, pairs } = THREADS[key];
  const mapping = { root: { id: "root", message: null, parent: null, children: [] } };
  let last = "root";
  for (let i = 0; i < pairs * 2; i++) {
    const isUser = i % 2 === 0;
    const n = Math.floor(i / 2) + 1;
    const id = `${key}-${isUser ? "u" : "a"}-${n}`;
    mapping[id] = {
      id,
      parent: last,
      children: [],
      message: {
        id,
        author: { role: isUser ? "user" : "assistant" },
        content: {
          content_type: "text",
          parts: [isUser ? questionText(prefix, n) : `${prefix} answer ${n}`]
        },
        metadata: {}
      }
    };
    mapping[last].children.push(id);
    last = id;
  }
  return { title: key, current_node: last, mapping };
}

function threadHtml(key) {
  const { prefix, pairs } = THREADS[key];
  let html = "";
  for (let i = 0; i < pairs * 2; i++) {
    const isUser = i % 2 === 0;
    const n = Math.floor(i / 2) + 1;
    const uid = `${key}-${isUser ? "u" : "a"}-${n}`;
    const body = isUser
      ? `<div class="user-message-bubble-color"><div class="whitespace-pre-wrap">${questionText(prefix, n)}</div></div>`
      : `<div class="markdown prose"><p>${prefix} answer ${n}</p></div>`;
    html += `
      <div data-turn-id-container="${uid}" data-is-intersecting="true">
        <section data-turn-id="${uid}" data-testid="conversation-turn-${i + 1}" data-turn="${isUser ? "user" : "assistant"}">
          <div data-message-author-role="${isUser ? "user" : "assistant"}" data-message-id="${uid}"
               ${isUser ? "" : 'data-message-model-slug="gpt-5-5"'}>
            <div class="flex w-full flex-col gap-1 empty:hidden">${body}</div>
          </div>
        </section>
      </div>`;
  }
  return html;
}

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}

function boot({ apiDelayMs = 40 } = {}) {
  const dom = new JSDOM(
    `<!doctype html><html class="dark"><body><main>
       <div id="turn-host">${threadHtml("alpha")}</div>
       <form data-type="unified-composer">
         <div id="prompt-textarea" contenteditable="true"></div>
         <button data-testid="send-button"></button>
       </form>
     </main></body></html>`,
    { url: "https://chatgpt.com/c/alpha", runScripts: "outside-only", pretendToBeVisual: true }
  );
  const { window } = dom;
  const doc = window.document;

  Object.defineProperty(window.HTMLElement.prototype, "offsetHeight", { configurable: true, get: () => 50 });
  Object.defineProperty(window.HTMLElement.prototype, "offsetWidth", { configurable: true, get: () => 300 });
  window.HTMLElement.prototype.scrollIntoView = function () {};

  window.fetch = async (url) => {
    const href = String(url);
    if (apiDelayMs) await new Promise((r) => setTimeout(r, apiDelayMs));
    if (href.includes("/api/auth/session")) return jsonResponse({ accessToken: "tok" });
    const m = /\/backend-api\/conversation\/([^/?#]+)/.exec(href);
    if (m && THREADS[m[1]]) return jsonResponse(payloadFor(m[1]));
    return jsonResponse({}, 404);
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

  // Captured before the extension loads. A content script runs in an isolated
  // world, so any wrapper it installs on history.pushState is invisible to the
  // page — the page's own calls go through this original. Navigating via it is
  // what makes this test behave like a real browser instead of like jsdom.
  const pagePushState = window.history.pushState.bind(window.history);

  const ctx = dom.getInternalVMContext();
  for (const rel of SCRIPTS) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, rel), "utf8"), ctx, { filename: rel });
  }
  return { dom, window, doc, pagePushState };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const titles = (doc) => Array.from(doc.querySelectorAll("#cgx-list .cgx-item .q")).map((el) => el.textContent);

/** Poll the sidebar every few ms and keep every distinct state it passes through. */
function startSampling(doc, everyMs = 8) {
  const samples = [];
  const timer = setInterval(() => {
    const snapshot = titles(doc);
    const last = samples[samples.length - 1];
    if (!last || last.join("|") !== snapshot.join("|")) samples.push(snapshot);
  }, everyMs);
  return { samples, stop: () => clearInterval(timer) };
}

(async () => {
  const { doc, pagePushState } = boot();
  const host = doc.getElementById("turn-host");

  await wait(1500);
  eq("alpha is listed in full", titles(doc).length, THREADS.alpha.pairs);
  check("alpha prompts are alpha's", titles(doc).every((t) => t.startsWith("Alpha")));

  // ---- The switch ---------------------------------------------------------
  const sampler = startSampling(doc);
  const startedAt = Date.now();

  // 1. ChatGPT changes the URL first, from its own world.
  pagePushState({}, "", "/c/beta");
  // 2. ...and leaves the outgoing thread mounted while it loads the new one.
  await wait(350);
  const midSwitch = titles(doc);
  // 3. The incoming thread mounts before the outgoing one is torn down, so
  //    both are briefly in the DOM together.
  host.insertAdjacentHTML("beforeend", threadHtml("beta"));
  await wait(120);
  for (const el of doc.querySelectorAll("[data-turn-id-container^='alpha-']")) el.remove();

  // Wait until the sidebar has settled on beta.
  let settledAt = null;
  for (let i = 0; i < 200; i++) {
    const now = titles(doc);
    if (now.length === THREADS.beta.pairs && now.every((t) => t.startsWith("Beta"))) {
      settledAt = Date.now();
      break;
    }
    await wait(25);
  }
  await wait(300);
  sampler.stop();

  // ---- What the user actually saw ----------------------------------------
  check("the sidebar reaches beta at all", !!settledAt, `stuck on ${JSON.stringify(titles(doc))}`);
  eq("beta is listed in full", titles(doc).length, THREADS.beta.pairs);
  check("and only beta", titles(doc).every((t) => t.startsWith("Beta")), JSON.stringify(titles(doc)));

  check(
    "the outgoing conversation is cleared before the URL settles",
    !midSwitch.some((t) => t.startsWith("Alpha")),
    `still showing ${JSON.stringify(midSwitch)}`
  );

  const mixed = sampler.samples.filter(
    (s) => s.some((t) => t.startsWith("Alpha")) && s.some((t) => t.startsWith("Beta"))
  );
  check(
    "the two conversations are never shown together",
    mixed.length === 0,
    `${mixed.length} mixed state(s), first: ${JSON.stringify(mixed[0])}`
  );

  const staleAfterSwap = sampler.samples.slice(1).filter((s) => s.some((t) => t.startsWith("Alpha")));
  check(
    "no alpha prompt survives into beta",
    staleAfterSwap.length === 0,
    `${staleAfterSwap.length} state(s) still had alpha, e.g. ${JSON.stringify(staleAfterSwap[0])}`
  );

  const elapsed = settledAt ? settledAt - startedAt : Infinity;
  check("the switch completes promptly", elapsed < 1200, `took ${elapsed}ms`);
  console.log(`        (switch settled in ${elapsed}ms)`);

  console.log(`\n${checks - failures}/${checks} checks passed`);
  process.exit(failures ? 1 : 0);
})();
