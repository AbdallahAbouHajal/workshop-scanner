// The phone's scan queue (3 Nov 2026). Every scan is saved on the phone first and leaves only when the Sheet has answered for
// its scan ID, so nothing is lost when the connection drops or the Sheet is busy. One request at a time; everything waiting goes
// in one request (up to 25 scans), so a burst at the door becomes one or two requests. A request that fails is tried again after
// 2, 5, 10, then every 30 seconds. A walk-in goes on its own. Tests: tests/scanner-queue.test.js. Used by app.js.
(function (root, make) {
  if (typeof module === 'object' && module.exports) module.exports = make(); else root.ScanQueue = make();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const WAITS = [2000, 5000, 10000, 30000], BATCH = 25, GIVE_UP = 5;

  // o: load() -> saved items; save(items); send(batch) -> Promise of the Sheet's answer {ok, results: [{scanId, effect, ...}]};
  // onResult(item, result) for each answered scan; onState({waiting, retrying, oldest}); later(fn, ms) and cancel(t) for timers.
  function create(o) {
    let items = (o.load() || []).filter(x => x && x.scanId), busy = false, paused = false, tries = 0, timer = null, stopped = '';
    const api = { onBlocked: null };
    const later = o.later || ((fn, ms) => setTimeout(fn, ms)), cancel = o.cancel || (t => clearTimeout(t));
    const state = () => { if (o.onState) o.onState({ waiting: items.length, retrying: tries > 0, oldest: items.length ? items[0].at : null, stopped: stopped }); };
    const save = () => { o.save(items); state(); };
    // the next request: a walk-in alone, or the scans in front of the next walk-in, up to BATCH
    function next() {
      if (!items.length) return [];
      if (items[0].action === 'walkin') return [items[0]];
      const out = [];
      for (const x of items) { if (x.action === 'walkin' || out.length >= BATCH) break; out.push(x); }
      return out;
    }
    function go() {
      if (busy || paused || stopped || timer || !items.length) return;
      busy = true;
      const batch = next();
      Promise.resolve().then(() => o.send(batch)).then(res => {
        if (res && res.ok === false && res.error === 'key') { stopped = 'key'; if (api.onBlocked) api.onBlocked('key'); return; }
        if (!res || res.ok === false || !Array.isArray(res.results)) throw new Error((res && (res.detail || res.error)) || 'no answer');
        const byId = {};
        res.results.forEach(r => { if (r && r.scanId) byId[r.scanId] = r; });
        let done = 0;
        batch.forEach(x => {
          const r = byId[x.scanId];
          if (!r || r.effect === 'RETRY') return;
          if (r.effect === 'ERROR') { x.errors = (x.errors || 0) + 1; if (x.errors < GIVE_UP) return; }
          items.splice(items.indexOf(x), 1); done++;
          try { o.onResult(x, r); } catch (e) { /* the screen failed to show it; the scan is recorded */ }
        });
        tries = done > 0 ? 0 : tries + 1;               // some got through: send the rest now; none did: wait, then try again
      }).catch(() => { tries++; }).then(() => {
        busy = false; save();
        if (stopped || !items.length) return;
        if (tries) timer = later(() => { timer = null; go(); }, WAITS[Math.min(tries - 1, WAITS.length - 1)]);
        else go();
      });
    }
    api.add = x => { items.push(x); save(); go(); };
    api.size = () => items.length;
    api.list = () => items.slice();
    api.pause = () => { paused = true; };
    api.resume = () => { paused = false; go(); };
    // a new connection, the page coming back into view or a new staff key: try now instead of waiting for the timer
    api.kick = () => { stopped = ''; if (timer) { cancel(timer); timer = null; } tries = 0; go(); };
    state();
    return api;
  }

  // The camera reads a pass many times a second, and a pass held up after an exit is read again 10 seconds later (seen in the
  // 2 Nov 2026 trial). The same pass in the same mode within 60 seconds is the same scan. A fix tapped by staff is never checked.
  function isRepeat(last, code, mode, now) {
    const k = code + '|' + mode;
    if (last[k] != null && now - last[k] < 60000) return true;
    last[k] = now;
    return false;
  }
  return { create: create, isRepeat: isRepeat, WAITS: WAITS, BATCH: BATCH };
});
