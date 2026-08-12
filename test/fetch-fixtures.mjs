/* Fetch engine-test fixtures from Sleeper's public API for YOUR league.
 * Usage: node test/fetch-fixtures.mjs <your_sleeper_league_id>
 *
 * Writes data/league.json, data/draft.json, data/projections.json,
 * data/players.json (trimmed). Note: the assertions in engine-test.mjs
 * encode expectations for a 12-team superflex PPR league drafting 15
 * rounds — fixtures from a different shape will run, but some
 * shape-specific asserts may fail by design.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const leagueId = process.argv[2];
if (!leagueId || !/^\d{10,20}$/.test(leagueId)) {
  console.error('Usage: node test/fetch-fixtures.mjs <your_sleeper_league_id>');
  process.exit(1);
}
const dataDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
mkdirSync(dataDir, { recursive: true });
const get = async (p) => {
  const res = await fetch('https://api.sleeper.app' + p);
  if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + p);
  return res.json();
};

console.log('league ' + leagueId + '…');
const league = await get('/v1/league/' + leagueId);
const draft = await get('/v1/draft/' + league.draft_id);
const posQ = 'season_type=regular&position[]=QB&position[]=RB&position[]=WR&position[]=TE';
console.log('projections for ' + league.season + '…');
const projections = await get('/projections/nfl/' + league.season + '?' + posQ);
console.log('players db (large)…');
const full = await get('/v1/players/nfl');
const needed = new Set(projections.map((r) => String(r.player_id)));
const players = {};
for (const id of Object.keys(full)) {
  const p = full[id];
  if (!p) continue;
  if (needed.has(id) || ((p.fantasy_positions || []).some((x) => ['QB', 'RB', 'WR', 'TE'].includes(x)) && p.active)) {
    players[id] = {
      first_name: p.first_name, last_name: p.last_name, team: p.team, position: p.position,
      injury_status: p.injury_status, injury_body_part: p.injury_body_part,
      news_updated: p.news_updated, years_exp: p.years_exp,
    };
  }
}
writeFileSync(join(dataDir, 'league.json'), JSON.stringify(league));
writeFileSync(join(dataDir, 'draft.json'), JSON.stringify(draft));
writeFileSync(join(dataDir, 'projections.json'), JSON.stringify(projections));
writeFileSync(join(dataDir, 'players.json'), JSON.stringify(players));
console.log('wrote 4 fixtures to data/');

const rp = league.roster_positions || [];
const sf = rp.includes('SUPER_FLEX');
if (league.total_rosters !== 12 || !sf || rp.length !== 15) {
  console.warn('\nNOTE: your league is ' + league.total_rosters + '-team, superflex ' + (sf ? 'ON' : 'OFF') +
    ', ' + rp.length + ' rounds — engine-test.mjs asserts a 12-team/superflex/15-round shape, so some asserts may fail.');
}
