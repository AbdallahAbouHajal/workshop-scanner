// Which Sheet a scan goes to (5 Nov 2026). A door phone can read two Sheets: its campus visitors' Sheet (1) and the graduates'
// Sheet (2), both named in the staff link (#api=…&key=…&api2=…&key2=…). The phone loads the workshop's guest list from both,
// sends a scan to the Sheet whose list has the code, and sends a code neither list has to the campus Sheet first; if that Sheet
// does not know it, the same scan is passed on to the graduates' Sheet. Walk-ins always go to the campus Sheet. Each Sheet keeps
// its own queue on the phone. Tests: tests/scanner-route.test.js. Used by app.js.
(function (root, make) {
  if (typeof module === 'object' && module.exports) module.exports = make(); else root.ScanRoute = make();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const API_RE = /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]{20,}\/exec$/, KEY_RE = /^[0-9a-f]{32}$/, WS_RE = /^[A-Za-z0-9]{1,12}$/;

  // the staff link's # part -> {api, key, api2, key2, w, bad, given}; bad: a link that must not be used
  function parseLink(hash) {
    const p = new URLSearchParams(String(hash || '').replace(/^#/, ''));
    const api = p.get('api') || '', key = p.get('key') || '', api2 = p.get('api2') || '', key2 = p.get('key2') || '', w = p.get('w') || '';
    const given = !!(api || key);
    let bad = false;
    if (given && (!API_RE.test(api) || !KEY_RE.test(key))) bad = true;
    if ((api2 || key2) && (!API_RE.test(api2) || !KEY_RE.test(key2) || api2 === api)) bad = true;
    return { api: api, key: key, api2: api2, key2: key2, w: WS_RE.test(w) ? w : '', bad: bad, given: given };
  }
  // the hello answers' guest lists ([hash, name, inside, status]) -> {hash: {name, inside, status, b}}; the campus Sheet wins a tie
  function mergeGuests(list1, list2) {
    const out = {};
    [[list2, 2], [list1, 1]].forEach(([list, b]) => (list || []).forEach(([h, n, inside, status]) => {
      out[h] = { name: n, inside: !!inside, status: status || '', b: b };
    }));
    return out;
  }
  // where a scan of this hash goes: {to: 1 | 2, auto}; auto = not in either list, so the campus Sheet is asked first
  function target(hash, guests) {
    const g = guests && guests[hash];
    return g && g.b === 2 ? { to: 2, auto: false } : g ? { to: 1, auto: false } : { to: 1, auto: true };
  }
  // pass this answered scan on to the graduates' Sheet? Every scan sent to the campus Sheet because neither list had it, that the
  // campus Sheet did not know. The graduates' Sheet answers for itself (also when it lacks the workshop), so the phone does not
  // need its list first: a new phone, or one whose last call to that Sheet failed, still reaches it (devil review, 5 Nov 2026).
  function forward(item, result, two) {
    return !!(two && two.has2 && item && item.action !== 'walkin' && item.auto && item.to !== 2 && result && result.effect === 'UNKNOWN');
  }
  function passOn(item, newId) { return Object.assign({}, item, { scanId: newId(), to: 2, auto: false }); }
  function sumCounts(a, b) {
    if (!a && !b) return null;
    const n = (x, k) => (x && Number(x[k])) || 0;
    return { inside: n(a, 'inside') + n(b, 'inside'), checkedIn: n(a, 'checkedIn') + n(b, 'checkedIn'), certificates: n(a, 'certificates') + n(b, 'certificates') };
  }
  function mergeWorkshops(list1, list2) {
    const out = (list1 || []).slice(), have = {};
    out.forEach(w => { have[w.key] = true; });
    (list2 || []).forEach(w => { if (!have[w.key]) { out.push(w); have[w.key] = true; } });
    return out;
  }
  // the saved queue's items for one Sheet (items saved before 5 Nov 2026 have no api and belong to the campus Sheet), and the
  // items for a Sheet this phone no longer uses: kept, never sent elsewhere
  function forSheet(all, api, primary) { return (all || []).filter(x => x && (x.api ? x.api === api : api === primary)); }
  function heldBack(all, apis) { return (all || []).filter(x => x && x.api && apis.indexOf(x.api) < 0); }
  return { parseLink, mergeGuests, target, forward, passOn, sumCounts, mergeWorkshops, forSheet, heldBack, API_RE, KEY_RE, WS_RE };
});
