/* Engine sanity tests against REAL Sleeper data (data/*.json).
 * Run: node test/engine-test.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const E = require(join(here, '..', 'engine.js'));
const load = (f) => JSON.parse(readFileSync(join(here, '..', 'data', f), 'utf8'));

const league = load('league.json');
const draft = load('draft.json');
const projections = load('projections.json');
const playersDb = load('players.json');

let pass = 0, fail = 0;
function assert(cond, label, detail) {
  if (cond) { pass++; console.log('  ok  ' + label); }
  else { fail++; console.log('  FAIL ' + label + (detail ? ' — ' + detail : '')); }
}

console.log('== shape ==');
const shape = E.leagueShape(league, draft.settings);
assert(shape.teams === 12, 'teams=12');
assert(shape.slots.SUPER_FLEX === 1 && shape.slots.QB === 1, 'QB+SFLEX slots');
assert(shape.slots.WR === 3 && shape.slots.K === 0 && shape.slots.DEF === 0, '3WR, no K/DEF');
assert(shape.rounds === 15, '15 rounds');
assert(shape.scoring && shape.scoring.rec === 1, 'PPR scoring imported');

console.log('== pool & replacement ==');
const pool = E.buildPool(projections, playersDb, shape);
assert(pool.length > 200 && pool.length < 900, 'pool size sane: ' + pool.length);
const { levels, startable } = E.replacementLevels(pool, shape);
assert(startable.QB >= 20 && startable.QB <= 26, 'superflex QB startable ~22: ' + startable.QB);
assert(startable.WR >= 40, '3WR+flex WR demand: ' + startable.WR);
E.applyVorp(pool, levels);
E.applyMarketBlend(pool);
E.assignTiers(pool);

const byPos = E.groupByPos(pool);
const topQB = byPos.QB[0];
assert(topQB.value > 110, 'elite QB blended value large in SF: ' + topQB.name + ' ' + topQB.value);
// Market blend must lift QBs onto the value board (raw VORP had ~0 in top-15)
const top15 = pool.slice().sort((a, b) => b.value - a.value).slice(0, 15);
const qbInTop15 = top15.filter((p) => p.pos === 'QB').length;
assert(qbInTop15 >= 2, 'market blend lifts QBs into top-15 value: ' + qbInTop15);
// exact-scoring vs pts_ppr sanity: Chase ~311
const chase = pool.find((p) => p.name.includes('Chase') && p.pos === 'WR');
assert(chase && Math.abs(chase.proj - 311.1) < 15, 'Chase proj ≈ pts_ppr: ' + (chase && chase.proj));

console.log('== snake math ==');
assert(E.slotForPick(1, 12, 0) === 1 && E.slotForPick(12, 12, 0) === 12, 'round 1 ascending');
assert(E.slotForPick(13, 12, 0) === 12 && E.slotForPick(24, 12, 0) === 1, 'round 2 descending');
const mine = E.myPickNumbers(2, shape);
assert(mine[0] === 2 && mine[1] === 23 && mine[2] === 26, 'seat 2 picks: 2, 23, 26 → got ' + mine.slice(0, 3));
assert(mine.length === 15, '15 picks for seat 2');
assert(E.fmtPick(23, 12) === '2.11', 'fmt 23 → 2.11');

console.log('== simulated draft at seat 2 (ADP autopilot with keepers) ==');
// Keepers: pretend two keepers exist — seat 5 keeps a top RB in round 14, seat 2 (you) keeps an RB in round 14.
const sortedByAdp = pool.slice().sort((a, b) => a.adp - b.adp);
const myKeeperRB = byPos.RB[3]; // a good RB he "kept"
const rivalKeeperRB = byPos.RB[1];
const keeperPicks = [];
const keeperPickNo = (seat, round) => E.myPickNumbers(seat, shape).find((n) => Math.ceil(n / 12) === round);
keeperPicks.push({ player_id: myKeeperRB.id, pick_no: keeperPickNo(2, 14), round: 14, draft_slot: 2, is_keeper: true });
keeperPicks.push({ player_id: rivalKeeperRB.id, pick_no: keeperPickNo(5, 14), round: 14, draft_slot: 5, is_keeper: true });

function simulateDraft(strategySeat, log) {
  const picks = [...keeperPicks];
  const kept = new Set(keeperPicks.map((k) => k.player_id));
  const takenSet = new Set(kept);
  const filled = new Set(keeperPicks.map((k) => k.pick_no));
  const recsSeen = [];
  const total = shape.teams * shape.rounds;
  for (let n = 1; n <= total; n++) {
    if (filled.has(n)) continue;
    const slot = E.slotForPick(n, shape.teams, shape.reversalRound);
    let chosen;
    if (slot === strategySeat) {
      const a = E.analyze({ pool, picks, mySeat: strategySeat, shape });
      chosen = a.recommendation ? a.recommendation.top.player : pool.find((p) => !takenSet.has(p.id));
      recsSeen.push({ n, rec: a.recommendation });
    } else {
      // ADP autopilot with light need-awareness and noise
      const roster = picks.filter((p) => p.draft_slot === slot);
      const counts = E.posCounts(roster.map((pk) => pool.find((p) => p.id === pk.player_id) || { pos: '?' }));
      const cands = sortedByAdp.filter((p) => !takenSet.has(p.id)).slice(0, 8);
      chosen = cands.find((p) => {
        if (p.pos === 'QB' && counts.QB >= 3) return false;
        if (p.pos === 'TE' && counts.TE >= 2) return false;
        if (p.pos === 'RB' && counts.RB >= 6) return false;
        if (p.pos === 'WR' && counts.WR >= 7) return false;
        return true;
      }) || cands[0];
    }
    takenSet.add(chosen.id);
    picks.push({ player_id: chosen.id, pick_no: n, round: Math.ceil(n / 12), draft_slot: slot, is_keeper: false });
    filled.add(n);
  }
  return { picks, recsSeen };
}

const { picks: simPicks, recsSeen } = simulateDraft(2);
const myFinal = simPicks.filter((p) => p.draft_slot === 2).map((p) => pool.find(q => q.id === p.player_id));
const myCounts = E.posCounts(myFinal);
console.log('  My sim roster:', JSON.stringify(myCounts), '(+keeper RB baked in)');
assert(myFinal.length === 15, 'drafted full 15 rounds');
assert(myCounts.QB >= 2, 'engine secured >=2 QBs in superflex: ' + myCounts.QB);
assert(myCounts.QB <= 4, 'did not hoard QBs: ' + myCounts.QB);
// QB TIMING is the superflex tell: starter QB early, QB2 before the cliff.
const myQBRounds = simPicks.filter((p) => p.draft_slot === 2 && !p.is_keeper)
  .filter((p) => (pool.find((q) => q.id === p.player_id) || {}).pos === 'QB')
  .map((p) => p.round);
assert(myQBRounds.length && myQBRounds[0] <= 6, 'first QB secured by round 6: r' + myQBRounds[0]);
// This autopilot room hoards 3 QBs/team (36 demand vs ~22 startable) — a QB
// vacuum harsher than real rooms (realistic sims secure QB2 by R4). The bound
// here guards against total QB2 failure, not optimal timing.
assert(myQBRounds.length >= 2 && myQBRounds[1] <= 12, 'second QB before the vacuum-room cliff: r' + myQBRounds[1]);
assert(myCounts.TE <= 2, 'TE hard cap respected: ' + myCounts.TE);
assert(myCounts.K === 0 && myCounts.DEF === 0, 'never drafted K/DEF');
assert(myCounts.RB >= 3 && myCounts.WR >= 4, 'filled RB/WR starters: RB=' + myCounts.RB + ' WR=' + myCounts.WR);
const starters = shape.slots.QB + shape.slots.RB + shape.slots.WR + shape.slots.TE + shape.slots.FLEX + shape.slots.SUPER_FLEX;
assert(myCounts.TE >= 1, 'has a TE');
// every rec had reasoning + alternatives
const withWhy = recsSeen.filter((r) => r.rec && r.rec.top && r.rec.top.why && r.rec.top.why.length > 10);
assert(withWhy.length === recsSeen.length, 'every recommendation carried a why');
const withBranch = recsSeen.filter((r) => r.rec && r.rec.top.branch && r.rec.top.branch.includes('→'));
assert(withBranch.length >= recsSeen.length - 1, 'branch consequences present');

console.log('== determinism & reactivity (reactivity requirement) ==');
const a1 = E.analyze({ pool, picks: simPicks.slice(0, 22), mySeat: 2, shape });
const a2 = E.analyze({ pool, picks: simPicks.slice(0, 22), mySeat: 2, shape });
assert(a1.recommendation.top.player.id === a2.recommendation.top.player.id, 'same state → same recommendation');
// change context: force a 5-QB run right before my pick 23
const runPicks = simPicks.slice(0, 12).filter(p => !p.is_keeper || p.pick_no <= 12);
const qbs = byPos.QB.filter((q) => !runPicks.some((p) => p.player_id === q.id)).slice(0, 9);
const altPicks = [...simPicks.slice(0, 12)];
let no = 13;
for (const q of qbs) { if (altPicks.some(p=>p.pick_no===no)) { no++; continue; } altPicks.push({ player_id: q.id, pick_no: no, round: 2, draft_slot: E.slotForPick(no, 12, 0), is_keeper: false }); no++; if (no > 22) break; }
const a3 = E.analyze({ pool, picks: altPicks, mySeat: 2, shape });
assert(a3.runs.QB > 1.25, 'QB run detected: pressure=' + a3.runs.QB.toFixed(2));
assert(a1.recommendation.top.player.id !== a3.recommendation.top.player.id || a1.recommendation.top.pos !== a3.recommendation.top.pos || JSON.stringify(a1.recommendation.top.why) !== JSON.stringify(a3.recommendation.top.why), 'different context → different advice');

console.log('== survival sanity ==');
const someWR = byPos.WR[5];
const sNear = E.survivalProb(someWR, 22, 24, { runs: a1.runs, shape, slotCounts: a1.slotCounts, filledPickNos: new Set() });
const sFar = E.survivalProb(someWR, 22, 46, { runs: a1.runs, shape, slotCounts: a1.slotCounts, filledPickNos: new Set() });
assert(sNear > sFar, 'survival decays with distance: ' + sNear.toFixed(2) + ' > ' + sFar.toFixed(2));
assert(sNear >= 0.01 && sNear <= 0.99, 'probabilities bounded');

console.log('== bench depth vs RB-hungry room (mock regression) ==');
{
  let seed = 7; const rnd = () => ((seed = seed * 1103515245 + 12345 >>> 0) / 4294967296);
  const picks = []; const taken = new Set();
  for (let n = 1; n <= 180; n++) {
    const slot = E.slotForPick(n, 12, 0);
    let chosen;
    if (slot === 2) {
      const a = E.analyze({ pool, picks, mySeat: 2, shape });
      chosen = a.recommendation.top.player;
    } else {
      const cands = sortedByAdp.filter((p) => !taken.has(p.id)).slice(0, 12);
      const rbs = cands.filter((p) => p.pos === 'RB');
      chosen = (rbs.length && rnd() < 0.5) ? rbs[0] : cands[Math.floor(Math.pow(rnd(), 2) * 8)];
    }
    taken.add(chosen.id);
    picks.push({ player_id: chosen.id, pick_no: n, round: Math.ceil(n / 12), draft_slot: slot, is_keeper: false });
  }
  const mine = picks.filter((p) => p.draft_slot === 2).map((p) => pool.find((q) => q.id === p.player_id));
  const c = E.posCounts(mine);
  assert(c.RB >= 4, 'RB-hungry room: engine still builds RB depth ≥4, got ' + c.RB);
  assert(c.WR <= 8, 'WR hoarding capped: ' + c.WR);
  assert(c.QB >= 2, 'QBs still secured under RB pressure: ' + c.QB);
}

console.log('== lineup coverage (full team every week) ==');
{
  // Roster where BOTH QBs share a bye → SFLEX/QB unfillable that week
  const mk = (pos, bye, i) => ({ id: 'x' + pos + i, name: pos + ' Guy' + i, pos, bye, proj: 100, adp: 50, vorp: 10, tier: 3 });
  const roster = [mk('QB', 7, 1), mk('QB', 7, 2), mk('RB', 6, 1), mk('RB', 8, 2), mk('RB', 9, 3),
                  mk('WR', 6, 1), mk('WR', 8, 2), mk('WR', 9, 3), mk('WR', 10, 4), mk('TE', 5, 1)];
  const holes = E.lineupHoles(roster, shape);
  assert((holes[7] || 0) >= 1, 'double-QB bye wk7 leaves a starter hole: ' + JSON.stringify(holes));
  // A wk-11 QB plugs it; a wk-7 QB stacks it
  const fx11 = E.byeImpact(mk('QB', 11, 9), roster, shape);
  const fx7 = E.byeImpact(mk('QB', 7, 9), roster, shape);
  assert(fx11.covered > 0 && fx11.coveredWeeks.includes(7), 'off-bye QB plugs the wk-7 hole');
  assert(fx7.covered === 0 && fx7.stacked >= 2, 'same-bye QB plugs nothing and stacks');
  // Injury discount flows into value
  const hurt = pool.find((p) => p.injuryMult < 1);
  if (hurt) assert(hurt.proj * hurt.injuryMult < hurt.proj, 'injury discount applied to ' + hurt.name + ' (' + hurt.injury + ')');
  else console.log('  (no injured players in current pool — discount path untestable today)');
}

console.log('== live ADP fit (keeper-room correction) ==');
assert(Object.keys(E.BYE_2026).length === 32, 'bye map covers 32 teams');
// room drafting exactly at ADP → fit ≈ identity
const adpPicks = pool.slice().sort((a, b) => a.adp - b.adp).slice(0, 30)
  .map((p, i) => ({ player_id: p.id, pick_no: i + 1, round: 1, draft_slot: 1, is_keeper: false }));
const fitId = E.fitLiveAdp(adpPicks, pool);
assert(fitId && Math.abs(fitId.b - 1) < 0.35, 'identity room: slope ≈ 1, got ' + (fitId && fitId.b.toFixed(2)));
// keeper-style room: everyone goes ~12 picks earlier than redraft ADP
const fastPicks = pool.slice().sort((a, b) => a.adp - b.adp).slice(12, 42)
  .map((p, i) => ({ player_id: p.id, pick_no: i + 1, round: 1, draft_slot: 1, is_keeper: false }));
const fitFast = E.fitLiveAdp(fastPicks, pool);
const proj40 = E.fittedPick(40, fitFast);
assert(fitFast && proj40 < 37, 'keeper room: ADP-40 player projected earlier than 37, got ' + proj40.toFixed(1));
// tiny sample → no fit, no phantom runs
assert(E.fitLiveAdp(adpPicks.slice(0, 4), pool) === null, 'fit refuses <8 observations');
const tinyRuns = E.runPressure(adpPicks.slice(0, 5), pool, shape);
assert(tinyRuns.QB === 1 && tinyRuns.WR === 1, 'run gate: tiny sample → pressure 1.0');

console.log('== position-lock ranking ==');
const mid = E.analyze({ pool, picks: simPicks.slice(0, 22), mySeat: 2, shape });
const qbAvail = mid.availByPos.QB.slice(0, 3);
assert(qbAvail.length === 3, 'top-3 QB list available for position-lock UI');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
if (fail) process.exit(1);
// Print a sample recommendation so a human can eyeball the why-quality:
const sample = recsSeen[1] && recsSeen[1].rec;
if (sample) {
  console.log('\n--- sample rec at ' + sample.pickLabel + ' ---');
  console.log('TOP: ' + sample.top.player.name + ' (' + sample.top.pos + ') — ' + sample.top.why);
  console.log('     ' + sample.top.branch);
  sample.alternatives.forEach((alt, i) => console.log('ALT' + (i + 1) + ': ' + alt.player.name + ' (' + alt.pos + ') — ' + alt.why));
  if (sample.demotions.length) console.log('DEMOTED: ' + sample.demotions.join(' | '));
}
