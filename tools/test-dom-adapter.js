/**
 * Tests for src/chatgpt-dom.js — run with: node tools/test-dom-adapter.js
 *
 * Each fixture is the same two-turn conversation expressed in a different
 * markup generation, from what ChatGPT ships today down to a version with
 * every attribute we know stripped out. The adapter is expected to keep
 * identifying the same two turns as the cascade degrades.
 *
 * When ChatGPT changes its HTML for real, add the new shape here as a fixture
 * first — that reproduces the breakage without needing a browser.
 */
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

function mount(bodyHtml, url = "https://chatgpt.com/c/abc123") {
  const dom = new JSDOM(`<!doctype html><html><body><main>${bodyHtml}</main></body></html>`, { url });
  // jsdom has no layout engine, so offsetHeight is always 0 and would filter
  // out every candidate in the heuristic strategy. Report a plausible height
  // unless a fixture explicitly marks a node as collapsed.
  Object.defineProperty(dom.window.HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get() {
      return this.hasAttribute("data-test-zero-height") ? 0 : 50;
    }
  });
  global.window = dom.window;
  global.document = dom.window.document;
  global.location = dom.window.location;
  global.NodeFilter = dom.window.NodeFilter;
  CGXDom.resetStrategy();
  return dom;
}

// Globals must exist before the adapter's functions run, but the module itself
// touches no DOM at load time.
global.window = {};
global.document = {};
global.location = { pathname: "/" };
const CGXDom = require("../src/chatgpt-dom.js");

const COMPOSER = `
  <form data-type="unified-composer">
    <div id="prompt-textarea" contenteditable="true"></div>
    <button data-testid="send-button"></button>
  </form>
`;

// --- Fixture A: markup as ChatGPT ships it today ---------------------------
{
  mount(`
    <article data-testid="conversation-turn-2" data-turn-id="req-1" data-turn="user">
      <div data-message-author-role="user" data-message-id="msg-a">
        <div class="whitespace-pre-wrap">What is a pointer in C++?</div>
      </div>
    </article>
    <article data-testid="conversation-turn-3" data-turn-id="res-1" data-turn="assistant">
      <div data-message-author-role="assistant" data-message-id="msg-b">
        <div class="markdown prose"><p>A pointer stores an address.</p></div>
      </div>
      <button aria-label="Read aloud"></button>
    </article>
    ${COMPOSER}
  `);

  const scan = CGXDom.scanTurns();
  eq("A: strategy is the role attribute", scan.strategy, "author-role");
  eq("A: one user turn", scan.user.length, 1);
  eq("A: one assistant turn", scan.assistant.length, 1);
  eq("A: user text", scan.user[0].textContent.trim(), "What is a pointer in C++?");
  eq("A: turn number read from testid", CGXDom.turnNumber(scan.user[0]), 2);
  eq("A: stable key read from message id", CGXDom.stableKey(scan.user[0]), "msg-a");
  eq("A: collapse target is the markdown body", CGXDom.assistantContent(scan.assistant[0])?.className, "markdown prose");
  check("A: composer is excluded from turns", !scan.turns.some((t) => CGXDom.isComposer(t.el)));
}

// --- Fixture A2: live markup captured from chatgpt.com, Aug 2026 -----------
// This is the revision that broke 0.1.3. Everything the extension relied on
// survived except the turn wrapper's tag: `article` became `section`, keeping
// the same data-testid. Detection still worked, so the sidebar looked fine —
// but turnNumber() went null for every turn and the list silently fell back to
// discovery order, which scrambles as virtualised turns mount out of sequence.
//
// Structure and attributes are verbatim from tools/dom-probe.js; the long
// Tailwind class strings are trimmed to the tokens the adapter actually reads.
{
  const uidUser = "b8324bb8-42d2-4da6-b042-c6a4e7b37679";
  const uidBot = "f64e8bf6-a9f5-4277-aeee-25897f30f116";

  mount(`
    <div class="contents" role="presentation">
      <div id="thread" class="group/thread flex flex-col min-h-full">
        <div class="composer-parent flex flex-1 flex-col">
          <div class="flex min-h-0 grow flex-col text-sm">
            <div class="qMYqUG_convSearchResultHighlightRoot">

              <div data-turn-id-container="${uidUser}" data-is-intersecting="true">
                <section dir="auto" data-turn-id="${uidUser}" data-turn-id-container="${uidUser}"
                         data-testid="conversation-turn-1" data-turn="user"
                         class="text-token-text-primary w-full R6Vx5W_threadScrollSection">
                  <div class="text-base my-auto mx-auto pt-3">
                    <div data-conversation-screenshot-content="" class="mx-auto flex-1 group/turn-messages">
                      <div class="flex max-w-full flex-col gap-4 grow">
                        <div data-message-author-role="user" data-message-id="${uidUser}" dir="auto"
                             class="min-h-8 text-message relative flex w-full flex-col items-end gap-2">
                          <div class="flex w-full flex-col gap-1 empty:hidden items-end rtl:items-start">
                            <div class="corner-superellipse/0.98 relative min-w-0 overflow-hidden rounded-[22px] user-message-bubble-color">
                              <div class="max-w-full min-w-0 [overflow-wrap:anywhere] whitespace-pre-wrap">Rav4各种型号怎么选</div>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </section>
              </div>

              <div data-turn-id-container="${uidBot}" data-is-intersecting="true">
                <section dir="auto" data-turn-id="${uidBot}" data-turn-id-container="${uidBot}"
                         data-testid="conversation-turn-2" data-turn="assistant"
                         class="text-token-text-primary w-full R6Vx5W_threadScrollSection">
                  <div class="text-base my-auto mx-auto">
                    <div data-conversation-screenshot-content="" class="mx-auto flex-1 group/turn-messages">
                      <div class="flex max-w-full flex-col gap-4 grow">
                        <div data-message-author-role="assistant" data-message-id="${uidBot}" dir="auto"
                             data-message-model-slug="gpt-5-5"
                             class="min-h-8 text-message relative flex w-full flex-col items-end gap-2">
                          <div class="flex w-full flex-col gap-1 empty:hidden">
                            <div class="markdown prose dark:prose-invert wrap-break-word w-full dark markdown-new-styling">
                              <p data-start="0" data-end="33">RAV4 有几个主要版本。</p>
                              <ol data-start="35" data-end="86">
                                <li data-section-id="12zcf0a"><p>LE 是入门款</p></li>
                                <li data-section-id="2i7oxs"><p>XLE 增加了一些配置</p></li>
                              </ol>
                              <h2 data-section-id="1q4jqo">怎么选</h2>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </section>
              </div>

            </div>
          </div>
        </div>
      </div>
    </div>
    ${COMPOSER}
  `);

  const scan = CGXDom.scanTurns();
  eq("A2: role attribute still wins", scan.strategy, "author-role");
  eq("A2: one user turn", scan.user.length, 1);
  eq("A2: one assistant turn", scan.assistant.length, 1);
  eq("A2: user text", scan.user[0].textContent.trim(), "Rav4各种型号怎么选");

  // The actual regression: these two were null against a <section> wrapper.
  eq("A2: turn number survives the section retag", CGXDom.turnNumber(scan.user[0]), 1);
  eq("A2: assistant turn number too", CGXDom.turnNumber(scan.assistant[0]), 2);

  eq("A2: stable key from message id", CGXDom.stableKey(scan.assistant[0]), uidBot);
  check(
    "A2: collapse target is the markdown body",
    CGXDom.assistantContent(scan.assistant[0])?.classList.contains("markdown")
  );
  check("A2: composer is not treated as a turn", !scan.turns.some((t) => CGXDom.isComposer(t.el)));
  check(
    "A2: no turn is inside the composer",
    !scan.turns.some((t) => t.el.closest("form[data-type='unified-composer']"))
  );
}

// --- Fixture A3: same markup with data-message-author-role hypothetically gone
// Guards the next revision: role must still resolve from the section's
// data-turn, and ordering must still come off the test id.
{
  mount(`
    <div data-turn-id-container="u1" data-is-intersecting="true">
      <section data-turn-id="u1" data-testid="conversation-turn-1" data-turn="user">
        <div class="user-message-bubble-color"><div class="whitespace-pre-wrap">Question one</div></div>
      </section>
    </div>
    <div data-turn-id-container="a1" data-is-intersecting="true">
      <section data-turn-id="a1" data-testid="conversation-turn-2" data-turn="assistant">
        <div class="markdown prose"><p>Answer one</p></div>
      </section>
    </div>
    ${COMPOSER}
  `);

  const scan = CGXDom.scanTurns();
  eq("A3: resolves via the section's data-turn", scan.strategy, "turn-attr");
  eq("A3: one user turn", scan.user.length, 1);
  eq("A3: one assistant turn", scan.assistant.length, 1);
  eq("A3: ordering still available", CGXDom.turnNumber(scan.assistant[0]), 2);
  check("A3: wrapper and section are not double-counted", scan.turns.length === 2);
}

// --- Fixture B: data-message-author-role removed ---------------------------
{
  mount(`
    <article data-testid="conversation-turn-2" data-turn-id="req-1" data-turn="user">
      <div data-message-id="msg-a"><div class="whitespace-pre-wrap">Question one</div></div>
    </article>
    <article data-testid="conversation-turn-3" data-turn-id="res-1" data-turn="assistant">
      <div data-message-id="msg-b"><div class="markdown"><p>Answer one</p></div></div>
    </article>
    ${COMPOSER}
  `);

  const scan = CGXDom.scanTurns();
  eq("B: falls through to the turn attribute", scan.strategy, "turn-attr");
  eq("B: one user turn", scan.user.length, 1);
  eq("B: one assistant turn", scan.assistant.length, 1);
  eq("B: user text", scan.user[0].textContent.trim(), "Question one");
  eq("B: turn number still available", CGXDom.turnNumber(scan.assistant[0]), 3);
}

// --- Fixture C: only test ids survive; roles inferred from structure -------
{
  mount(`
    <article data-testid="conversation-turn-2">
      <div class="user-message-bubble-color">Question one</div>
      <button aria-label="Edit message"></button>
    </article>
    <article data-testid="conversation-turn-3">
      <div class="markdown"><p>Answer one</p></div>
      <button aria-label="Good response"></button>
    </article>
    ${COMPOSER}
  `);

  const scan = CGXDom.scanTurns();
  eq("C: falls through to the test id", scan.strategy, "testid-turn");
  eq("C: user role inferred from the bubble", scan.user.length, 1);
  eq("C: assistant role inferred from markdown", scan.assistant.length, 1);
  eq("C: user text", scan.user[0].textContent.trim().split("\n")[0].trim(), "Question one");
}

// --- Fixture D: everything renamed; only a11y and action buttons remain ----
{
  mount(`
    <article aria-posinset="1">
      <div class="_userText_9f2a1">Question one</div>
      <button aria-label="Edit message"></button>
    </article>
    <article aria-posinset="2">
      <div class="_answerBody_9f2a1"><p>Answer one</p></div>
      <button aria-label="Read aloud"></button>
    </article>
    ${COMPOSER}
  `);

  const scan = CGXDom.scanTurns();
  eq("D: falls through to bare articles", scan.strategy, "article");
  eq("D: user identified by the edit button", scan.user.length, 1);
  eq("D: assistant identified by read-aloud", scan.assistant.length, 1);
  eq("D: turn number falls back to aria-posinset", CGXDom.turnNumber(scan.user[0]), 1);
  eq("D: no stable key available", CGXDom.stableKey(scan.user[0]), null);
  eq(
    "D: collapse target is the block-level wrapper",
    CGXDom.assistantContent(scan.assistant[0])?.className,
    "_answerBody_9f2a1"
  );
}

// --- Fixture E: nothing recognisable; roles by alternation only ------------
{
  mount(`
    <div class="_row_1"><div>Question one, long enough to count as prose.</div></div>
    <div class="_row_1"><div>Answer one, long enough to count as prose.</div></div>
    <div class="_row_1"><div>Question two, long enough to count as prose.</div></div>
    <div class="_row_1"><div>Answer two, long enough to count as prose.</div></div>
    ${COMPOSER}
  `);

  const scan = CGXDom.scanTurns();
  eq("E: last-resort heuristic wins", scan.strategy, "heuristic");
  eq("E: two user turns by alternation", scan.user.length, 2);
  eq("E: two assistant turns by alternation", scan.assistant.length, 2);
  eq("E: first turn is treated as the question", scan.user[0].textContent.trim().slice(0, 12), "Question one");
}

// --- Fixture F: too few repeated nodes to trust the heuristic --------------
// Two anonymous sibling divs are page chrome far more often than they are a
// conversation, so the adapter should report nothing rather than guess.
{
  mount(`
    <div class="_row_1"><div>Some sidebar entry with a bit of text.</div></div>
    <div class="_row_1"><div>Another sidebar entry with a bit of text.</div></div>
  `);

  const scan = CGXDom.scanTurns();
  eq("F: refuses to guess from two anonymous nodes", scan.strategy, null);
  eq("F: no turns reported", scan.turns.length, 0);
}

// --- Nesting: a wrapper and its inner message must not both count ----------
{
  mount(`
    <article data-turn-id="t1" data-message-id="outer">
      <div data-message-id="inner"><div class="markdown"><p>Answer</p></div></div>
    </article>
    <article data-turn-id="t2" data-message-id="outer2">
      <div data-message-id="inner2"><div class="user-message-bubble-color">Question</div></div>
    </article>
  `);

  const scan = CGXDom.scanTurns();
  eq("nesting: outer wrappers only", scan.turns.length, 2);
  check(
    "nesting: kept the outermost node",
    scan.turns.every((t) => t.el.tagName === "ARTICLE"),
    scan.turns.map((t) => t.el.tagName).join(",")
  );
}

// --- Composer detection ----------------------------------------------------
{
  const dom = mount(`
    <article data-message-author-role="user" data-message-id="m1"><p>Question</p></article>
    ${COMPOSER}
  `);
  const composerForm = dom.window.document.querySelector("form[data-type='unified-composer']");
  const turn = dom.window.document.querySelector("[data-message-author-role='user']");
  check("composer form is detected", CGXDom.isComposer(composerForm));
  check("a plain turn is not a composer", !CGXDom.isComposer(turn));
}

// --- Editing a message must not make its turn look like the composer -------
// ChatGPT swaps the bubble for a textarea in place; if that turn were treated
// as composer chrome it would vanish from the sidebar mid-edit.
{
  const dom = mount(`
    <article data-testid="conversation-turn-2" data-turn="user" data-turn-id="req-1">
      <div data-message-author-role="user" data-message-id="msg-a">
        <textarea>Question being edited</textarea>
      </div>
    </article>
    <article data-testid="conversation-turn-3" data-turn="assistant" data-turn-id="res-1">
      <div data-message-author-role="assistant" data-message-id="msg-b">
        <div class="markdown"><p>Answer</p></div>
      </div>
    </article>
    ${COMPOSER}
  `);
  const scan = CGXDom.scanTurns();
  const editing = dom.window.document.querySelector("[data-message-id='msg-a']");
  eq("edit mode: user turn is still listed", scan.user.length, 1);
  check("edit mode: turn is not mistaken for the composer", !CGXDom.isComposer(editing));
}

// --- Route detection -------------------------------------------------------
{
  check("standalone chat is a chat route", CGXDom.isChatRoute("/c/68a1f2"));
  check("project chat is a chat route", CGXDom.isChatRoute("/g/g-p-abc/c/68a1f2"));
  check("the landing page is not", !CGXDom.isChatRoute("/"));
  check("the library is not", !CGXDom.isChatRoute("/library"));
}

// --- Mutation triage -------------------------------------------------------
{
  const dom = mount(`<article data-message-author-role="user" data-message-id="m1"><p>Q</p></article>`);
  const doc = dom.window.document;
  const turn = doc.querySelector("article");
  const wrapper = doc.createElement("div");
  wrapper.appendChild(turn.cloneNode(true));
  const unrelated = doc.createElement("div");
  unrelated.textContent = "tooltip";

  check("a turn node is message-like", CGXDom.looksLikeMessage(turn));
  check("a wrapper around a turn counts", CGXDom.containsMessage(wrapper));
  check("unrelated chrome does not", !CGXDom.containsMessage(unrelated));
}

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
