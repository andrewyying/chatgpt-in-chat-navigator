/**
 * Relative ordering for virtualised conversations.
 *
 * ChatGPT only mounts a window of turns at a time, so the sidebar has to place
 * prompts it can no longer see. When the markup exposes an absolute turn number
 * that number is used directly. When it doesn't, this module keeps a fractional
 * `rank` per entry and repairs it from each observed window: anything seen
 * between two already-ranked turns is interpolated between their ranks, and
 * anything seen before/after everything known is extended outwards.
 *
 * The result is a total order consistent with every window observed so far,
 * without ever needing the whole conversation in the DOM at once.
 */
var CGXOrder = (function () {
  "use strict";

  const GAP = 1024;

  function isRanked(entry) {
    return entry && typeof entry.rank === "number" && Number.isFinite(entry.rank);
  }

  // Longest strictly-increasing subsequence of anchors by rank. Editing a
  // prompt makes ChatGPT re-key a branch, which can leave a few stale ranks
  // that contradict the observed order; keeping the largest self-consistent
  // set and re-deriving the rest repairs that without discarding good data.
  function longestIncreasingByRank(anchors) {
    const n = anchors.length;
    if (n <= 1) return anchors.slice();
    const tails = [];
    const prev = new Array(n).fill(-1);
    for (let i = 0; i < n; i++) {
      const r = anchors[i].rank;
      let lo = 0;
      let hi = tails.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (anchors[tails[mid]].rank < r) lo = mid + 1;
        else hi = mid;
      }
      if (lo > 0) prev[i] = tails[lo - 1];
      tails[lo] = i;
    }
    const out = [];
    let k = tails.length ? tails[tails.length - 1] : -1;
    while (k >= 0) {
      out.push(anchors[k]);
      k = prev[k];
    }
    out.reverse();
    return out;
  }

  // Re-space existing ranks onto a clean integer grid. Only needed if repeated
  // interpolation ever exhausts the gap between two neighbours. Entries that
  // are not placed yet are deliberately left alone — giving them a rank here
  // would assert a position the caller has not observed.
  function renormalize(allEntries) {
    const list = Array.from(allEntries).filter(isRanked);
    list.sort((a, b) => a.rank - b.rank || (a.seq || 0) - (b.seq || 0));
    for (let i = 0; i < list.length; i++) list[i].rank = i * GAP;
  }

  function outsideBound(allEntries, windowSet, boundary, direction) {
    let best = null;
    for (const entry of allEntries) {
      if (windowSet.has(entry) || !isRanked(entry)) continue;
      if (direction < 0) {
        if (entry.rank < boundary && (best === null || entry.rank > best)) best = entry.rank;
      } else if (entry.rank > boundary && (best === null || entry.rank < best)) {
        best = entry.rank;
      }
    }
    return best;
  }

  // Place `entries` strictly between lo and hi, evenly spaced. Returns false
  // if the gap is too narrow to subdivide — note that a positive step is not
  // enough to guarantee that, because `lo + step` absorbs back to `lo` once the
  // step drops below one ulp of lo. Values are computed up front so a rejected
  // spread leaves no partial assignment behind.
  function spread(entries, lo, hi) {
    const step = (hi - lo) / (entries.length + 1);
    if (!(step > 0)) return false;
    const values = [];
    let prev = lo;
    for (let i = 0; i < entries.length; i++) {
      const value = lo + step * (i + 1);
      if (!(value > prev) || !(value < hi)) return false;
      values.push(value);
      prev = value;
    }
    for (let i = 0; i < entries.length; i++) entries[i].rank = values[i];
    return true;
  }

  /**
   * Assign ranks so that `windowEntries` (in observed DOM order) is ordered
   * correctly relative to itself and to everything already in `allEntries`.
   * Mutates `entry.rank`. Returns true if any rank changed.
   */
  function reconcile(windowEntries, allEntries, depth) {
    const win = Array.from(windowEntries || []);
    if (!win.length) return false;
    const all = Array.from(allEntries || win);
    const before = win.map((e) => (isRanked(e) ? e.rank : null));

    const windowSet = new Set(win);
    const anchorCandidates = [];
    for (let i = 0; i < win.length; i++) {
      if (isRanked(win[i])) anchorCandidates.push({ idx: i, rank: win[i].rank, entry: win[i] });
    }
    const anchors = longestIncreasingByRank(anchorCandidates);
    const anchorAt = new Map(anchors.map((a) => [a.idx, a]));
    // Anchors that lost the consistency vote get re-derived below.
    for (const cand of anchorCandidates) {
      if (!anchorAt.has(cand.idx)) cand.entry.rank = null;
    }

    if (!anchors.length) {
      // Nothing in this window is placed yet. Either it's the first window we
      // have ever seen, or it's fully disjoint from what we know — in both
      // cases appending after the highest known rank is the safe reading,
      // since new turns only ever arrive at the end.
      let base = -GAP;
      for (const entry of all) {
        if (!windowSet.has(entry) && isRanked(entry) && entry.rank > base) base = entry.rank;
      }
      for (let i = 0; i < win.length; i++) win[i].rank = base + (i + 1) * GAP;
      return true;
    }

    let ok = true;

    // Leading run, before the first anchor.
    const firstAnchor = anchors[0];
    if (firstAnchor.idx > 0) {
      const pending = win.slice(0, firstAnchor.idx);
      const lowerOutside = outsideBound(all, windowSet, firstAnchor.rank, -1);
      if (lowerOutside === null) {
        for (let i = 0; i < pending.length; i++) {
          pending[i].rank = firstAnchor.rank - (pending.length - i) * GAP;
        }
      } else if (!spread(pending, lowerOutside, firstAnchor.rank)) {
        ok = false;
      }
    }

    // Runs between consecutive anchors.
    for (let a = 0; a < anchors.length - 1 && ok; a++) {
      const lo = anchors[a];
      const hi = anchors[a + 1];
      if (hi.idx - lo.idx <= 1) continue;
      const pending = win.slice(lo.idx + 1, hi.idx);
      if (!spread(pending, lo.rank, hi.rank)) ok = false;
    }

    // Trailing run, after the last anchor.
    const lastAnchor = anchors[anchors.length - 1];
    if (ok && lastAnchor.idx < win.length - 1) {
      const pending = win.slice(lastAnchor.idx + 1);
      const upperOutside = outsideBound(all, windowSet, lastAnchor.rank, 1);
      if (upperOutside === null) {
        for (let i = 0; i < pending.length; i++) pending[i].rank = lastAnchor.rank + (i + 1) * GAP;
      } else if (!spread(pending, lastAnchor.rank, upperOutside)) {
        ok = false;
      }
    }

    if (!ok) {
      // Ran out of floating-point room between two neighbours. Re-space the
      // placed entries onto a fresh integer grid and lay the window out again.
      // One pass is always enough: the retry has full GAP-sized gaps to work
      // with, so the depth guard only exists to make that non-negotiable.
      if (depth) return true;
      renormalize(all);
      reconcile(win, all, 1);
      return true;
    }

    for (let i = 0; i < win.length; i++) {
      if (before[i] !== win[i].rank) return true;
    }
    return false;
  }

  /** Order by reconciled rank, with discovery order as the tiebreak. */
  function compare(a, b) {
    const ar = isRanked(a) ? a.rank : Infinity;
    const br = isRanked(b) ? b.rank : Infinity;
    if (ar !== br) return ar - br;
    return (a.seq || 0) - (b.seq || 0);
  }

  function hasTurn(entry) {
    return typeof entry.turn === "number" && Number.isFinite(entry.turn);
  }

  function hasApiIndex(entry) {
    return typeof entry.apiIndex === "number" && Number.isFinite(entry.apiIndex);
  }

  // Order entries that the conversation API did not account for: absolute turn
  // numbers from the markup if *every* one has them, otherwise reconciled
  // ranks. It is all-or-nothing because turn order and rank order can
  // disagree, and mixing them would make the comparator intransitive.
  function sortByMarkup(list) {
    if (list.length > 1 && list.every(hasTurn)) {
      list.sort((a, b) => a.turn - b.turn || (a.seq || 0) - (b.seq || 0));
    } else {
      list.sort(compare);
    }
    return list;
  }

  /**
   * Order entries for display.
   *
   * The conversation API gives an exact position on the active branch, so it
   * wins outright where present. Entries it doesn't cover are messages sent
   * after the fetch, which always belong at the end — so the two groups are
   * partitioned rather than interleaved. Partitioning also sidesteps having to
   * make two unrelated ordering keys comparable.
   */
  function sortEntries(entries) {
    const list = Array.from(entries || []);
    const fromApi = [];
    const fromMarkup = [];
    for (const entry of list) (hasApiIndex(entry) ? fromApi : fromMarkup).push(entry);
    if (!fromApi.length) return sortByMarkup(fromMarkup);
    fromApi.sort((a, b) => a.apiIndex - b.apiIndex);
    if (!fromMarkup.length) return fromApi;
    return fromApi.concat(sortByMarkup(fromMarkup));
  }

  return {
    GAP,
    compare,
    hasApiIndex,
    hasTurn,
    isRanked,
    longestIncreasingByRank,
    reconcile,
    renormalize,
    sortEntries
  };
})();

if (typeof module !== "undefined" && module.exports) module.exports = CGXOrder;
