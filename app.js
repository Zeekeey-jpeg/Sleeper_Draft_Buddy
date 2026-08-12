/* ============================================================
 * Draft Buddy — app layer: SleeperClient + control-hub UI
 * Engine (pure math) lives in engine.js as window.DraftEngine.
 * ============================================================ */
'use strict';
const E = window.DraftEngine;
const API = 'https://api.sleeper.app';
const SEASON = '2026';
const LAST_SEASON = '2025';
const CDN_HEAD = (id) => 'https://sleepercdn.com/content/nfl/players/thumb/' + encodeURIComponent(id) + '.jpg';
const CDN_TEAM = (t) => 'https://sleepercdn.com/images/team_logos/nfl/' + encodeURIComponent(String(t || '').toLowerCase()) + '.png';

/* ---------------- settings & personal lists ---------------- */
const DEFAULTS = {
  username: '', // optional Sleeper username — used only to auto-detect your seat
  userId: '',
  pollMs: 500,
};
const store = {
  get(k, fb) { try { const v = localStorage.getItem('db.' + k); return v == null ? fb : JSON.parse(v); } catch (e) { return fb; } },
  set(k, v) { try { localStorage.setItem('db.' + k, JSON.stringify(v)); } catch (e) { /* full/blocked: non-fatal */ } },
};
const settings = Object.assign({}, DEFAULTS, store.get('settings', {}));
// migration: old builds defaulted to 1000-4000ms — too slow for a live room
if (settings.pollMs > 500) { settings.pollMs = 500; store.set('settings', settings); }
delete settings.leagueId; // pre-open-source builds pinned a league here
const avoidIds = new Set(store.get('avoid', []));
const starIds = new Set(store.get('stars', []));

/* ---------------- adaptive shell: single codebase, single URL ----------------
 * body.mobile toggles the tabbed phone layout; every mobile CSS rule is scoped
 * under it, so desktop is byte-identical regardless of what this returns. */
function shellMode() {
  const forced = store.get('shell', 'auto'); // 'auto' | 'mobile' | 'desktop'
  if (forced !== 'auto') return forced;
  // phones get the mobile shell; iPads (768px+ logical) and laptops get the full cockpit
  const coarse = matchMedia('(pointer: coarse)').matches;
  const narrow = matchMedia('(max-width: 700px)').matches;
  return (coarse && narrow) || matchMedia('(max-width: 560px)').matches ? 'mobile' : 'desktop';
}
function applyShell() {
  document.body.classList.toggle('mobile', shellMode() === 'mobile');
}

/* ---------------- app state ---------------- */
const S = {
  league: null,
  pool: null, statsLast: {}, shape: null, playersDb: null,
  draft: null, draftId: null, picks: [], mySeat: null,
  slotNames: {}, analysis: null, lockedPos: '',
  polling: null, errStreak: 0,
  lastPickCount: -1, poolFilter: { q: '', pos: '' },
  statusTick: 0,
  // always-live lifecycle: pollActive gates whether the chain is allowed to run
  // at all; pollGen invalidates any in-flight/scheduled tick the instant a
  // cycle stops or restarts (a fetch suspended mid-flight for minutes on iOS
  // resolves into a no-op instead of clobbering fresher state).
  pollActive: false, pollGen: 0, lastTickAt: 0, _tickBusy: false,
};

/* ---------------- tiny DOM helpers ---------------- */
const $ = (id) => document.getElementById(id);
const el = (tag, cls, html) => { const n = document.createElement(tag); if (cls) n.className = cls; if (html != null) n.innerHTML = html; return n; };
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function toast(msg) {
  const t = el('div', 'toast', esc(msg));
  $('toasts').appendChild(t);
  setTimeout(() => t.remove(), 6000);
}
function setConn(state, txt) { const c = $('conn'); c.className = state; $('connTxt').textContent = txt; }
function banner(msg, isErr) {
  const b = $('banner');
  if (!msg) { b.style.display = 'none'; return; }
  b.style.display = 'block'; b.className = isErr ? 'err' : ''; b.textContent = msg;
}
function showView(id) {
  document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
  $(id).classList.add('active');
}
function headshotHtml(p, size) {
  const initials = esc((p.name || '?').split(' ').map((w) => w[0] || '').join('').slice(0, 2));
  return '<img class="head" loading="lazy" src="' + CDN_HEAD(p.id) + '" alt="" ' +
    'onerror="this.style.display=\'none\';this.nextElementSibling.style.display=\'flex\'">' +
    '<div class="initials" style="display:none">' + initials + '</div>';
}

/* ---------------- Sleeper client ---------------- */
async function api(path) {
  // no-store: a resumed WebKit process must never serve a heuristic-cached
  // picks response — staleness during a live draft is the one unacceptable bug.
  const res = await fetch(API + path, { cache: 'no-store' });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + path);
  return res.json();
}
function noteOk() {
  S.errStreak = 0; banner(null); setConn('live', 'live');
  const dot = document.querySelector('#conn .dot');
  if (dot) { dot.classList.remove('ping'); void dot.offsetWidth; dot.classList.add('ping'); }
}
function noteErr(e) {
  S.errStreak++;
  if (S.errStreak >= 2) { setConn('err', 'reconnecting'); banner('Connection to Sleeper lost — retrying every few seconds…', true); }
}

/* Trimmed player DB: only IDs we might ever render, cached 24h. */
async function loadPlayersDb(neededIds) {
  const cached = store.get('playersCacheV2', null);
  if (cached && Date.now() - cached.at < 24 * 3600 * 1000) return cached.map;
  const full = await api('/v1/players/nfl');
  const map = {};
  for (const id of Object.keys(full)) {
    const p = full[id];
    if (!p) continue;
    if (neededIds.has(id) || (p.fantasy_positions || []).some((x) => ['QB', 'RB', 'WR', 'TE'].includes(x)) && p.active) {
      map[id] = {
        first_name: p.first_name, last_name: p.last_name, team: p.team, position: p.position,
        injury_status: p.injury_status, injury_body_part: p.injury_body_part,
        news_updated: p.news_updated, years_exp: p.years_exp,
      };
    }
  }
  store.set('playersCacheV2', { at: Date.now(), map });
  return map;
}

/* League-independent data (projections, stats, trending, player DB).
 * Fetched once per session, on first attach; the pool itself is rebuilt
 * per-draft because scoring/shape come from the attached draft. */
let staticDataP = null;
function loadStaticData() {
  if (staticDataP) return staticDataP;
  staticDataP = (async () => {
    const posQ = 'season_type=regular&position[]=QB&position[]=RB&position[]=WR&position[]=TE';
    const [projections, statsLast, trending, dropping] = await Promise.all([
      api('/projections/nfl/' + SEASON + '?' + posQ),
      api('/stats/nfl/' + LAST_SEASON + '?' + posQ).catch(() => []),
      api('/v1/players/nfl/trending/add?limit=60').catch(() => []),
      api('/v1/players/nfl/trending/drop?limit=60').catch(() => []),
    ]);
    const needed = new Set(projections.map((r) => String(r.player_id)));
    const playersDb = await loadPlayersDb(needed);
    const trendingMap = {};
    for (const t of trending) trendingMap[String(t.player_id)] = t.count;
    const droppingMap = {};
    for (const t of dropping) droppingMap[String(t.player_id)] = t.count;
    for (const row of statsLast) {
      const st = row.stats || {};
      if (st.pts_ppr) S.statsLast[String(row.player_id)] = {
        pts: Math.round(st.pts_ppr), gp: st.gp || 0,
        ppg: st.gp ? Math.round((st.pts_ppr / st.gp) * 10) / 10 : 0,
        rank: st.rank_ppr || null,
      };
    }
    S.playersDb = playersDb;
    return { projections, playersDb, trendingMap, droppingMap };
  })().catch((e) => { staticDataP = null; throw e; });
  return staticDataP;
}
function buildPoolForShape(data) {
  S.pool = E.buildPool(data.projections, data.playersDb, S.shape, {
    trendingMap: data.trendingMap, droppingMap: data.droppingMap, now: Date.now(),
  });
  rebuildValues();
}
function rebuildValues() {
  const { levels } = E.replacementLevels(S.pool, S.shape);
  E.applyVorp(S.pool, levels);
  E.applyMarketBlend(S.pool);
  E.assignTiers(S.pool);
}

/* ---------------- attach view (one flow — mock and league drafts are
 * identical to the engine; everything comes from the draft object) ------- */
function showAttach() {
  attachStatus('');
  renderRejoinChip();
  renderDraftList();
  showView('viewMock');
  $('mockIdInput').focus();
}
function attachStatus(msg) { $('attachStatus').textContent = msg || ''; }

/* ---------------- draft discovery: username -> drafts, rejoin-last ---------------- */
// Shared by the Settings modal and the discovery lane — one lookup, one place
// that decides what "known user" means for seat auto-detect everywhere else.
async function resolveUser(name) {
  const u = await api('/v1/user/' + encodeURIComponent(name));
  settings.username = u.display_name || name;
  settings.userId = u.user_id;
  store.set('settings', settings);
  return { username: settings.username, userId: settings.userId };
}
function draftLabel() {
  return (S.league && S.league.name) || (S.draft && S.draft.metadata && S.draft.metadata.name) || 'Your draft';
}
function renderRejoinChip() {
  const chip = $('rejoinChip');
  const last = store.get('lastDraft', null);
  const stale = last && last.status === 'complete' && Date.now() - (last.ts || 0) > 24 * 3600 * 1000;
  if (!last || !last.draftId || stale) { chip.style.display = 'none'; chip.onclick = null; return; }
  chip.style.display = 'flex';
  chip.innerHTML = '<span>↻ Rejoin <b>' + esc(last.label || 'your last draft') + '</b> · Seat ' + esc(last.seat) + '</span>' +
    '<button class="x" title="dismiss">✕</button>';
  chip.onclick = (e) => { if (e.target.closest('.x')) return; attach(last.draftId, { preselectSeat: last.seat }); };
  chip.querySelector('.x').onclick = (e) => {
    e.stopPropagation();
    store.set('lastDraft', null);
    chip.style.display = 'none';
    chip.onclick = null;
  };
}
async function tryDiscover() {
  const uname = $('discUser').value.trim();
  if (!uname) { toast('Type a Sleeper username first'); return; }
  discoverState('loading', uname);
  try {
    await resolveUser(uname);
    await renderDraftList();
  } catch (e) {
    discoverState('notfound', uname);
  }
}
// Inline states in #draftList itself — a 6s toast disappears before a drafter
// on a phone reads it; these have to sit there until acted on.
function discoverState(kind, uname) {
  const box = $('draftList');
  if (kind === 'loading') {
    box.innerHTML = '<div class="discState">looking up ' + esc(uname || settings.username || '') + '…</div>';
  } else if (kind === 'notfound') {
    box.innerHTML = '<div class="discState err">Couldn’t find that Sleeper username — check the spelling.</div>';
  } else if (kind === 'empty') {
    box.innerHTML = '<div class="discState">No drafts visible for ' + esc(settings.username) + '. Heads up: mocks started in the ' +
      'Sleeper phone app’s lobby are invisible outside Sleeper — start your mock at sleeper.com in a browser and it’ll ' +
      'show up here. League drafts always show.</div>';
  } else if (kind === 'error') {
    box.innerHTML = '<div class="discState err">Couldn’t reach Sleeper — <button class="retryBtn" id="discRetry">tap to retry</button></div>';
    $('discRetry').onclick = () => renderDraftList();
  } else {
    box.innerHTML = '';
  }
}
async function renderDraftList() {
  const ask = $('discoverAsk');
  if (!settings.userId) { ask.style.display = 'flex'; discoverState('none'); return; }
  ask.style.display = 'none';
  discoverState('loading');
  try {
    const drafts = await api('/v1/user/' + settings.userId + '/drafts/nfl/' + SEASON);
    if (!drafts.length) { discoverState('empty'); return; }
    const rank = { drafting: 0, pre_draft: 1, complete: 2 };
    const sorted = drafts.slice().sort((a, b) => {
      const ra = rank[a.status] ?? 3, rb = rank[b.status] ?? 3;
      if (ra !== rb) return ra - rb;
      if (a.status === 'pre_draft') return (a.start_time || Infinity) - (b.start_time || Infinity);
      return 0;
    });
    const active = sorted.filter((d) => d.status !== 'complete');
    const done = sorted.filter((d) => d.status === 'complete').slice(0, 5);
    renderDraftRows(active.concat(done));
  } catch (e) {
    discoverState('error');
  }
}
function renderDraftRows(drafts) {
  const box = $('draftList'); box.innerHTML = '';
  for (const d of drafts) {
    const row = el('button', 'draftRow' + (d.status === 'complete' ? ' done' : ''));
    const name = (d.metadata && d.metadata.name) || (d.league_id ? 'League draft' : 'Mock draft');
    const teams = d.settings && d.settings.teams;
    const when = d.start_time ? new Date(d.start_time).toLocaleDateString() : '';
    const label = d.status === 'drafting' ? '🔴 LIVE' : d.status === 'pre_draft' ? '⏳ scheduled' : 'done';
    row.innerHTML =
      '<span class="dstatus ' + esc(d.status || '') + '">' + esc(label) + '</span>' +
      '<span class="dn">' + esc(name) + '</span>' +
      '<span class="dmeta">' + (teams ? teams + '-team' : '') + (d.type ? ' · ' + esc(d.type) : '') + (when ? ' · ' + when : '') + '</span>';
    row.onclick = () => attach(d.draft_id);
    box.appendChild(row);
  }
}

/* ---------------- attach + seat picker ---------------- */
// opts.preselectSeat: seat-picker preselect only (still requires "Lock it in").
// opts.autoSeat: eviction-recovery boot path — bypasses the picker entirely.
async function attach(draftId, opts) {
  opts = opts || {};
  try {
    banner(null);
    attachStatus('connecting to draft…');
    const draft = await api('/v1/draft/' + draftId);
    if (opts.autoSeat && draft.status === 'complete') {
      // stale eviction record pointing at a finished draft — don't trap the user, just go home
      store.set('activeDraft', null);
      attachStatus('');
      goHome();
      return;
    }
    // league (scoring + team names) rides along when the draft belongs to one
    let league = null, leagueUsers = [];
    if (draft.league_id) {
      [league, leagueUsers] = await Promise.all([
        api('/v1/league/' + draft.league_id).catch(() => null),
        api('/v1/league/' + draft.league_id + '/users').catch(() => []),
      ]);
    }
    S.league = league;
    S.draft = draft; S.draftId = draftId; S.picks = []; S.lastPickCount = -1;
    S.shape = E.leagueShape(league, draft.settings);
    attachStatus('loading projections + player data…');
    buildPoolForShape(await loadStaticData());
    // slot -> display name, straight from the draft itself
    const userById = {};
    for (const u of leagueUsers) userById[u.user_id] = (u.metadata && u.metadata.team_name) || u.display_name;
    const order = draft.draft_order || {};
    const unresolved = Object.keys(order).filter((uid) => !userById[uid]);
    await Promise.all(unresolved.map((uid) =>
      api('/v1/user/' + uid).then((u) => { userById[uid] = u.display_name; }).catch(() => {})
    ));
    S.slotNames = {};
    for (const uid in order) S.slotNames[order[uid]] = userById[uid] || ('user ' + uid.slice(-4));
    for (let i = 1; i <= S.shape.teams; i++) if (!S.slotNames[i]) S.slotNames[i] = draft.league_id ? 'Team ' + i : 'CPU ' + i;
    if (opts.autoSeat && opts.autoSeat <= S.shape.teams) {
      attachStatus('');
      toast('Rejoined your draft — tap ⌂ to leave');
      startDraftSession(opts.autoSeat);
      return;
    }
    // seat preselect: a rejoin request wins outright, then configured username, else the lone human in a mock
    let pre = (opts.preselectSeat && opts.preselectSeat <= S.shape.teams ? opts.preselectSeat : null) ||
      (settings.userId && order[settings.userId]) || null;
    const humans = Object.keys(order);
    if (!pre && humans.length === 1) pre = order[humans[0]];
    attachStatus('');
    openSeatPicker(pre || null);
  } catch (e) {
    noteErr(e); attachStatus('');
    if (opts.autoSeat) { store.set('activeDraft', null); goHome(); return; } // broken eviction record — never trap the user
    toast('Could not load draft ' + draftId);
  }
}
function openSeatPicker(preselect) {
  const grid = $('seatGrid'); grid.innerHTML = '';
  let sel = preselect;
  $('seatHint').textContent = preselect
    ? 'Sleeper says you' + (settings.username ? ' (' + settings.username + ')' : '') + ' are seat ' + preselect + ' — confirm or change.'
    : 'Pick the slot you\'re drafting from.';
  for (let i = 1; i <= S.shape.teams; i++) {
    const b = el('button', 'seatBtn' + (i === preselect ? ' sel' : ''));
    b.append(el('div', 'n', String(i)), el('div', 'who', esc(S.slotNames[i] || '')));
    b.onclick = () => { sel = i; grid.querySelectorAll('.seatBtn').forEach((x) => x.classList.remove('sel')); b.classList.add('sel'); };
    grid.appendChild(b);
  }
  $('seatConfirm').onclick = () => {
    if (!sel) { toast('Pick a seat first'); return; }
    $('seatModal').classList.remove('on');
    startDraftSession(sel);
  };
  $('seatModal').classList.add('on');
}
function startDraftSession(seat) {
  S.mySeat = seat;
  $('seatChip').style.display = 'inline-block';
  $('seatChip').textContent = 'Seat ' + seat + ' · ' + (S.slotNames[seat] || settings.username);
  showView('viewDraft');
  startPolling();
  acquireWakeLock();
  const label = draftLabel();
  const status = S.draft && S.draft.status;
  // lastDraft: long-lived "you were here" record for the rejoin chip — goHome
  // does NOT clear it, only attaching a different draft overwrites it.
  store.set('lastDraft', { draftId: S.draftId, seat, label, status, ts: Date.now() });
  // activeDraft: eviction-recovery record — cleared on goHome/draft-complete,
  // read once at boot to auto-rejoin if the app was force-killed mid-draft.
  store.set('activeDraft', { draftId: S.draftId, seat, name: label, at: Date.now() });
}

/* ---------------- live picks polling ---------------- */
function startPolling() {
  stopPolling();
  S.pollActive = true;
  S.pollGen++;
  runTick(S.pollGen);
}
function stopPolling() {
  S.pollActive = false;
  S.pollGen++; // invalidates any in-flight/scheduled tick, even one mid-fetch
  if (S.polling) { clearTimeout(S.polling); S.polling = null; }
}
/* Immediate fetch, collapsing bursts: at most one tick per 250ms, and if a
 * tick's fetch is already in flight we just let it finish (it reschedules
 * itself). This is the entire "resume" contract — one fresh poll, never a
 * queue of catch-up ticks for time spent backgrounded. */
function pollNow() {
  if (!S.pollActive || S._tickBusy) return;
  if (Date.now() - S.lastTickAt < 250) return;
  if (S.polling) { clearTimeout(S.polling); S.polling = null; }
  S.pollGen++;
  runTick(S.pollGen);
}
function runTick(gen) {
  const tick = async () => {
    if (gen !== S.pollGen || !S.pollActive) return; // superseded or stopped
    S._tickBusy = true;
    S.lastTickAt = Date.now();
    try {
      const picks = await api('/v1/draft/' + S.draftId + '/picks');
      if (gen !== S.pollGen) return; // zombie resolved after suspend/leave
      noteOk();
      S.statusTick++;
      const waiting = S.draft && S.draft.status === 'pre_draft';
      if (waiting || S.statusTick % 5 === 0) {
        api('/v1/draft/' + S.draftId).then((d) => {
          if (gen !== S.pollGen) return;
          const was = S.draft && S.draft.status;
          S.draft = d;
          if (was === 'pre_draft' && d.status === 'drafting') {
            toast('🚀 Draft is LIVE!');
            renderAll();
          }
        }).catch(() => {});
      }
      if (picks.length !== S.lastPickCount) {
        const prevCount = S.lastPickCount;
        S.lastPickCount = picks.length;
        S.picks = picks;
        S._changed = true;
        recompute(prevCount >= 0 ? picks.slice(prevCount) : []);
      } else {
        S._changed = false;
        renderTickerOnly();
      }
    } catch (e) {
      if (gen !== S.pollGen) return;
      if (document.visibilityState === 'visible') noteErr(e); // hidden-tab fetch kills are not errors
    } finally {
      S._tickBusy = false;
    }
    if (gen !== S.pollGen || !S.pollActive) return;
    const status = S.draft && S.draft.status;
    if (status === 'complete') {
      setConn('live', 'draft complete');
      S.pollActive = false;
      store.set('activeDraft', null); // eviction-recovery record is meaningless once the draft is done
      const last = store.get('lastDraft', null);
      if (last && last.draftId === S.draftId) store.set('lastDraft', Object.assign(last, { status: 'complete' }));
      return;
    }
    if (document.visibilityState === 'hidden') return; // chain parks; lifecycle resumes it with pollNow()
    // Adaptive cadence: burst-drain right after new picks (mock CPUs machine-gun
    // between human turns), red-zone speed near your pick, base rate otherwise.
    let delay = settings.pollMs;
    if (S._changed) delay = 150;
    else if (S.analysis && (S.analysis.myTurnNow || S.analysis.picksUntilMe <= 3)) delay = Math.max(250, settings.pollMs / 2);
    S.polling = setTimeout(tick, delay);
  };
  tick();
}

/* ---------------- app-switch lifecycle (visibility/bfcache/focus/online) ---------------- */
function initLifecycle() {
  const resume = () => { if (S.pollActive) { setConn('', 'refreshing'); pollNow(); } };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      resume();
      if ($('viewDraft').classList.contains('active')) acquireWakeLock();
    } else if (S.polling) {
      clearTimeout(S.polling); S.polling = null; // park, stay pollActive — no queued catch-up ticks
    }
  });
  // iOS bfcache: back-swipe / app-switch bounce restores the frozen page; e.persisted is the only signal
  window.addEventListener('pageshow', (e) => { if (e.persisted) resume(); });
  // older-iOS belt: app switch sometimes fires only pagehide/focus, not visibilitychange
  window.addEventListener('pagehide', () => { if (S.polling) { clearTimeout(S.polling); S.polling = null; } });
  window.addEventListener('focus', resume);
  window.addEventListener('online', resume);
}

/* ---------------- screen wake lock while drafting ---------------- */
let wakeLock = null;
async function acquireWakeLock() {
  try {
    if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen');
  } catch (e) { /* unsupported, denied, or backgrounded — non-fatal, poll cadence still covers us */ }
}
function releaseWakeLock() {
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
}

/* ---------------- recompute + render ---------------- */
function normalizePicks(picks) {
  return picks.map((p) => ({
    player_id: String(p.player_id),
    pick_no: p.pick_no,
    round: p.round,
    draft_slot: p.draft_slot,
    is_keeper: !!p.is_keeper,
    metadata: p.metadata,
  }));
}
function recompute(newPicks) {
  const picks = normalizePicks(S.picks);
  S.analysis = E.analyze({ pool: S.pool, picks, mySeat: S.mySeat, shape: S.shape, avoidIds });
  // event toasts
  for (const pk of newPicks || []) {
    const pid = String(pk.player_id);
    if (starIds.has(pid)) {
      const pl = S.pool.find((x) => x.id === pid);
      toast('★ Watchlist hit: ' + (pl ? pl.name : 'your guy') + ' just went at ' + E.fmtPick(pk.pick_no, S.shape.teams));
    }
  }
  const a = S.analysis;
  if (a.myTurnNow) { document.title = '🔴 YOUR PICK — Draft Buddy'; } else { document.title = 'Draft Buddy'; }
  renderAll();
}
function renderAll() {
  renderTicker(); renderTurnState(); renderSince(); renderRunBanner(); renderLockCounts(); renderRecs(); renderRuns(); renderWatch(); renderPool(); renderTeam(); renderBoard();
}

// Persistent, dismissible run alert with one-tap position lock — a run is a
// decision moment, not a 6-second toast.
function renderRunBanner() {
  const a = S.analysis; const bn = $('runBanner');
  if (!a || !bn) return;
  let hot = null;
  for (const pos of ['QB', 'RB', 'WR', 'TE']) {
    if ((a.runs[pos] || 1) >= 1.5 && (a.recentPosCount[pos] || 0) >= 3) {
      if (!hot || a.runs[pos] > a.runs[hot]) hot = pos;
    }
  }
  const sig = hot ? hot + ':' + a.currentPickNo : null;
  if (!hot || S._runDismissed === (hot + '')) { bn.style.display = 'none'; return; }
  bn.style.display = 'flex';
  bn.innerHTML = '<b>🔥 ' + hot + ' RUN</b><span>' + a.recentPosCount[hot] + ' in the last ' + a.windowSize +
    ' picks (' + a.runs[hot].toFixed(1) + '×) — they\'re going fast</span>' +
    '<button class="lockNow">Lock ' + hot + '</button><button class="dismiss">✕</button>';
  bn.querySelector('.lockNow').onclick = () => {
    document.querySelectorAll('#lockBar .lockBtn').forEach((x) => x.classList.toggle('on', x.dataset.pos === hot));
    S.lockedPos = hot; renderRecs();
  };
  bn.querySelector('.dismiss').onclick = () => { S._runDismissed = hot; bn.style.display = 'none'; };
}

function renderTickerOnly() { if (S.analysis) renderTicker(); }
function renderTicker() {
  const a = S.analysis; if (!a) return;
  const done = a.currentPickNo > a.totalPicks;
  const waiting = S.draft && S.draft.status === 'pre_draft';
  $('tkPick').textContent = done ? 'DRAFT COMPLETE' : waiting ? '⏳ Waiting to start' : 'Pick ' + E.fmtPick(a.currentPickNo, S.shape.teams);
  $('tkClock').textContent = done ? '—' : (S.slotNames[a.onClockSlot] || 'seat ' + a.onClockSlot);
  $('tkUntil').textContent = a.myTurnNow ? 'NOW' : (a.nextMyPick ? 'in ' + a.picksUntilMe + (a.picksUntilMe === 1 ? ' pick' : ' picks') : 'done');
  $('tkStatus').textContent = (S.draft && S.draft.status || '').replace('_', ' ');
}

function renderTurnState() {
  const a = S.analysis; if (!a) return;
  const ticker = $('ticker'); const chip = $('turnChip');
  let myturn = false;
  if (a.currentPickNo > a.totalPicks) {
    chip.textContent = 'Draft complete 🎉';
  } else if (S.draft && S.draft.status === 'pre_draft') {
    chip.textContent = '⏳ waiting to start';
  } else if (a.myTurnNow) {
    myturn = true;
    chip.textContent = "🔴 YOU'RE UP";
  } else if (a.nextMyPick) {
    chip.textContent = 'Next: ' + E.fmtPick(a.nextMyPick, S.shape.teams) + ' · ' + a.picksUntilMe + (a.picksUntilMe === 1 ? ' away' : ' away');
  } else {
    chip.textContent = 'No picks left';
  }
  ticker.classList.toggle('myturn', myturn);
}

function renderSince() {
  const a = S.analysis; if (!a) return;
  const box = $('sinceList'); box.innerHTML = '';
  const myPickNos = new Set(S.picks.filter((p) => p.draft_slot === S.mySeat && !p.is_keeper).map((p) => p.pick_no));
  const lastMine = Math.max(0, ...myPickNos);
  // full backfill — every pick since your last turn, whether that's 1 or 30
  const since = S.picks.filter((p) => p.pick_no > lastMine);
  if (!since.length) { box.innerHTML = '<span style="color:var(--dim);font-size:12px">nothing yet</span>'; return; }
  for (const pk of since) {
    const pl = S.pool.find((x) => x.id === String(pk.player_id));
    const nm = pl ? E.shortName(pl.name) : ((pk.metadata && pk.metadata.first_name || '?') + ' ' + (pk.metadata && pk.metadata.last_name || ''));
    const pos = pl ? pl.pos : (pk.metadata && pk.metadata.position) || '?';
    const hot = (a.runs[pos] || 1) >= 1.5;
    const chip = el('span', 'taken' + (hot ? ' hot' : ''));
    chip.innerHTML = '<img loading="lazy" src="' + CDN_HEAD(pk.player_id) + '" onerror="this.style.visibility=\'hidden\'">' +
      '<span class="posdot bg-' + esc(pos) + '"></span><b class="pos-' + esc(pos) + '">' + esc(pos) + '</b> ' + esc(nm) +
      (pk.is_keeper ? ' <span style="color:var(--te);font-weight:800;font-size:10px">K</span>' : '') +
      ' <span style="color:var(--dim)">' + E.fmtPick(pk.pick_no, S.shape.teams) + '</span>';
    box.appendChild(chip);
  }
  box.scrollLeft = box.scrollWidth; // newest picks visible
}

function statBlock(v, l) { return '<div class="stat"><div class="v">' + v + '</div><div class="l">' + l + '</div></div>'; }
function recCardHtml(opt, rankLabel, isTop) {
  const p = opt.player;
  const survPct = opt.survivalNext != null ? Math.round(opt.survivalNext * 100) : null;
  const survColor = survPct == null ? 'var(--dim)' : survPct >= 60 ? 'var(--good)' : survPct >= 30 ? 'var(--warn)' : 'var(--bad)';
  const badgeCls = 'badge bg-' + p.pos;
  return '' +
    '<div class="recCard ' + (isTop ? 'top' : 'alt') + '" data-pid="' + esc(p.id) + '">' +
      '<span class="rankTag">' + rankLabel + '</span>' +
      '<div class="acts">' +
        '<button class="starBtn" title="watchlist">' + (starIds.has(p.id) ? '★' : '☆') + '</button>' +
        '<button class="banBtn" title="never suggest (he screwed you over)">🚫</button>' +
      '</div>' +
      '<div class="face">' + headshotHtml(p) +
        '<div class="teamrow"><img src="' + CDN_TEAM(p.team) + '" onerror="this.style.display=\'none\'">' + esc(p.team || 'FA') + '</div>' +
      '</div>' +
      '<div class="body">' +
        '<div class="nm">' + esc(p.name) +
          '<span class="' + badgeCls + '" style="color:#10151c">' + esc(p.pos) + '</span>' +
        '</div>' +
        '<div class="flags">' +
          (p.injury ? '<span style="color:var(--bad)">🚑 ' + esc(p.injury) + (p.injuryNote ? ' · ' + esc(p.injuryNote) : '') + '</span>' : '') +
          (p.dropping ? '<span title="mass drops on Sleeper" style="color:var(--bad)">📉 dropping</span>' : '') +
          (p.newsFresh && !p.dropping ? '<span title="news in last 48h" style="color:var(--accent2)">📰 news</span>' : '') +
          (p.trending ? '<span title="trending adds" style="color:var(--warn)">🔥 trending</span>' : '') +
        '</div>' +
        (survPct != null
          ? '<div class="survMeter"><i style="width:' + survPct + '%;background:' + survColor + '"></i></div>' +
            '<div class="survLbl">' + survPct + '% makes it back</div>'
          : '') +
        '<div class="stats">' +
          statBlock(Math.round(p.proj), "'26 proj") +
          statBlock(p.adpReal ? p.adp.toFixed(1) : '—', 'SF ADP') +
          statBlock('T' + (p.tier || '—'), 'tier') +
          statBlock(p.bye ? 'wk ' + p.bye : '—', 'bye') +
        '</div>' +
        '<div class="why">' + esc(opt.why) + '</div>' +
        (opt.branch ? '<div class="branch">' + esc(opt.branch) + '</div>' : '') +
      '</div>' +
    '</div>';
}
function renderRecs() {
  const a = S.analysis; if (!a) return;
  const area = $('recArea'); const bb = $('bestBecause');
  bb.style.display = 'none';
  if (!a.recommendation) {
    area.innerHTML = '<div style="color:var(--dim)">No picks remaining for your seat.</div>';
    $('demotions').textContent = '';
    return;
  }
  const rec = a.recommendation;
  let html = '';
  if (S.lockedPos) {
    const opts = rec.optionsFor(S.lockedPos, 3);
    if (!opts.length) {
      area.innerHTML = '<div style="color:var(--dim)">Nobody left at ' + esc(S.lockedPos) + '.</div>'; return;
    }
    const best = opts.find((o) => o.isBest);
    if (best && best.bestBecause) { bb.style.display = 'block'; bb.textContent = best.bestBecause; }
    opts.forEach((o, i) => { html += recCardHtml(o, o.isBest ? 'BEST BET' : '#' + (i + 1) + ' ' + S.lockedPos, o.isBest); });
  } else {
    html += recCardHtml(rec.top, rec.myTurn ? 'THE PICK' : 'IF IT WERE NOW', true);
    rec.alternatives.forEach((alt, i) => { html += recCardHtml(alt, 'PATH ' + String.fromCharCode(66 + i), false); });
  }
  area.innerHTML = html;
  $('demotions').textContent = rec.demotions.length ? '↓ ' + rec.demotions.join('  ·  ') : '';
  area.querySelectorAll('.recCard').forEach((card) => {
    const pid = card.dataset.pid;
    card.querySelector('.starBtn').onclick = () => toggleStar(pid);
    card.querySelector('.banBtn').onclick = () => toggleAvoid(pid);
  });
}

function renderLockCounts() {
  const a = S.analysis; if (!a) return;
  document.querySelectorAll('#lockBar .lockBtn').forEach((b) => {
    const pos = b.dataset.pos;
    if (!pos) { b.innerHTML = 'Engine pick'; return; }
    const left = (a.availByPos[pos] || []).filter((p) => p.vorp > 0).length;
    const cls = left === 0 ? 'dry' : left <= 4 ? 'low' : 'ok';
    b.innerHTML = pos + ' <span class="cnt ' + cls + '">' + left + '</span>';
  });
}

function renderRuns() {
  const a = S.analysis; if (!a) return;
  const box = $('runsMeter'); box.innerHTML = '';
  for (const pos of ['QB', 'RB', 'WR', 'TE']) {
    const v = a.runs[pos] || 1;
    const pct = Math.min(100, Math.round((v / 2.5) * 100));
    const color = v >= 1.6 ? 'var(--bad)' : v >= 1.25 ? 'var(--warn)' : 'var(--good)';
    const b = el('div', 'runBox');
    b.innerHTML = '<div class="rp"><b class="pos-' + pos + '">' + pos + '</b><span>' + v.toFixed(2) + '×' +
      ((a.recentPosCount[pos] || 0) ? ' · ' + a.recentPosCount[pos] + '/' + a.windowSize : '') + '</span></div>' +
      '<div class="bar"><i style="width:' + pct + '%;background:' + color + '"></i></div>';
    box.appendChild(b);
  }
}

function renderWatch() {
  const a = S.analysis; if (!a) return;
  const box = $('watchArea'); box.innerHTML = '';
  const watched = S.pool.filter((p) => starIds.has(p.id));
  if (!watched.length) { box.innerHTML = '<span style="color:var(--dim);font-size:12px">star players in Best Available to track them here</span>'; return; }
  const takenIds = new Set(S.picks.map((p) => String(p.player_id)));
  for (const p of watched.slice(0, 12)) {
    const gone = takenIds.has(p.id);
    const s = gone ? 0 : (a.survival[p.id] != null ? a.survival[p.id] : null);
    const pct = s == null ? null : Math.round(s * 100);
    const color = gone ? 'var(--dim)' : pct >= 60 ? 'var(--good)' : pct >= 30 ? 'var(--warn)' : 'var(--bad)';
    const row = el('div', 'watchRow');
    row.innerHTML = '<img loading="lazy" src="' + CDN_HEAD(p.id) + '" onerror="this.style.visibility=\'hidden\'">' +
      '<b class="pos-' + p.pos + '">' + p.pos + '</b><span style="' + (gone ? 'text-decoration:line-through;color:var(--dim)' : '') + '">' + esc(p.name) + '</span>' +
      '<span style="margin-left:auto;color:var(--dim);font-size:11px">' + (gone ? 'GONE' : pct == null ? '' : pct + '% makes it back') + '</span>' +
      '<div class="survBar"><i style="width:' + (gone ? 0 : pct || 0) + '%;background:' + color + '"></i></div>';
    box.appendChild(row);
  }
}

function renderPool() {
  const a = S.analysis; if (!a) return;
  const body = $('poolBody'); body.innerHTML = '';
  const q = S.poolFilter.q.toLowerCase();
  let list = a.available;
  if (S.poolFilter.pos) list = list.filter((p) => p.pos === S.poolFilter.pos);
  if (q) list = list.filter((p) => p.name.toLowerCase().includes(q));
  list = list.slice().sort((x, y) => x.adp - y.adp).slice(0, 80);
  for (const p of list) {
    const tr = el('tr', avoidIds.has(p.id) ? 'avoided' : '');
    const surv = a.survival[p.id] != null ? Math.round(a.survival[p.id] * 100) + '%' : '';
    tr.innerHTML = '<td><b class="pos-' + p.pos + '">' + p.pos + '</b></td>' +
      '<td class="nm" title="' + esc(p.name) + '">' + esc(p.name) + (p.trending ? ' 🔥' : '') + '</td>' +
      '<td style="color:var(--dim)">' + esc(p.team || '') + '</td>' +
      '<td>' + (p.adpReal ? p.adp.toFixed(1) : '—') + '</td>' +
      '<td><span class="tierPill">T' + (p.tier || '·') + '</span></td>' +
      '<td style="color:var(--dim)">' + surv + '</td>' +
      '<td class="poolActs"><button>' + (starIds.has(p.id) ? '★' : '☆') + '</button><button>🚫</button></td>';
    const [starB, banB] = tr.querySelectorAll('button');
    starB.onclick = () => toggleStar(p.id);
    banB.onclick = () => toggleAvoid(p.id);
    body.appendChild(tr);
  }
}

function renderTeam() {
  const a = S.analysis; if (!a) return;
  const box = $('tab-team'); box.innerHTML = '';
  const sl = S.shape.slots;
  // Bye coverage strip: can this roster field a FULL lineup every week?
  // Meaningless before the roster has real depth — gate until 8 players.
  const holes = E.lineupHoles(a.myPlayers, S.shape);
  const strip = el('div', '', '');
  strip.style.cssText = 'display:flex;gap:5px;margin-bottom:10px;flex-wrap:wrap';
  strip.innerHTML = '<span style="font-size:10.5px;color:var(--dim);letter-spacing:.08em;width:100%">BYE COVERAGE — full lineup every week?' +
    (a.myPlayers.length < 8 ? ' <i style="letter-spacing:0">(firms up as your bench fills)</i>' : '') + '</span>';
  if (a.myPlayers.length < 8) { box.appendChild(strip); }
  else {
  for (let wk = 5; wk <= 14; wk++) {
    if (wk === 12) continue; // no byes wk 12
    const h = holes[wk] || 0;
    const onBye = a.myPlayers.filter((p) => p.bye === wk).map((p) => E.shortName(p.name)).join(', ');
    const c = el('span', '', 'w' + wk + (h ? ' −' + h : ''));
    c.title = onBye ? 'Week ' + wk + ' byes: ' + onBye + (h ? ' — ' + h + ' starter slot(s) EMPTY' : ' — lineup still full') : 'Week ' + wk + ': nobody on bye';
    c.style.cssText = 'font-size:11px;padding:3px 9px;border-radius:9px;border:1px solid var(--line);' +
      (h >= 2 ? 'background:rgba(248,81,73,.2);color:var(--bad);border-color:var(--bad)' :
       h === 1 ? 'background:rgba(210,153,34,.15);color:var(--warn)' :
       onBye ? 'color:var(--good)' : 'color:var(--dim)');
    strip.appendChild(c);
  }
  box.appendChild(strip);
  }
  const slotOrder = [];
  for (let i = 0; i < sl.QB; i++) slotOrder.push('QB');
  for (let i = 0; i < sl.RB; i++) slotOrder.push('RB');
  for (let i = 0; i < sl.WR; i++) slotOrder.push('WR');
  for (let i = 0; i < sl.TE; i++) slotOrder.push('TE');
  for (let i = 0; i < sl.FLEX; i++) slotOrder.push('FLEX');
  for (let i = 0; i < sl.SUPER_FLEX; i++) slotOrder.push('SFLEX');
  for (let i = 0; i < sl.BN; i++) slotOrder.push('BN');
  // greedy fill: dedicated first, then flexes, rest to bench
  const remaining = a.myPlayers.slice().sort((x, y) => (y.proj || 0) - (x.proj || 0));
  const fits = { QB: ['QB'], RB: ['RB'], WR: ['WR'], TE: ['TE'], FLEX: ['RB', 'WR', 'TE'], SFLEX: ['QB', 'RB', 'WR', 'TE'], BN: ['QB', 'RB', 'WR', 'TE', '?'] };
  for (const slotName of slotOrder) {
    const idx = remaining.findIndex((p) => fits[slotName].includes(p.pos));
    const p = idx >= 0 ? remaining.splice(idx, 1)[0] : null;
    const row = el('div', 'slotRow' + (p ? '' : ' empty'));
    row.innerHTML = '<span class="slotName">' + slotName + '</span>' +
      (p
        ? '<img loading="lazy" src="' + CDN_HEAD(p.id) + '" onerror="this.style.visibility=\'hidden\'">' +
          '<span class="fill"><b class="pos-' + p.pos + '">' + p.pos + '</b> ' + esc(p.name) + (p.isKeeper ? ' <span style="color:var(--te);font-weight:800;font-size:10px">K</span>' : '') + '</span>' +
          '<span style="margin-left:auto;color:var(--dim);font-size:11px">' + Math.round(p.proj || 0) + ' proj</span>'
        : '<span class="fill">open</span>');
    box.appendChild(row);
  }
}

function renderBoard() {
  const a = S.analysis; if (!a) return;
  const wrap = $('boardWrap'); wrap.innerHTML = '';
  const keeperCount = S.picks.filter((p) => p.is_keeper).length;
  $('boardMeta').textContent = 'pick ' + Math.min(a.currentPickNo, a.totalPicks) + ' of ' + a.totalPicks +
    (keeperCount ? ' · ' + keeperCount + ' keepers' : '');
  const byNo = {};
  for (const pk of S.picks) byNo[pk.pick_no] = pk;
  const t = el('table', 'board');
  let head = '<tr><th class="rnd"></th>';
  for (let s = 1; s <= S.shape.teams; s++) {
    const nm = S.slotNames[s] || 'S' + s;
    head += '<th title="' + esc(nm) + '">' + (s === S.mySeat ? '⭐ ' : '') + esc(nm) + '</th>';
  }
  t.innerHTML = head + '</tr>';
  for (let r = 1; r <= S.shape.rounds; r++) {
    const tr = el('tr');
    tr.innerHTML = '<th class="rnd">R' + r + '</th>';
    for (let s = 1; s <= S.shape.teams; s++) {
      let no = null;
      for (let n = (r - 1) * S.shape.teams + 1; n <= r * S.shape.teams; n++) {
        if (E.slotForPick(n, S.shape.teams, S.shape.reversalRound) === s) { no = n; break; }
      }
      const pk = byNo[no];
      const pl = pk && S.pool.find((x) => x.id === String(pk.player_id));
      const pos = pl ? pl.pos : (pk && pk.metadata && pk.metadata.position) || '';
      const td = el('td', (s === S.mySeat ? 'me ' : '') + (pos ? 'c' + pos : ''));
      if (no === a.currentPickNo) td.classList.add('onclock');
      if (pk) {
        const nm = pl ? E.shortName(pl.name) : (pk.metadata && pk.metadata.last_name) || '?';
        td.title = (pl ? pl.name : nm) + ' (' + pos + ') — ' + E.fmtPick(no, S.shape.teams) + (pk.is_keeper ? ' · KEEPER' : '');
        td.innerHTML = '<span class="bp pos-' + esc(pos) + '">' + esc(nm) + (pk.is_keeper ? ' <span class="kb">K</span>' : '') + '</span>';
      }
      tr.appendChild(td);
    }
    t.appendChild(tr);
  }
  wrap.appendChild(t);
}

/* ---------------- star / avoid ---------------- */
function toggleStar(pid) {
  if (starIds.has(pid)) starIds.delete(pid); else { starIds.add(pid); avoidIds.delete(pid); }
  store.set('stars', [...starIds]); store.set('avoid', [...avoidIds]);
  recompute();
}
function toggleAvoid(pid) {
  if (avoidIds.has(pid)) avoidIds.delete(pid);
  else {
    avoidIds.add(pid); starIds.delete(pid);
    const pl = S.pool.find((x) => x.id === pid);
    toast('🚫 ' + (pl ? pl.name : 'player') + ' will never be suggested (undo in Best Available)');
  }
  store.set('stars', [...starIds]); store.set('avoid', [...avoidIds]);
  recompute();
}

/* ---------------- wiring ---------------- */
function goHome() {
  stopPolling();
  releaseWakeLock();
  store.set('activeDraft', null);
  document.title = 'Draft Buddy';
  $('seatChip').style.display = 'none';
  showView('viewHome');
}
function wire() {
  $('btnEnter').onclick = showAttach;
  $('btnMockBack').onclick = () => showView('viewHome');
  // attach by pasted draft link or raw ID (phone-lobby mocks are not API-discoverable)
  const attachById = () => {
    const raw = $('mockIdInput').value.trim();
    const m = raw.match(/(\d{15,20})/);
    if (!m) { toast('Paste a Sleeper draft link or its long ID number'); return; }
    attach(m[1]);
  };
  $('mockIdGo').onclick = attachById;
  $('mockIdInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') attachById(); });
  // zero-click: pasting a valid link/ID attaches immediately
  $('mockIdInput').addEventListener('paste', () => setTimeout(() => {
    if (/\d{15,20}/.test($('mockIdInput').value)) attachById();
  }, 50));
  $('discGo').onclick = tryDiscover;
  $('discUser').addEventListener('keydown', (e) => { if (e.key === 'Enter') tryDiscover(); });
  $('btnHome').onclick = goHome;
  $('btnDraftBack').onclick = goHome;
  // position lock
  document.querySelectorAll('#lockBar .lockBtn').forEach((b) => {
    b.onclick = () => {
      document.querySelectorAll('#lockBar .lockBtn').forEach((x) => x.classList.remove('on'));
      b.classList.add('on');
      S.lockedPos = b.dataset.pos;
      renderRecs();
    };
  });
  // board drawer
  const drawer = $('boardDrawer');
  if (store.get('boardOpen', true)) drawer.classList.add('open');
  $('boardToggle').onclick = () => {
    drawer.classList.toggle('open');
    store.set('boardOpen', drawer.classList.contains('open'));
  };
  // mobile tab bar — panes ARE the existing #warRoom/#sidePanel/#boardDrawer
  // nodes (CSS visibility only); Pool/Team route through the real #sideTabs
  // buttons so that state machine stays the single source of truth.
  document.body.dataset.mtab = 'war';
  document.querySelectorAll('#mTabs button').forEach((b) => {
    b.onclick = () => {
      document.body.dataset.mtab = b.dataset.mtab;
      document.querySelectorAll('#mTabs button').forEach((x) => x.classList.toggle('on', x === b));
      if (b.dataset.mtab === 'pool') $('sideTabs').querySelector('[data-tab=pool]').click();
      if (b.dataset.mtab === 'team') $('sideTabs').querySelector('[data-tab=team]').click();
    };
  });
  // side tabs
  document.querySelectorAll('#sideTabs button').forEach((b) => {
    b.onclick = () => {
      document.querySelectorAll('#sideTabs button').forEach((x) => x.classList.remove('on'));
      document.querySelectorAll('.sideBody').forEach((x) => x.classList.remove('on'));
      b.classList.add('on');
      $('tab-' + b.dataset.tab).classList.add('on');
    };
  });
  // pool filters
  $('poolSearch').oninput = (e) => { S.poolFilter.q = e.target.value; renderPool(); };
  document.querySelectorAll('#poolPosBar button').forEach((b) => {
    b.onclick = () => {
      document.querySelectorAll('#poolPosBar button').forEach((x) => x.classList.remove('on'));
      b.classList.add('on');
      S.poolFilter.pos = b.dataset.p;
      renderPool();
    };
  });
  // donate
  $('btnDonate').onclick = () => $('donateModal').classList.add('on');
  $('donateClose').onclick = () => $('donateModal').classList.remove('on');
  $('donateModal').addEventListener('click', (e) => { if (e.target === $('donateModal')) $('donateModal').classList.remove('on'); });
  // amounts select; the rail buttons carry the chosen amount to Venmo or PayPal
  let donateAmt = '5';
  document.querySelectorAll('.amtBtn').forEach((b) => {
    b.onclick = () => {
      donateAmt = b.dataset.amt;
      document.querySelectorAll('.amtBtn').forEach((x) => x.classList.toggle('sel', x === b));
    };
  });
  $('goVenmo').onclick = () => window.open('https://venmo.com/Brian-Scott-2?txn=pay&amount=' + donateAmt + '&note=Draft%20Buddy', '_blank', 'noopener');
  $('goPaypal').onclick = () => window.open('https://www.paypal.me/brianscott31/' + donateAmt, '_blank', 'noopener');
  // settings
  $('btnSettings').onclick = () => {
    $('setUser').value = settings.username;
    $('setPoll').value = settings.pollMs;
    const currentShell = store.get('shell', 'auto');
    document.querySelectorAll('.segBtn').forEach((b) => b.classList.toggle('on', b.dataset.shell === currentShell));
    $('setModal').classList.add('on');
  };
  document.querySelectorAll('.segBtn').forEach((b) => {
    b.onclick = () => document.querySelectorAll('.segBtn').forEach((x) => x.classList.toggle('on', x === b));
  });
  $('setClose').onclick = () => $('setModal').classList.remove('on');
  $('setCache').onclick = () => { localStorage.removeItem('db.playersCacheV2'); toast('Player cache cleared — reload to refetch'); };
  $('setSave').onclick = async () => {
    const newUser = $('setUser').value.trim();
    settings.pollMs = Math.max(300, parseInt($('setPoll').value, 10) || DEFAULTS.pollMs);
    if (newUser && newUser !== settings.username) {
      try {
        await resolveUser(newUser);
        toast('Hello ' + settings.username);
      } catch (e) { toast('Sleeper user "' + newUser + '" not found'); }
    } else if (!newUser) {
      settings.username = ''; settings.userId = '';
    }
    const shellSel = document.querySelector('.segBtn.on');
    store.set('shell', shellSel ? shellSel.dataset.shell : 'auto');
    applyShell();
    store.set('settings', settings);
    $('setModal').classList.remove('on');
  };
}

/* ---------------- splash ---------------- */
// Triple fallback, safest first: if canvas is unsupported, if the image takes
// >250ms to arrive, or if anything errors, the <img>+splashZoom CSS animation
// underneath just keeps running untouched — the canvas only ever swaps in once
// it has something real to show, never leaving a blank frame.
function initSplash() {
  const splash = $('splash');
  if (!splash) return;
  let done = false;
  const dismiss = () => {
    if (done) return;
    done = true;
    splash.classList.add('hide');
    splash.addEventListener('transitionend', () => splash.remove(), { once: true });
  };
  splash.addEventListener('click', dismiss);
  splash.addEventListener('touchstart', dismiss, { passive: true });
  setTimeout(dismiss, 1400);

  const cv = $('splashCv'), img = splash.querySelector('img');
  const ctx = cv && cv.getContext && cv.getContext('2d');
  if (!ctx) return; // fallback: CSS zoom on the <img> runs as today
  const src = new Image();
  src.src = 'assets/hmb-logo.png'; // cache hit — header already loaded it
  const started = Date.now();
  src.onload = () => {
    if (done || Date.now() - started > 250) return; // image late → keep CSS fallback
    img.style.display = 'none'; cv.style.display = 'block';
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = 110 * dpr; cv.height = 110 * dpr;
    const off = document.createElement('canvas');
    const T = 900; // resolve duration; word anim (.55s delay) unchanged
    const step = () => {
      if (done) return;
      const t = Math.min(1, (Date.now() - started) / T);
      const e = 1 - Math.pow(1 - t, 3); // ease-out cubic
      const res = Math.max(6, Math.round(6 + e * (110 - 6))); // 6px cells -> full res
      off.width = res; off.height = res;
      const octx = off.getContext('2d');
      octx.imageSmoothingEnabled = true; // clean downsample
      octx.drawImage(src, 0, 0, res, res);
      ctx.imageSmoothingEnabled = t >= 1; // chunky upscale until the last frame
      ctx.clearRect(0, 0, cv.width, cv.height);
      ctx.drawImage(off, 0, 0, cv.width, cv.height);
      if (t < 1) requestAnimationFrame(step);
      else cv.classList.add('lit');
    };
    requestAnimationFrame(step);
  };
}

/* ---------------- boot ---------------- */
async function boot() {
  wire();
  initSplash();
  initLifecycle();
  applyShell();
  let resizeT = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeT);
    resizeT = setTimeout(applyShell, 150);
  });
  window.addEventListener('orientationchange', applyShell);
  // warm the projections/player cache in the background so attach feels instant
  loadStaticData().then(() => setConn('live', 'ready')).catch(() => {
    setConn('', 'idle'); // attach() will retry and surface any real error
  });
  // Eviction recovery: the app was force-killed mid-draft (a real scenario on
  // phones, not an edge case) — skip home entirely and go straight back live.
  const active = store.get('activeDraft', null);
  if (active && active.draftId && Date.now() - active.at < 6 * 3600 * 1000) {
    attach(active.draftId, { autoSeat: active.seat });
  }
}
document.addEventListener('DOMContentLoaded', boot);

/* test hook for QC automation */
window.__DB = {
  S, settings, avoidIds, starIds,
  attach, recompute, startDraftSession,
  injectDraft(draft, picks, seat) {
    S.draft = draft; S.draftId = draft.draft_id || 'injected';
    S.shape = E.leagueShape(S.league, draft.settings);
    rebuildValues();
    S.slotNames = {};
    for (let i = 1; i <= S.shape.teams; i++) S.slotNames[i] = 'Team ' + i;
    S.picks = picks; S.lastPickCount = picks.length;
    S.mySeat = seat;
    showView('viewDraft');
    $('seatChip').style.display = 'inline-block';
    $('seatChip').textContent = 'Seat ' + seat;
    recompute();
  },
  injectPicks(picks) { S.picks = picks; S.lastPickCount = picks.length; recompute(); },
};
