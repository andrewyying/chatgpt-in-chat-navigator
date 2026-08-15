/**
 * Tests for src/turn-order.js — run with: node tools/test-turn-order.js
 *
 * These simulate ChatGPT virtualising a long conversation: the tracker only
 * ever sees a sliding window of turns and has to keep a consistent total order.
 */
const CGXOrder = require("../src/turn-order.js");

let failures = 0;
let checks = 0;

function check(label, cond, detail) {
  checks++;
  if (cond) return;
  failures++;
  console.error(`  FAIL  ${label}${detail ? `\n        ${detail}` : ""}`);
}

function makeStore(ids) {
  const store = new Map();
  let seq = 0;
  for (const id of ids) store.set(id, { id, rank: null, seq: seq++ });
  return store;
}

function windowOf(store, ids) {
  return ids.map((id) => store.get(id));
}

function orderOf(store) {
  return CGXOrder.sortEntries(store.values()).map((e) => e.id);
}

function expectOrder(label, store, expected) {
  const actual = orderOf(store);
  check(label, actual.join(",") === expected.join(","), `expected [${expected}]\n        actual   [${actual}]`);
}

// --- 1. First window seen establishes the baseline order -------------------
{
  const store = makeStore(["a", "b", "c"]);
  CGXOrder.reconcile(windowOf(store, ["a", "b", "c"]), store.values());
  expectOrder("first window keeps DOM order", store, ["a", "b", "c"]);
}

// --- 2. Scrolling up reveals earlier turns ---------------------------------
{
  const store = makeStore(["c", "d", "a", "b"]);
  CGXOrder.reconcile(windowOf(store, ["c", "d"]), store.values());
  CGXOrder.reconcile(windowOf(store, ["a", "b", "c"]), store.values());
  expectOrder("earlier turns land before known ones", store, ["a", "b", "c", "d"]);
}

// --- 3. Scrolling down reveals later turns ---------------------------------
{
  const store = makeStore(["a", "b", "c", "d"]);
  CGXOrder.reconcile(windowOf(store, ["a", "b"]), store.values());
  CGXOrder.reconcile(windowOf(store, ["b", "c", "d"]), store.values());
  expectOrder("later turns land after known ones", store, ["a", "b", "c", "d"]);
}

// --- 4. A window that fills a gap between two known turns ------------------
{
  const store = makeStore(["a", "z", "m", "n"]);
  CGXOrder.reconcile(windowOf(store, ["a", "z"]), store.values());
  CGXOrder.reconcile(windowOf(store, ["a", "m", "n", "z"]), store.values());
  expectOrder("gap fillers interpolate between anchors", store, ["a", "m", "n", "z"]);
}

// --- 5. Disjoint window (jumped past unseen turns) appends at the end ------
{
  const store = makeStore(["a", "b", "y", "z"]);
  CGXOrder.reconcile(windowOf(store, ["a", "b"]), store.values());
  CGXOrder.reconcile(windowOf(store, ["y", "z"]), store.values());
  expectOrder("disjoint window appends after known turns", store, ["a", "b", "y", "z"]);
}

// --- 6. A stale rank that contradicts the observed order gets repaired -----
{
  const store = makeStore(["a", "b", "c"]);
  CGXOrder.reconcile(windowOf(store, ["a", "b", "c"]), store.values());
  // Simulate a branch edit leaving `b` with a rank from a different branch.
  store.get("b").rank = 999999;
  CGXOrder.reconcile(windowOf(store, ["a", "b", "c"]), store.values());
  expectOrder("contradictory rank is re-derived", store, ["a", "b", "c"]);
}

// --- 7. Explicit turn numbers win over relative ranks ----------------------
{
  const store = makeStore(["a", "b", "c"]);
  CGXOrder.reconcile(windowOf(store, ["c", "b", "a"]), store.values());
  store.get("a").turn = 1;
  store.get("b").turn = 3;
  store.get("c").turn = 5;
  expectOrder("absolute turn numbers take precedence", store, ["a", "b", "c"]);
}

// --- 7b. A single missing turn number drops the whole set back to ranks ----
// Mixing the two keys would make the comparator intransitive, so turn numbers
// are only honoured when every entry has one.
{
  const store = makeStore(["a", "b", "c"]);
  CGXOrder.reconcile(windowOf(store, ["a", "b", "c"]), store.values());
  store.get("a").turn = 9;
  store.get("c").turn = 1;
  expectOrder("partial turn numbers are ignored in favour of ranks", store, ["a", "b", "c"]);
}

// --- 8. Long conversation walked in overlapping windows --------------------
{
  const ids = Array.from({ length: 60 }, (_, i) => `t${i}`);
  const store = makeStore(ids);
  const WINDOW = 8;
  const STEP = 5;
  for (let start = 0; start + WINDOW <= ids.length; start += STEP) {
    CGXOrder.reconcile(windowOf(store, ids.slice(start, start + WINDOW)), store.values());
  }
  CGXOrder.reconcile(windowOf(store, ids.slice(-WINDOW)), store.values());
  expectOrder("60 turns walked in sliding windows stay ordered", store, ids);
}

// --- 9. Same conversation walked bottom-to-top -----------------------------
{
  const ids = Array.from({ length: 40 }, (_, i) => `t${i}`);
  const store = makeStore(ids);
  const WINDOW = 6;
  const STEP = 4;
  for (let start = ids.length - WINDOW; start >= 0; start -= STEP) {
    CGXOrder.reconcile(windowOf(store, ids.slice(start, start + WINDOW)), store.values());
  }
  CGXOrder.reconcile(windowOf(store, ids.slice(0, WINDOW)), store.values());
  expectOrder("scrolling upwards through 40 turns stays ordered", store, ids);
}

// --- 10. Repeatedly halving the same gap renormalises instead of colliding -
// Each insertion goes between t18 and the previously inserted turn, so the
// available gap halves every time. Without renormalisation the interpolation
// step underflows to zero after ~50 rounds and the ranks start colliding.
{
  const base = Array.from({ length: 20 }, (_, i) => `t${i}`);
  const store = makeStore(base);
  CGXOrder.reconcile(windowOf(store, base), store.values());

  const inserted = [];
  let seq = base.length;
  let prev = "t19";
  for (let i = 0; i < 200; i++) {
    const id = `x${i}`;
    store.set(id, { id, rank: null, seq: seq++ });
    CGXOrder.reconcile(windowOf(store, ["t18", id, prev]), store.values());
    inserted.push(id);
    prev = id;
  }

  const expected = [...base.slice(0, 19), ...inserted.slice().reverse(), "t19"];
  expectOrder("200 halving insertions stay correctly ordered", store, expected);

  const ranks = Array.from(store.values()).map((e) => e.rank);
  check("every rank is finite after renormalising", ranks.every((r) => Number.isFinite(r)));
  check("no two turns share a rank", new Set(ranks).size === ranks.length, `${ranks.length - new Set(ranks).size} collisions`);
}

// --- 11. reconcile reports whether anything moved --------------------------
{
  const store = makeStore(["a", "b"]);
  const first = CGXOrder.reconcile(windowOf(store, ["a", "b"]), store.values());
  const second = CGXOrder.reconcile(windowOf(store, ["a", "b"]), store.values());
  check("first reconcile reports a change", first === true);
  check("re-observing an unchanged window reports no change", second === false);
}

console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
