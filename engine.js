/* ============================================================
 * Draft Buddy — DraftEngine (pure functions, no DOM, no fetch)
 * Runs in browser (window.DraftEngine) and Node (module.exports)
 * ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DraftEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const POSITIONS = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF'];

  // Season-long value discount by injury designation. Preseason "Questionable"
  // is ubiquitous noise; Out/IR/PUP is real missed time + re-injury risk.
  const INJURY_MULT = {
    Out: 0.78, IR: 0.7, PUP: 0.75, Sus: 0.82, COV: 0.9, DNR: 0.55, NA: 1,
    Doubtful: 0.85, Questionable: 0.97,
  };

  // 2026 bye weeks (source: fantasyfootballcalculator.com/nfl-bye-weeks, Aug 2026)
  const BYE_2026 = {
    KC: 5, CAR: 5, MIA: 6, CIN: 6, DET: 6, MIN: 6, BUF: 7, LAC: 7, WAS: 7, JAX: 7,
    NYG: 8, NO: 8, SF: 8, HOU: 8, TEN: 9, PIT: 9, DEN: 10, PHI: 10, CHI: 10, TB: 10,
    NE: 11, CLE: 11, SEA: 11, GB: 11, ATL: 11, LAR: 11, IND: 13, NYJ: 13, LV: 13,
    BAL: 13, DAL: 14, ARI: 14,
  };

  /* ---------- live ADP fit ----------
   * Every completed non-keeper pick is an (adp, actual pick) observation.
   * A live least-squares fit recalibrates the whole survival model to THIS
   * room — which is what corrects keeper leagues (everyone goes earlier than
   * redraft ADP) and rooms that are simply faster/slower than the market. */
  function fitLiveAdp(picks, pool) {
    const poolById = {};
    for (const p of pool) poolById[p.id] = p;
    const obs = [];
    for (const pk of picks) {
      if (pk.is_keeper) continue;
      const p = poolById[String(pk.player_id)];
      if (p && p.adpReal) obs.push([p.adp, pk.pick_no]);
    }
    if (obs.length < 8) return null;
    const n = obs.length;
    let sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (const [x, y] of obs) { sx += x; sy += y; sxx += x * x; sxy += x * y; }
    const denom = n * sxx - sx * sx;
    if (Math.abs(denom) < 1e-6) return null;
    const b = (n * sxy - sx * sy) / denom;
    const a = (sy - b * sx) / n;
    let se = 0;
    for (const [x, y] of obs) { const e = y - (a + b * x); se += e * e; }
    const sd = Math.sqrt(se / Math.max(1, n - 2));
    if (!isFinite(b) || b <= 0.3 || b > 2.5) return null; // degenerate room, ignore
    return { a, b, sd, n };
  }

  // Where does this player really go in THIS room?
  function fittedPick(adp, fit) {
    return fit ? fit.a + fit.b * adp : adp;
  }

  /* ---------- league shape ---------- */

  // Build a normalized league shape from Sleeper league + draft settings.
  function leagueShape(league, draftSettings) {
    const s = draftSettings || {};
    const rp = (league && league.roster_positions) || [];
    const count = (slot) => rp.filter((x) => x === slot).length;
    const teams = s.teams || (league && league.total_rosters) || 12;
    const slots = {
      QB: s.slots_qb != null ? s.slots_qb : count('QB'),
      RB: s.slots_rb != null ? s.slots_rb : count('RB'),
      WR: s.slots_wr != null ? s.slots_wr : count('WR'),
      TE: s.slots_te != null ? s.slots_te : count('TE'),
      K: s.slots_k != null ? s.slots_k : count('K'),
      DEF: s.slots_def != null ? s.slots_def : count('DEF'),
      FLEX: s.slots_flex != null ? s.slots_flex : count('FLEX'),
      SUPER_FLEX: s.slots_super_flex != null ? s.slots_super_flex : count('SUPER_FLEX'),
      BN: s.slots_bn != null ? s.slots_bn : count('BN'),
    };
    return {
      teams,
      rounds: s.rounds || rp.length || 15,
      reversalRound: s.reversal_round || 0,
      slots,
      scoring: (league && league.scoring_settings) || null,
    };
  }

  /* ---------- player pool ---------- */

  // Exact points under league scoring: every scoring key that matches a
  // projected stat key contributes stat * weight. Falls back to pts_ppr.
  function scoreProjection(stats, scoring) {
    if (!scoring) return stats.pts_ppr || 0;
    let pts = 0;
    let matched = 0;
    for (const k in scoring) {
      const v = stats[k];
      if (typeof v === 'number' && v !== 0) {
        pts += v * scoring[k];
        matched++;
      }
    }
    return matched >= 3 ? pts : stats.pts_ppr || 0;
  }

  // projections: raw Sleeper projections array. playersDb: map id -> player.
  // Returns sorted pool (desc proj) of draft-relevant players.
  function buildPool(projections, playersDb, shape, opts) {
    opts = opts || {};
    const usable = new Set(opts.positions || ['QB', 'RB', 'WR', 'TE']);
    const trendingMap = opts.trendingMap || {};
    const pool = [];
    for (const row of projections) {
      const st = row.stats || {};
      const p = row.player || {};
      const pos = p.position;
      if (!usable.has(pos)) continue;
      const adp = st.adp_2qb && st.adp_2qb < 999 ? st.adp_2qb : null;
      const proj = scoreProjection(st, shape.scoring);
      if (adp == null && proj < (opts.minProj != null ? opts.minProj : 60)) continue;
      const db = (playersDb && playersDb[row.player_id]) || {};
      const teamAbbr = row.team || db.team || 'FA';
      const injury = db.injury_status || p.injury_status || null;
      pool.push({
        bye: BYE_2026[teamAbbr] || null,
        injuryMult: (injury && INJURY_MULT[injury] != null) ? INJURY_MULT[injury] : 1,
        injuryNote: db.injury_body_part || null,
        newsFresh: !!(db.news_updated && (opts.now || 0) - db.news_updated < 48 * 3600 * 1000),
        dropping: (opts.droppingMap && opts.droppingMap[row.player_id]) || 0,
        id: row.player_id,
        name: (p.first_name || db.first_name || '') + ' ' + (p.last_name || db.last_name || ''),
        pos,
        team: row.team || db.team || 'FA',
        proj: Math.round(proj * 10) / 10,
        adp: adp != null ? adp : 300 + pool.length * 0.01,
        adpReal: adp != null,
        adpPpr: st.adp_ppr && st.adp_ppr < 999 ? st.adp_ppr : null,
        injury: db.injury_status || p.injury_status || null,
        yearsExp: db.years_exp != null ? db.years_exp : p.years_exp,
        trending: trendingMap[row.player_id] || 0,
      });
    }
    pool.sort((a, b) => b.proj - a.proj);
    return pool;
  }

  /* ---------- replacement levels / VORP ---------- */

  // How many players at each position get "started" league-wide.
  function startableCounts(shape) {
    const t = shape.teams;
    const sl = shape.slots;
    // Superflex slots are overwhelmingly QBs in 2QB rooms; flex splits RB/WR/TE.
    const SF_QB_SHARE = 0.85;
    const FLEX_SHARE = { RB: 0.35, WR: 0.5, TE: 0.15 };
    const counts = {
      QB: t * (sl.QB + sl.SUPER_FLEX * SF_QB_SHARE),
      RB: t * (sl.RB + sl.FLEX * FLEX_SHARE.RB + sl.SUPER_FLEX * ((1 - SF_QB_SHARE) * 0.5)),
      WR: t * (sl.WR + sl.FLEX * FLEX_SHARE.WR + sl.SUPER_FLEX * ((1 - SF_QB_SHARE) * 0.5)),
      TE: t * (sl.TE + sl.FLEX * FLEX_SHARE.TE),
      K: t * sl.K,
      DEF: t * sl.DEF,
    };
    for (const k in counts) counts[k] = Math.round(counts[k]);
    return counts;
  }

  // Replacement pts per position = projection of the (startable + smallBench)th player.
  function replacementLevels(pool, shape) {
    const startable = startableCounts(shape);
    const byPos = groupByPos(pool);
    const levels = {};
    for (const pos in startable) {
      const arr = byPos[pos] || [];
      if (!arr.length) { levels[pos] = 0; continue; }
      const idx = Math.min(arr.length - 1, Math.max(0, startable[pos] - 1));
      levels[pos] = arr[idx].proj;
    }
    return { levels, startable };
  }

  function applyVorp(pool, levels) {
    // Injury-discounted projection drives value; raw proj stays for display.
    for (const p of pool) p.vorp = Math.round((p.proj * (p.injuryMult || 1) - (levels[p.pos] || 0)) * 10) / 10;
  }

  /* ---------- lineup coverage (full team every week) ----------
   * For each bye week represented on a roster: can it still field a FULL
   * starting lineup? Returns {week: unfillableStarterSlots} for weeks short. */
  function lineupHoles(players, shape) {
    const sl = shape.slots;
    const weeks = {};
    const byes = [...new Set(players.map((p) => p.bye).filter(Boolean))];
    for (const wk of byes) {
      const active = players.filter((p) => p.bye !== wk);
      const c = posCounts(active);
      const spare = { ...c };
      let holes = 0;
      for (const pos of ['QB', 'RB', 'WR', 'TE', 'K', 'DEF']) {
        const need = sl[pos] || 0;
        const used = Math.min(spare[pos] || 0, need);
        spare[pos] = (spare[pos] || 0) - used;
        holes += need - used;
      }
      for (let i = 0; i < sl.FLEX; i++) { const d = ['RB', 'WR', 'TE'].find((x) => spare[x] > 0); if (d) spare[d]--; else holes++; }
      for (let i = 0; i < sl.SUPER_FLEX; i++) { const d = ['QB', 'RB', 'WR', 'TE'].find((x) => spare[x] > 0); if (d) spare[d]--; else holes++; }
      if (holes > 0) weeks[wk] = holes;
    }
    return weeks;
  }

  // How a candidate changes weekly lineup coverage: holes he plugs, and how
  // many rostered players already share his bye (stacking).
  function byeImpact(candidate, myPlayers, shape) {
    const before = lineupHoles(myPlayers, shape);
    const after = lineupHoles([...myPlayers, candidate], shape);
    const coveredWeeks = Object.keys(before).filter((wk) => (after[wk] || 0) < before[wk]).map(Number);
    const covered = Object.values(before).reduce((a, b) => a + b, 0) - Object.values(after).reduce((a, b) => a + b, 0);
    const stacked = candidate.bye ? myPlayers.filter((p) => p.bye === candidate.bye).length : 0;
    return { covered: Math.max(0, covered), coveredWeeks, stacked };
  }

  // Blend VORP with the market's opinion (superflex ADP). Pure season-total
  // VORP undervalues QBs in 2QB rooms (streaming is impossible, so the market
  // prices QB scarcity harder than season points imply). Mapping ADP rank onto
  // the league value curve pulls the engine toward how real 2QB drafts behave,
  // while the VORP half still catches value falling past its ADP.
  function applyMarketBlend(pool, weight) {
    const w = weight != null ? weight : 0.5;
    const byVorp = pool.slice().sort((a, b) => b.vorp - a.vorp);
    const byAdp = pool.slice().sort((a, b) => a.adp - b.adp);
    byAdp.forEach((p, i) => {
      p.marketValue = byVorp[Math.min(i, byVorp.length - 1)].vorp;
      if (!p.adpReal) p.marketValue = Math.min(p.marketValue, p.vorp); // no ADP signal → no market credit
    });
    for (const p of pool) {
      p.value = Math.round((p.vorp * (1 - w) + p.marketValue * w) * 10) / 10;
    }
  }

  function groupByPos(pool) {
    const m = {};
    for (const p of pool) (m[p.pos] = m[p.pos] || []).push(p);
    for (const k in m) m[k].sort((a, b) => b.proj - a.proj);
    return m;
  }

  /* ---------- tiers ---------- */

  // Gap-threshold tiering on the top of each position group.
  function assignTiers(pool) {
    const byPos = groupByPos(pool);
    for (const pos in byPos) {
      const arr = byPos[pos].slice(0, 48);
      if (arr.length < 3) { arr.forEach((p) => (p.tier = 1)); continue; }
      const gaps = [];
      for (let i = 1; i < arr.length; i++) gaps.push(arr[i - 1].proj - arr[i].proj);
      const sorted = gaps.slice().sort((a, b) => a - b);
      const p75 = sorted[Math.floor(sorted.length * 0.75)];
      const threshold = Math.max(5, p75 * 1.6);
      let tier = 1;
      arr[0].tier = 1;
      for (let i = 1; i < arr.length; i++) {
        if (gaps[i - 1] >= threshold && tier < 9) tier++;
        arr[i].tier = tier;
      }
      byPos[pos].slice(48).forEach((p) => (p.tier = 10));
    }
  }

  /* ---------- snake math ---------- */

  // 1-based overall pick -> 1-based seat slot.
  function slotForPick(overall, teams, reversalRound) {
    const round = Math.ceil(overall / teams);
    const idx = (overall - 1) % teams; // 0-based within round
    let ascending = round % 2 === 1;
    // 3rd-round-reversal: rounds >= reversalRound flip direction once more.
    if (reversalRound && round >= reversalRound) ascending = !ascending;
    return ascending ? idx + 1 : teams - idx;
  }

  function myPickNumbers(seat, shape) {
    const out = [];
    const total = shape.teams * shape.rounds;
    for (let n = 1; n <= total; n++) {
      if (slotForPick(n, shape.teams, shape.reversalRound) === seat) out.push(n);
    }
    return out;
  }

  function fmtPick(overall, teams) {
    const r = Math.ceil(overall / teams);
    const p = ((overall - 1) % teams) + 1;
    return r + '.' + String(p).padStart(2, '0');
  }

  /* ---------- draft state analysis ---------- */

  // picks: Sleeper picks array [{player_id, pick_no, round, draft_slot, is_keeper, metadata}]
  function rosterFromPicks(picks, pool) {
    const poolById = {};
    for (const p of pool) poolById[p.id] = p;
    const bySlot = {};
    const takenIds = new Set();
    for (const pk of picks) {
      takenIds.add(String(pk.player_id));
      const slot = pk.draft_slot;
      const entry = poolById[String(pk.player_id)] || {
        id: String(pk.player_id),
        name: ((pk.metadata && pk.metadata.first_name) || '?') + ' ' + ((pk.metadata && pk.metadata.last_name) || ''),
        pos: (pk.metadata && pk.metadata.position) || '?',
        team: (pk.metadata && pk.metadata.team) || '',
        proj: 0, adp: 999, vorp: 0, tier: 10,
      };
      (bySlot[slot] = bySlot[slot] || []).push({ ...entry, pickNo: pk.pick_no, isKeeper: !!pk.is_keeper });
    }
    return { bySlot, takenIds };
  }

  function posCounts(players) {
    const c = { QB: 0, RB: 0, WR: 0, TE: 0, K: 0, DEF: 0 };
    for (const p of players || []) if (c[p.pos] != null) c[p.pos]++;
    return c;
  }

  // Does this team still plausibly draft `pos`? Used for hazard shaping.
  function teamNeedFactor(counts, pos, shape) {
    const sl = shape.slots;
    const req = {
      QB: sl.QB + sl.SUPER_FLEX, // superflex leagues: 2 QBs is the baseline
      RB: sl.RB + 1,
      WR: sl.WR + 1,
      TE: sl.TE,
      K: sl.K,
      DEF: sl.DEF,
    };
    const cap = {
      QB: sl.QB + sl.SUPER_FLEX + 1,
      RB: sl.RB + 4,
      WR: sl.WR + 4,
      TE: sl.TE + 1,
      K: sl.K,
      DEF: sl.DEF,
    };
    const c = counts[pos] || 0;
    if (c >= cap[pos]) return 0.12; // effectively out of the market
    if (c < req[pos]) return 1.2;   // active need
    return 0.65;                    // depth-only interest
  }

  /* ---------- run detection ---------- */

  // pressure per position: observed picks in the trailing window vs expected.
  // Window is ~2 rounds; expected is calibrated on how THIS room drafted
  // BEFORE the window (prior-fit), so a genuine positional burst reads as a
  // run instead of being absorbed into the baseline. Counts only players who
  // were actually draftable in the window; a small-sample gate returns 1.0
  // rather than inventing a run.
  function runPressure(picks, pool, shape) {
    const res = {};
    POSITIONS.forEach((p) => (res[p] = 1));
    const nonKeeper = picks.filter((pk) => !pk.is_keeper);
    const window = Math.min(nonKeeper.length, shape.teams * 2);
    if (window < 8) return res;
    const recent = nonKeeper.slice(-window);
    const startNo = recent[0].pick_no;
    const priorPicks = picks.filter((pk) => pk.pick_no < startNo);
    const adpFit = fitLiveAdp(priorPicks, pool); // room-as-it-was, pre-window
    const endNo = recent[recent.length - 1].pick_no;
    const poolById = {};
    for (const p of pool) poolById[p.id] = p;
    const observed = {};
    for (const pk of recent) {
      const pos = (poolById[String(pk.player_id)] || {}).pos || (pk.metadata && pk.metadata.position);
      if (pos) observed[pos] = (observed[pos] || 0) + 1;
    }
    // ids taken BEFORE the window opened were never draftable inside it
    const goneBefore = new Set(picks.filter((pk) => pk.pick_no < startNo).map((pk) => String(pk.player_id)));
    const expected = {};
    for (const p of pool) {
      if (goneBefore.has(p.id) || !p.adpReal) continue;
      const ep = fittedPick(p.adp, adpFit);
      if (ep >= startNo - 0.5 && ep <= endNo + 0.5) expected[p.pos] = (expected[p.pos] || 0) + 1;
    }
    for (const pos of POSITIONS) {
      const obs = observed[pos] || 0;
      const exp = expected[pos] || 0;
      if (exp < 3) { res[pos] = 1; continue; } // sample too small to call a run
      res[pos] = clamp((obs + 0.6) / (exp + 0.6), 0.5, 2.5);
    }
    return res;
  }

  /* ---------- survival ---------- */

  function logisticCdf(x, mu, s) {
    return 1 / (1 + Math.exp(-(x - mu) / s));
  }

  // P(player survives from pick N (exclusive) to pick T (exclusive)) given available after N.
  // Hazard walk over intervening picks, shaped by each team's needs and run pressure.
  function survivalProb(player, fromPickNo, toPickNo, ctx) {
    if (toPickNo <= fromPickNo + 1) return 1;
    const pressure = (ctx.runs && ctx.runs[player.pos]) || 1;
    // Room-calibrated expected pick (corrects keeper shift + fast/slow rooms),
    // then runs pull it earlier by up to ~half a round per unit pressure.
    const fit = ctx.adpFit;
    let mu = fittedPick(player.adp, fit);
    let s = fit ? Math.max(2.5, fit.sd * (0.7 + player.adp / 150)) : 3 + player.adp * 0.16;
    mu -= (pressure - 1) * ctx.shape.teams * 0.45;
    let surviveAll = 1;
    let condition = 1 - logisticCdf(fromPickNo, mu, s);
    if (condition < 0.02) condition = 0.02;
    // A player fallen a full round past his expected pick is a screaming value
    // someone WILL stop — the pure conditional model wrongly extrapolates the
    // slide forever, so fallers carry a per-pick hazard floor instead.
    const fallenBy = fromPickNo - mu;
    const fallerFloor = fallenBy > ctx.shape.teams ? 0.055 : 0;
    for (let k = fromPickNo + 1; k < toPickNo; k++) {
      if (ctx.filledPickNos && ctx.filledPickNos.has(k)) continue; // keeper-occupied slot: no threat
      const baseTake = (logisticCdf(k + 1, mu, s) - logisticCdf(k, mu, s)) / Math.max(0.02, 1 - logisticCdf(k, mu, s));
      const slot = slotForPick(k, ctx.shape.teams, ctx.shape.reversalRound);
      const counts = ctx.slotCounts[slot] || {};
      const nf = teamNeedFactor(counts, player.pos, ctx.shape);
      const h = clamp(Math.max(baseTake, fallerFloor) * nf * Math.pow(pressure, 0.7), 0, 0.95);
      surviveAll *= 1 - h;
    }
    return clamp(surviveAll, 0.01, 0.99);
  }

  // Expected best blended value still available at pick T for a position.
  // E = sum_i value_i * P(i survives) * prod_{j<i} (1 - P(j survives))
  function expectedBestLater(posPlayers, fromPickNo, toPickNo, ctx) {
    let expected = 0;
    let probAllGone = 1;
    let likelyBest = null;
    for (const p of posPlayers.slice(0, 14)) {
      const s = survivalProb(p, fromPickNo, toPickNo, ctx);
      expected += Math.max(0, val(p)) * s * probAllGone;
      if (!likelyBest && s >= 0.5) likelyBest = { player: p, survival: s };
      probAllGone *= 1 - s;
    }
    if (!likelyBest && posPlayers.length) {
      const p = posPlayers[0];
      likelyBest = { player: p, survival: survivalProb(p, fromPickNo, toPickNo, ctx) };
    }
    return { expected, likelyBest };
  }

  function val(p) { return p.value != null ? p.value : p.vorp; }

  // League-wide positional scarcity: remaining startable supply vs teams still
  // shopping. "4 startable QBs left, 7 teams need one" → urgency.
  function posScarcity(pos, availByPos, slotCounts, shape) {
    const sl = shape.slots;
    const req = { QB: sl.QB + sl.SUPER_FLEX, RB: sl.RB, WR: sl.WR, TE: sl.TE };
    if (!req[pos]) return { boost: 1, supply: 0, demand: 0 };
    let demand = 0;
    for (let slot = 1; slot <= shape.teams; slot++) {
      const c = (slotCounts[slot] || {})[pos] || 0;
      if (c < req[pos]) demand += req[pos] - c;
    }
    const supply = (availByPos[pos] || []).filter((p) => p.vorp > 0).length;
    let boost = 1;
    if (demand > 0) {
      const ratio = supply / demand;
      if (ratio < 1.0) boost = 1.6;
      else if (ratio < 1.4) boost = 1.3;
      else if (ratio < 1.8) boost = 1.12;
    }
    return { boost, supply, demand };
  }

  // Estimated overall pick at which a position's startable supply is
  // effectively exhausted (80% depleted), accelerated by run pressure.
  function exhaustionPick(pos, availByPos, runs, currentPickNo, adpFit) {
    const arr = (availByPos[pos] || []).filter((p) => p.vorp > 0 && p.adpReal);
    if (!arr.length) return currentPickNo; // already dry
    const eps = arr.map((p) => fittedPick(p.adp, adpFit)).sort((a, b) => a - b);
    const p80 = eps[Math.min(eps.length - 1, Math.floor(eps.length * 0.8))];
    const pressure = Math.max(0.6, (runs && runs[pos]) || 1);
    return currentPickNo + Math.max(1, p80 - currentPickNo) / pressure;
  }

  /* ---------- roster needs (my team) ---------- */

  function myNeeds(myPlayers, shape, myRemainingPicks) {
    const sl = shape.slots;
    const c = posCounts(myPlayers);
    // Fill starters greedily: dedicated slots then FLEX (RB/WR/TE) then SF (QB first).
    const spare = { ...c };
    const unfilled = [];
    for (const pos of ['QB', 'RB', 'WR', 'TE', 'K', 'DEF']) {
      const need = sl[pos] || 0;
      const used = Math.min(spare[pos], need);
      spare[pos] -= used;
      for (let i = 0; i < need - used; i++) unfilled.push(pos);
    }
    for (let i = 0; i < sl.FLEX; i++) {
      const donor = ['RB', 'WR', 'TE'].find((d) => spare[d] > 0);
      if (donor) spare[donor]--; else unfilled.push('FLEX');
    }
    for (let i = 0; i < sl.SUPER_FLEX; i++) {
      // Superflex is a QB slot in practice — a spare WR does NOT "cover" it.
      // Until QB is fully stocked, an SFLEX without a QB counts as unfilled.
      if (spare.QB > 0) { spare.QB--; continue; }
      if (c.QB >= sl.QB + sl.SUPER_FLEX) {
        const donor = ['RB', 'WR', 'TE'].find((d) => spare[d] > 0);
        if (donor) { spare[donor]--; continue; }
      }
      unfilled.push('SFLEX');
    }
    const caps = {
      QB: sl.QB + sl.SUPER_FLEX + 1,
      RB: sl.RB + Math.max(2, sl.BN - 2),
      WR: sl.WR + Math.max(2, sl.BN - 2),
      TE: sl.TE + 1,
      K: sl.K,
      DEF: sl.DEF,
    };
    // Bench-construction targets: starters alone is fragile — one injury or bye
    // at a 2-deep position and the FLEX starts nobody, while WR7 is worth ~0.
    const depthTarget = {
      QB: sl.QB + sl.SUPER_FLEX,
      RB: sl.RB + 2,
      WR: sl.WR + 2,
      TE: sl.TE, // TE2 is a luxury, never a need — byes stream off waivers
      K: sl.K, DEF: sl.DEF,
    };
    const totalDeficit = ['QB', 'RB', 'WR', 'TE']
      .reduce((s, p) => s + Math.max(0, depthTarget[p] - c[p]), 0);
    const depthCrunch = myRemainingPicks <= totalDeficit + 1; // picks are scarcer than holes
    const mult = {};
    const tight = myRemainingPicks - unfilled.length <= 1;
    for (const pos of POSITIONS) {
      if ((sl[pos] || 0) === 0 && pos !== 'RB' && pos !== 'WR' && pos !== 'TE' && pos !== 'QB') { mult[pos] = 0; continue; }
      if (c[pos] >= caps[pos]) { mult[pos] = 0.15; continue; }
      let m = 1;
      const starterGap = unfilled.filter((u) => u === pos || (u === 'FLEX' && ['RB', 'WR', 'TE'].includes(pos)) || (u === 'SFLEX' && pos === 'QB')).length;
      if (starterGap > 0) m = tight ? 1.5 : (pos === 'QB' ? 1.3 : 1.15); // SFLEX makes QB2 near-mandatory
      else {
        const deficit = Math.max(0, (depthTarget[pos] || 0) - c[pos]);
        if (deficit >= 2) m = 1.05;       // seriously thin bench at this position
        else if (deficit === 1) m = 0.92; // one short of healthy depth
        else m = 0.55;                    // depth met — surplus is near-worthless
        if (deficit > 0 && depthCrunch) m *= 1.3; // holes outnumber remaining picks
      }
      mult[pos] = m;
    }
    return { counts: c, unfilled, caps, mult, tight, depthTarget };
  }

  /* ---------- why generator ---------- */

  function whyText(player, ctx, extras) {
    const bits = [];
    if (extras && extras.deadlineBoost >= 2) {
      bits.push('LAST realistic window for a startable ' + player.pos + ' — supply dries up around pick ' + extras.dryAt);
    } else if (extras && extras.deadlineBoost >= 1.4) {
      bits.push('startable ' + player.pos + ' supply dries up around pick ' + extras.dryAt + ' — window closing');
    }
    const pr = ctx.runs[player.pos] || 1;
    if (pr >= 1.3 && ctx.recentPosCount[player.pos] >= 2) {
      bits.push(ctx.recentPosCount[player.pos] + ' ' + player.pos + 's went in the last ' + ctx.windowSize + ' picks (' + pr.toFixed(1) + '× run pressure)');
    }
    const tierMates = ctx.availByPos[player.pos].filter((p) => p.tier === player.tier);
    if (player.tier <= 3 && tierMates.length <= 3) {
      bits.push(tierMates.length === 1 ? 'LAST tier-' + player.tier + ' ' + player.pos + ' on the board' : 'only ' + tierMates.length + ' tier-' + player.tier + ' ' + player.pos + 's left');
    }
    const sc = ctx.scarcityByPos && ctx.scarcityByPos[player.pos];
    if (sc && sc.boost >= 1.3 && sc.supply <= 9) {
      bits.push('only ' + sc.supply + ' startable ' + player.pos + 's left for ' + sc.demand + ' open league slots');
    }
    if (extras && extras.survivalNext != null && extras.survivalNext < 0.65) {
      bits.push(Math.round((1 - extras.survivalNext) * 100) + '% chance he’s gone before your next pick' + (extras.nextPickLabel ? ' (' + extras.nextPickLabel + ')' : ''));
    }
    if (ctx.currentPickNo && player.adpReal && ctx.currentPickNo - player.adp >= ctx.shape.teams * 0.5) {
      bits.push('value falling: superflex ADP ' + player.adp.toFixed(0) + ', still here at pick ' + ctx.currentPickNo);
    }
    const gap = extras && extras.starterGapLabel;
    if (gap) bits.push('fills your empty ' + gap + ' slot');
    else if (ctx.needs && ctx.needs.depthTarget) {
      const have = ctx.needs.counts[player.pos] || 0;
      const want = ctx.needs.depthTarget[player.pos] || 0;
      if (have < want) bits.push('you\'re thin at ' + player.pos + ' (' + have + ' rostered, healthy is ' + want + ') — one injury from an empty slot');
    }
    if (extras && extras.byeFx) {
      if (extras.byeFx.coveredWeeks.length) {
        bits.push('keeps you a FULL lineup through the wk-' + extras.byeFx.coveredWeeks.join('/') + ' byes');
      }
      if (extras.byeFx.stacked >= 2) {
        bits.push('⚠ wk-' + player.bye + ' bye stacks ' + (extras.byeFx.stacked + 1) + ' of your players sitting the same week');
      }
    }
    if (extras && extras.byeClash) bits.push('⚠ ' + extras.byeClash);
    if (player.injury && player.injury !== 'Questionable') {
      bits.push('⚠ listed ' + player.injury + (player.injuryNote ? ' (' + player.injuryNote + ')' : '') +
        (player.injuryMult < 1 ? ' — value already discounted ' + Math.round((1 - player.injuryMult) * 100) + '%' : ''));
    }
    if (player.dropping) bits.push('📉 being mass-dropped on Sleeper right now — check the news before committing');
    else if (player.newsFresh) bits.push('📰 fresh news on him in the last 48h — worth a glance');
    if (!bits.length) bits.push('best value on the board: ' + player.vorp + ' pts over replacement ' + player.pos);
    return bits.join('. ') + '.';
  }

  function demotionNotes(ctx, chosenPos) {
    const notes = [];
    for (const pos of ['QB', 'RB', 'WR', 'TE']) {
      if (pos === chosenPos) continue;
      if (ctx.needs.mult[pos] <= 0.2 && ctx.needs.counts[pos] > 0) {
        notes.push(pos + ' demoted: you roster ' + ctx.needs.counts[pos]);
      } else if (ctx.needs.mult[pos] <= 0.6 && ctx.needs.depthTarget &&
                 (ctx.needs.counts[pos] || 0) >= (ctx.needs.depthTarget[pos] || 0)) {
        notes.push(pos + ' depth met (' + ctx.needs.counts[pos] + ')');
      }
    }
    return notes;
  }

  /* ---------- master analysis ---------- */

  /**
   * state: {pool, picks, mySeat, shape, watchlistIds:Set, currentPickNo (next overall to be made)}
   * Returns full war-room analysis from mySeat's perspective.
   */
  function analyze(state) {
    const { pool, picks, mySeat, shape } = state;
    const { bySlot, takenIds } = rosterFromPicks(picks, pool);
    const available = pool.filter((p) => !takenIds.has(p.id));
    const availByPos = groupByPos(available);
    const slotCounts = {};
    for (const slot in bySlot) slotCounts[slot] = posCounts(bySlot[slot]);

    const filledPickNos = new Set(picks.map((pk) => pk.pick_no));
    const totalPicks = shape.teams * shape.rounds;
    // next overall pick to be made on the live board:
    let currentPickNo = 1;
    while (filledPickNos.has(currentPickNo) && currentPickNo <= totalPicks) currentPickNo++;

    const mine = myPickNumbers(mySeat, shape);
    const myUpcoming = mine.filter((n) => !filledPickNos.has(n) && n >= currentPickNo);
    const nextMyPick = myUpcoming[0] || null;
    const followingMyPick = myUpcoming[1] || null;
    const myTurnNow = nextMyPick === currentPickNo;
    // picks by other teams before it's my turn (keeper slots don't threaten):
    let picksUntilMe = 0;
    if (nextMyPick) {
      for (let k = currentPickNo; k < nextMyPick; k++) if (!filledPickNos.has(k)) picksUntilMe++;
    }

    const adpFit = fitLiveAdp(picks, pool);
    const runs = runPressure(picks, pool, shape);
    const windowSize = Math.min(picks.filter((p) => !p.is_keeper).length, shape.teams);
    const recentPosCount = {};
    {
      const poolById = {};
      for (const p of pool) poolById[p.id] = p;
      for (const pk of picks.slice(-windowSize)) {
        if (pk.is_keeper) continue;
        const pos = (poolById[String(pk.player_id)] || {}).pos || (pk.metadata && pk.metadata.position);
        if (pos) recentPosCount[pos] = (recentPosCount[pos] || 0) + 1;
      }
    }

    const myPlayers = bySlot[mySeat] || [];
    const needs = myNeeds(myPlayers, shape, myUpcoming.length);

    const ctx = {
      shape, runs, slotCounts, filledPickNos, availByPos, needs,
      recentPosCount, windowSize, currentPickNo, adpFit,
    };

    // survival of every relevant available player to my NEXT pick
    // (from my current decision point: if it's my turn, horizon = my following pick)
    const horizonFrom = myTurnNow ? currentPickNo : currentPickNo - 1;
    const horizonTo = myTurnNow ? (followingMyPick || totalPicks + 1) : (nextMyPick || totalPicks + 1);
    const survival = {};
    for (const pos of ['QB', 'RB', 'WR', 'TE']) {
      for (const p of (availByPos[pos] || []).slice(0, 24)) {
        survival[p.id] = survivalProb(p, horizonFrom, horizonTo, ctx);
      }
    }

    // ------- recommendation (my seat only) -------
    let recommendation = null;
    if (nextMyPick) {
      const candidates = [];
      const scarcityByPos = {};
      const deadlineByPos = {};
      const currentRound = Math.ceil(currentPickNo / shape.teams);
      for (const pos of ['QB', 'RB', 'WR', 'TE']) {
        // Hard skip: never recommend past the roster cap (a 3rd TE is dead weight).
        if ((needs.counts[pos] || 0) >= needs.caps[pos]) continue;
        const arr = (availByPos[pos] || []).filter((p) => !(state.avoidIds && state.avoidIds.has(p.id)));
        if (!arr.length) continue;
        const bestNow = arr.reduce((a, b) => (val(b) > val(a) ? b : a), arr[0]);
        // TE2 rule: with the TE slot filled, a second TE is only ever a luxury —
        // offered in the last rounds, or earlier only if a starter-grade TE is
        // sliding absurdly. Otherwise TE never competes for the pick.
        let luxuryTE = false;
        if (pos === 'TE' && (needs.counts.TE || 0) >= (shape.slots.TE || 1)) {
          const slidingElite = val(bestNow) >= 20;
          if (currentRound < 12 && !slidingElite) continue;
          luxuryTE = true;
        }
        const later = expectedBestLater(arr, myTurnNow ? currentPickNo : nextMyPick, followingMyPick || totalPicks + 1, ctx);
        const oppCost = Math.max(0, val(bestNow) - later.expected);
        const scarcity = posScarcity(pos, availByPos, slotCounts, shape);
        scarcityByPos[pos] = scarcity;
        // Deadline pressure: if this position's startable supply dries up before
        // my later picks AND I still need a starter there, this window is urgent.
        // Exhaustion: ADP says when supply *should* dry; the room's observed
        // consumption rate says when it actually will. Trust the earlier one.
        let dryAt = exhaustionPick(pos, availByPos, runs, currentPickNo, adpFit);
        const eatRate = (recentPosCount[pos] || 0) / Math.max(1, windowSize);
        if (windowSize >= 8 && eatRate > 0) {
          const startableLeft = (availByPos[pos] || []).filter((p) => p.vorp > 0).length;
          dryAt = Math.min(dryAt, currentPickNo + startableLeft / eatRate);
        }
        deadlineByPos[pos] = Math.round(dryAt);
        let deadlineBoost = 1;
        const starterOpen = needs.mult[pos] >= 1; // starter gap exists at this pos
        if (starterOpen) {
          const thirdPick = myUpcoming[2] || totalPicks + 1;
          if (dryAt <= (followingMyPick || totalPicks + 1)) deadlineBoost = 2.0;      // last realistic shot
          else if (dryAt <= thirdPick) deadlineBoost = 1.4;                            // window closing
        }
        let mult = (needs.mult[pos] != null ? needs.mult[pos] : 1) * scarcity.boost * deadlineBoost;
        const base = val(bestNow) + 0.6 * oppCost;
        // Negative values invert multiplicative logic: divide instead so
        // deprioritized positions stay deprioritized below replacement.
        let score = base >= 0 ? base * mult : base / mult;
        // Full-team-every-week shaping: reward plugging a bye-week lineup hole,
        // tax stacking a 3rd+ body onto a bye your roster already leans on.
        // Depth decisions only — an unfilled starter slot always outranks bye math.
        const byeFx = byeImpact(bestNow, myPlayers, shape);
        if ((needs.mult[pos] || 1) < 1.1) {
          score += 2.5 * Math.min(2, byeFx.covered) - 2 * Math.max(0, byeFx.stacked - 1);
        }
        candidates.push({ pos, player: bestNow, oppCost: Math.round(oppCost * 10) / 10, later, score, scarcity, deadlineBoost, dryAt: Math.round(dryAt), luxuryTE, byeFx });
      }
      ctx.scarcityByPos = scarcityByPos;
      ctx.deadlineByPos = deadlineByPos;
      candidates.sort((a, b) => b.score - a.score);
      if (candidates.length) {
        // Bye collision: drafting a same-position player who sits the same week
        // as one you roster — in superflex a QB1/QB2 shared bye is a lost week.
        const byeClashFor = (player) => {
          if (!player.bye) return null;
          const clash = myPlayers.find((p) => p.pos === player.pos && p.bye && p.bye === player.bye);
          if (!clash) return null;
          const sev = player.pos === 'QB' ? 'same wk-' + player.bye + ' bye as ' + shortName(clash.name) + ' — a week you cannot stream in superflex' :
            'same wk-' + player.bye + ' bye as ' + shortName(clash.name);
          return sev;
        };
        const starterGapFor = (pos) => {
          const u = needs.unfilled;
          if (u.includes(pos)) return pos;
          if (pos === 'QB' && u.includes('SFLEX')) return 'SFLEX';
          if (['RB', 'WR', 'TE'].includes(pos) && u.includes('FLEX')) return 'FLEX';
          return null;
        };
        const branchFor = (cand) => {
          // If you take cand now, what does your NEXT turn likely look like?
          const from = myTurnNow ? currentPickNo : nextMyPick;
          const to = followingMyPick || totalPicks + 1;
          const parts = [];
          for (const pos of ['QB', 'RB', 'WR', 'TE']) {
            if (pos === cand.pos) continue;
            if ((needs.mult[pos] || 0) <= 0.2) continue;
            const arr = (availByPos[pos] || []).filter((p) => !(state.avoidIds && state.avoidIds.has(p.id)));
            if (!arr.length) continue;
            const later = expectedBestLater(arr, from, to, ctx);
            if (later.likelyBest) {
              parts.push(pos + ': likely ' + shortName(later.likelyBest.player.name) + ' (' + Math.round(later.likelyBest.survival * 100) + '%)');
            }
          }
          const label = followingMyPick ? fmtPick(followingMyPick, shape.teams) : 'end';
          return 'Then at ' + label + ' → ' + (parts.slice(0, 3).join(' · ') || 'thin board');
        };
        const mkOption = (cand) => ({
          player: cand.player,
          pos: cand.pos,
          score: Math.round(cand.score * 10) / 10,
          oppCost: cand.oppCost,
          survivalNext: survival[cand.player.id] != null ? survival[cand.player.id] : null,
          why: (cand.luxuryTE ? 'Luxury, not a need: ' : '') + whyText(cand.player, ctx, {
            survivalNext: survival[cand.player.id],
            nextPickLabel: followingMyPick ? fmtPick(followingMyPick, shape.teams) : null,
            starterGapLabel: starterGapFor(cand.pos),
            deadlineBoost: cand.deadlineBoost,
            dryAt: cand.dryAt,
            byeClash: byeClashFor(cand.player),
            byeFx: cand.byeFx,
          }),
          branch: branchFor(cand),
        });
        const top = mkOption(candidates[0]);
        const alternatives = candidates.slice(1, 3).map(mkOption);
        // Position-lock: "I'm sold on RB — show me the top 3 and pick your favorite."
        const optionsFor = (pos, n) => {
          const arr = (availByPos[pos] || []).filter((p) => !(state.avoidIds && state.avoidIds.has(p.id))).slice(0, n || 3);
          const opts = arr.map((p) => ({
            player: p,
            survivalNext: survival[p.id] != null ? survival[p.id] : null,
            why: whyText(p, ctx, {
              survivalNext: survival[p.id],
              nextPickLabel: followingMyPick ? fmtPick(followingMyPick, shape.teams) : null,
              starterGapLabel: starterGapFor(pos),
              byeClash: byeClashFor(p),
            }),
          }));
          // best-of: highest blended value wins unless a lower one has a
          // meaningfully worse survival picture that flips the calculus
          let bestIdx = 0;
          for (let i = 1; i < opts.length; i++) {
            if (val(opts[i].player) > val(opts[bestIdx].player) + 2) bestIdx = i;
          }
          const b = opts[bestIdx];
          if (b) {
            const runnerUp = Math.max(0, ...opts.filter((_, i) => i !== bestIdx).map((o) => val(o.player)));
            b.bestBecause = 'Best of these: ' + shortName(b.player.name) + ' — ' +
              (val(b.player) - runnerUp > 8
                ? 'clear value gap over the others at the position'
                : 'edge on blended value; survival odds break the tie') + '.';
          }
          return opts.map((o, i) => ({ ...o, isBest: i === bestIdx }));
        };
        recommendation = {
          myTurn: myTurnNow,
          pickLabel: fmtPick(nextMyPick, shape.teams),
          top,
          alternatives,
          demotions: demotionNotes(ctx, candidates[0].pos),
          optionsFor,
        };
      }
    }

    return {
      available, availByPos, bySlot, slotCounts,
      myPlayers, needs, runs, recentPosCount, windowSize,
      currentPickNo, nextMyPick, followingMyPick, picksUntilMe, myTurnNow,
      onClockSlot: currentPickNo <= totalPicks ? slotForPick(currentPickNo, shape.teams, shape.reversalRound) : null,
      survival, recommendation, totalPicks, adpFit,
    };
  }

  /* ---------- utils ---------- */

  function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }
  function shortName(name) {
    const parts = String(name).trim().split(/\s+/);
    if (parts.length < 2) return name;
    return parts[0][0] + '. ' + parts.slice(1).join(' ');
  }

  return {
    BYE_2026, INJURY_MULT, fitLiveAdp, fittedPick, lineupHoles, byeImpact,
    leagueShape, buildPool, scoreProjection,
    startableCounts, replacementLevels, applyVorp, applyMarketBlend, posScarcity, val, assignTiers, groupByPos,
    slotForPick, myPickNumbers, fmtPick,
    rosterFromPicks, posCounts, runPressure, survivalProb, expectedBestLater,
    myNeeds, analyze, shortName, clamp,
  };
});
