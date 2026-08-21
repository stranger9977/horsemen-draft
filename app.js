/* Horsemen Lodge draft app — static, state in localStorage. */
const TEAMS = 10, ROUNDS = 19, TOTAL = TEAMS * ROUNDS;
const NEEDS = { QB: 2, RB: 4, WR: 4, TE: 2, K: 2, DST: 2 };   // drafted lineup (counted weekly for Total Points)
const IR_SLOTS = 3;
const DEMAND = { QB: 20, RB: 40, WR: 40, TE: 20, K: 20, DST: 20 };
const MANAGERS = ["Nick", "Fox", "AJ"];
const POS_ORDER = ["ALL", "QB", "RB", "WR", "TE", "K", "DST"];

const byId = new Map(PLAYERS.map(p => [p.id, p]));

// ---------- state ----------
let S = {
  events: [],            // [{id, mine}] in pick order
  ranks: { Nick: {}, Fox: {}, AJ: {} },       // manual overall overrides (legacy/import)
  posRanks: { Nick: {}, Fox: {}, AJ: {} },    // {QB:[ids best->worst], ...} from the duel game
  wizard: null,          // resumable duel state {who,pos,sorted,queue,cur,lo,hi,hist}
  who: "Nick",
  slot: 6,
  teamName: "Million Dollar Men",
  sortMode: "consensus",
  onboarded: false,
  tab: "rank", posFilter: "ALL", search: "", moreView: "info",
};
try {
  const raw = localStorage.getItem("lodge26");
  if (raw) S = Object.assign(S, JSON.parse(raw));
} catch (e) {}
function save() { try { localStorage.setItem("lodge26", JSON.stringify(S)); } catch (e) {} }

// ---------- helpers ----------
const norm = s => s.toLowerCase().replace(/[.'\-’]/g, "").replace(/\s+(jr|sr|ii|iii|iv|v)$/g, "").replace(/\s+/g, " ").trim();
const nameIndex = PLAYERS.map(p => ({ id: p.id, key: norm(p.n) })).sort((a, b) => b.key.length - a.key.length);

function normcdf(z) { // Abramowitz-Stegun
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp(-z * z / 2);
  let p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? 1 - p : p;
}

function draftedMap() {
  const m = new Map();
  S.events.forEach((e, i) => m.set(e.id, { mine: e.mine, pick: i + 1 }));
  return m;
}
function myPickNumbers() {
  const out = [];
  for (let r = 1; r <= ROUNDS; r++) out.push((r - 1) * TEAMS + (r % 2 === 1 ? S.slot : TEAMS + 1 - S.slot));
  return out;
}
function currentPick() { return S.events.length + 1; }
function roundOf(pick) { return Math.ceil(pick / TEAMS); }

// league-tuned expected pick (this league drafts DST/K far earlier than market)
function leagueAdp(p) {
  if (p.p === "DST") return p.pr <= 2 ? 62 + 8 * p.pr : p.pr <= 11 ? 88 + 3.2 * (p.pr - 3) : p.pr <= 16 ? 130 + 2.5 * (p.pr - 12) : 158 + 4 * (p.pr - 17);
  if (p.p === "K") return p.pr <= 1 ? 133 : p.pr <= 4 ? 143 + 4 * (p.pr - 2) : 156 + 2.6 * (p.pr - 5);
  return p.adp || 250;
}
function adpSd(p) { return (p.p === "DST" || p.p === "K") ? 12 : Math.max(p.sd || 8, 6); }
function pAvail(p, atPick) { return 1 - normcdf((atPick - leagueAdp(p)) / adpSd(p)); }

// model pos-rank r at position P -> that player's overall model rank (id)
const posIdByRank = {};
for (const p of PLAYERS) { (posIdByRank[p.p] ||= [])[p.pr - 1] = p.id; }

function managerVote(m, p) {
  const manual = S.ranks[m] && S.ranks[m][p.id];
  if (manual != null && manual !== "") return Number(manual);
  const list = S.posRanks[m] && S.posRanks[m][p.p];
  if (list) {
    const i = list.indexOf(p.id);
    if (i >= 0) return posIdByRank[p.p][i] ?? p.id;  // their posrank i+1 inherits model's slot at that posrank
  }
  return null;
}
function consensusScore(p) {
  const vals = [p.id]; // model VORP rank (id == vorp_rank)
  for (const m of MANAGERS) {
    const v = managerVote(m, p);
    if (v != null) vals.push(v);
  }
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}
function anyHumanRanks() {
  return MANAGERS.some(m => (S.ranks[m] && Object.keys(S.ranks[m]).length) ||
    (S.posRanks[m] && Object.keys(S.posRanks[m]).length));
}
function orderedPlayers() {
  const arr = [...PLAYERS];
  if (S.sortMode === "consensus") arr.sort((a, b) => consensusScore(a) - consensusScore(b));
  else if (S.sortMode === "adp") arr.sort((a, b) => (a.adp ?? 999) - (b.adp ?? 999));
  return arr;
}

function myRoster() {
  const slots = { QB: [], RB: [], WR: [], TE: [], K: [], DST: [], IR: [] };
  for (const e of S.events) {
    if (!e.mine) continue;
    const p = byId.get(e.id); if (!p) continue;
    if (slots[p.p].length < NEEDS[p.p]) slots[p.p].push(p); else slots.IR.push(p);
  }
  return slots;
}
function needsLeft() {
  const r = myRoster(), out = {};
  for (const pos in NEEDS) out[pos] = NEEDS[pos] - r[pos].length;
  out.IR = IR_SLOTS - r.IR.length;
  return out;
}

// ---------- flash ----------
let flashT;
function flash(msg) {
  const el = document.getElementById("flash");
  el.textContent = msg; el.classList.add("show");
  clearTimeout(flashT); flashT = setTimeout(() => el.classList.remove("show"), 1600);
}

// ---------- header ----------
function renderHeader() {
  const cp = currentPick(), mp = myPickNumbers();
  const next = mp.find(n => n >= cp);
  let right;
  if (cp > TOTAL) right = "<b>Draft complete</b>";
  else if (next === cp) right = `<span class="onclock">YOU'RE ON THE CLOCK</span><br>Pick ${cp} · Rd ${roundOf(cp)}`;
  else right = `Pick <b>${cp}</b> · Rd ${roundOf(cp)}<br>You: <b>#${next ?? "—"}</b>${next ? ` (${next - cp} away)` : ""}`;
  document.getElementById("pickinfo").innerHTML = right;
}

// ---------- player row ----------
function rowHtml(p, ctx) {
  const d = draftedMap().get(p.id);
  const cls = d ? (d.mine ? "row mine" : "row gone") : "row";
  const cp = currentPick(), mp = myPickNumbers(), next = mp.find(n => n >= cp) || TOTAL;
  let tags = "";
  if (!d) {
    if (p.adp && p.adp < cp - 8) tags += `<span class="tag val">VALUE</span>`;
    if (ctx === "best") {
      const pa = pAvail(p, mp.find(n => n > next) || next + 20);
      if (pa < 0.35) tags += `<span class="tag risk">WON'T LAST</span>`;
    }
    if (p.rk) tags += `<span class="tag rook">R</span>`;
  }
  const rank = S.sortMode === "consensus" ? Math.round(consensusScore(p))
    : S.sortMode === "adp" ? (p.adp ? Math.round(p.adp) : "—") : p.id;
  const sub = `${p.t} · Bye ${p.b ?? "?"} · ${p.p}${p.pr} · ${p.ppg} ppg`;
  const adpTxt = p.adp ? `ADP ${p.adp}` : "ADP —";
  const pk = d ? `<div class="adp">Pick ${d.pick}${d.mine ? " · YOU" : ""}</div>` : `<div class="adp">${adpTxt}</div>`;
  return `<div class="${cls}" data-id="${p.id}">
    <div class="rk">${rank}</div>
    <div class="pbadge p${p.p}">${p.p}</div>
    <div class="pinfo"><div class="pname">${p.n}${tags}</div><div class="psub">${sub}</div></div>
    <div class="pnums"><div class="vorp">${p.v > 0 ? "+" : ""}${p.v}</div>${pk}</div>
  </div>`;
}

// ---------- tabs ----------
const TABS = [
  ["rank", "🥇", "Rank"], ["board", "📋", "Board"], ["best", "⚡", "Best"], ["team", "🏆", "Team"], ["sync", "🔄", "Sync"], ["more", "⚙️", "More"],
];
function renderTabs() {
  document.getElementById("tabs").innerHTML = TABS.map(([k, ic, l]) =>
    `<button class="${S.tab === k ? "on" : ""}" data-tab="${k}"><span class="ic">${ic}</span>${l}</button>`).join("");
}

// ---------- views ----------
function viewBoard() {
  const q = norm(S.search || "");
  let list = orderedPlayers();
  if (S.posFilter !== "ALL") list = list.filter(p => p.p === S.posFilter);
  if (q) list = list.filter(p => norm(p.n).includes(q));
  const chips = POS_ORDER.map(x => `<button class="chip ${S.posFilter === x ? "on" : ""}" data-pos="${x}">${x}</button>`).join("");
  const seg = `<div class="seg">
    <button class="${S.sortMode === "consensus" ? "on" : ""}" data-sort="consensus">Consensus</button>
    <button class="${S.sortMode === "model" ? "on" : ""}" data-sort="model">Model VORP</button>
    <button class="${S.sortMode === "adp" ? "on" : ""}" data-sort="adp">2QB ADP</button></div>`;
  const hint = (S.sortMode === "consensus" && !anyHumanRanks())
    ? `<div class="note" style="margin:6px 4px 0">Consensus = model only so far — play the duel game in the <b>Rank</b> tab and everyone's picks will vote here.</div>` : "";
  return `<div class="chips">${chips}</div>
    <input class="search" id="search" placeholder="Search player…" value="${S.search || ""}">
    ${seg}${hint}
    ${list.map(p => rowHtml(p, "board")).join("")}`;
}

function viewBest() {
  const dm = draftedMap(), nl = needsLeft(), cp = currentPick();
  const mp = myPickNumbers(), next = mp.find(n => n >= cp) || TOTAL;
  const nextNext = mp.find(n => n > next) || Math.min(next + 20, TOTAL);
  const avail = orderedPlayers().filter(p => !dm.has(p.id));

  // need-aware recommendation
  const recs = avail.map(p => {
    let adj = p.v;
    const posLeft = nl[p.p];
    if (posLeft <= 0) adj -= (nl.IR > 0 ? 30 : 999);
    return { p, adj };
  }).filter(x => x.adj > -900).sort((a, b) => b.adj - a.adj).slice(0, 10);

  const recHtml = recs.map(({ p }) => {
    const pa = pAvail(p, nextNext);
    const chip = pa < 0.35 ? `<span class="bad">${Math.round(pa * 100)}% back next</span>` : pa > 0.75 ? `<span class="ok">${Math.round(pa * 100)}% back next</span>` : `<span class="warn">${Math.round(pa * 100)}% back next</span>`;
    return rowHtml(p, "best").replace('</div></div>', `</div><div class="adp">${chip}</div></div>`);
  }).join("");

  // scarcity
  const scarcity = Object.keys(DEMAND).map(pos => {
    const drafted = S.events.filter(e => { const p = byId.get(e.id); return p && p.p === pos; }).length;
    const demandLeft = Math.max(DEMAND[pos] - drafted, 0);
    const supply = avail.filter(p => p.p === pos && p.v > -5).length;
    const cushion = supply - demandLeft;
    const cls = cushion <= 1 ? "bad" : cushion <= 3 ? "warn" : "ok";
    return `<div class="statbox"><div class="l">${pos}</div><div class="v ${cls}">${supply} left / ${demandLeft} needed</div></div>`;
  }).join("");

  // fallers
  const fallers = avail.filter(p => p.adp && p.adp < cp - 8).sort((a, b) => a.adp - b.adp).slice(0, 5);

  return `<h4 class="sect">Recommended at your pick (need-aware)</h4>${recHtml}
    <div class="card"><h2>Startable supply vs league demand</h2><div class="grid2">${scarcity}</div>
    <div class="note">Supply = players still above roughly replacement level. When cushion goes red at a position, the run is on.</div></div>
    ${fallers.length ? `<h4 class="sect">Falling values</h4>${fallers.map(p => rowHtml(p, "best")).join("")}` : ""}`;
}

function viewTeam() {
  const r = myRoster(), nl = needsLeft();
  const slotRows = [];
  for (const pos of ["QB", "RB", "WR", "TE", "K", "DST"]) {
    for (let i = 0; i < NEEDS[pos]; i++) {
      const p = r[pos][i];
      slotRows.push(`<div class="slotrow"><div class="slotlabel">${pos}${i + 1}</div>${p ? `<div><b>${p.n}</b> <span class="psub">${p.t} · Bye ${p.b ?? "?"} · ${p.ppg} ppg</span></div>` : `<div class="empty">open</div>`}</div>`);
    }
  }
  for (let i = 0; i < IR_SLOTS; i++) {
    const p = r.IR[i];
    slotRows.push(`<div class="slotrow"><div class="slotlabel">IR${i + 1}</div>${p ? `<div><b>${p.n}</b> <span class="psub">${p.p} · ${p.t} · Bye ${p.b ?? "?"}</span></div>` : `<div class="empty">open</div>`}</div>`);
  }
  // bye conflicts within a position (both starters out same week hurts Total Points)
  const warns = [];
  for (const pos of ["QB", "RB", "WR", "TE", "K", "DST"]) {
    const byes = r[pos].map(p => p.b).filter(b => b != null);
    const dup = byes.filter((b, i) => byes.indexOf(b) !== i);
    if (dup.length) warns.push(`Both/multiple ${pos}s share bye week ${[...new Set(dup)].join(", ")} — zero ${pos} points that week in Total Points.`);
  }
  const projected = S.events.filter(e => e.mine).reduce((a, e) => a + (byId.get(e.id)?.pts || 0), 0);
  return `<div class="card"><h2>Projected CBS points (drafted lineup)</h2><div class="bignum">${Math.round(projected)}</div>
    <div class="note">Sum of blended season projections for your picks. 2025 Total Points winner scored 3,797; league median ~3,400.</div></div>
    ${warns.map(w => `<div class="card"><div class="note warn">⚠️ ${w}</div></div>`).join("")}
    <div class="card">${slotRows.join("")}</div>`;
}

function viewSync() {
  return `<div class="card"><h2>Sync with CBS draft room</h2>
    <div class="note">During the draft: open <b>whitey.football.cbssports.com → Draft → Draft Results</b>, Select All (long-press → Select All), Copy, then paste here. The app matches every pick, marks your picks by team name, and re-ranks everything. Paste again anytime — it merges.</div>
    <textarea id="synctext" placeholder="Paste the CBS Draft Results page here…"></textarea>
    <button class="btn mine" id="syncbtn">Parse &amp; sync</button>
    <button class="btn other" id="undobtn">Undo last pick</button>
    <button class="btn undo" id="resetbtn">Reset draft (hold intent — asks twice)</button></div>
    <div class="card"><h2>Manual mode</h2><div class="note">No paste needed — just tap players on the Board as they're drafted: "Drafted (other team)" or "My pick".</div></div>`;
}

function viewMore() {
  if (S.moreView === "ranks") S.moreView = "info"; // ranks moved to its own tab
  const seg = `<div class="seg">
    <button class="${S.moreView === "info" ? "on" : ""}" data-more="info">League intel</button>
    <button class="${S.moreView === "settings" ? "on" : ""}" data-more="settings">Settings</button></div>`;
  if (S.moreView === "settings") return seg + viewSettings();
  return seg + viewInfo();
}

function viewOnboard() {
  return `<div class="card" style="margin-top:18vh;text-align:center">
    <div style="font-size:2.2rem">🏈</div>
    <h3 style="font-size:1.15rem;margin:8px 0 4px">Horsemen Lodge draft board</h3>
    <div class="note" style="margin-bottom:14px">First things first — play the ranking game. Quick head-to-head picks, position by position. Your answers + Fox's + AJ's + the model = our board.<br><br>Who's holding this phone?</div>
    ${MANAGERS.map(m => `<button class="btn mine" data-obwho="${m}">${m}</button>`).join("")}
    <button class="btn ghost" data-obskip>Skip — just show me the board</button></div>`;
}

// ---------- ranking duel game ----------
const WIZ_N = { QB: 20, RB: 30, WR: 30, TE: 15, K: 10, DST: 12 };

function wizardStart(pos) {
  if (S.wizard && S.wizard.who === S.who && S.wizard.pos === pos) return; // resume in place
  if (S.wizard) wizardCommit(true); // bank someone else's / another position's progress
  const cands = PLAYERS.filter(p => p.p === pos).slice(0, WIZ_N[pos]).map(p => p.id);
  S.wizard = { who: S.who, pos, sorted: [cands[0]], queue: cands.slice(1), cur: null, lo: 0, hi: 0, hist: [] };
  S.duelOpen = true;
  wizardEnsure(); save();
}
function wizardSnap() {
  const w = S.wizard;
  w.hist.push({ sorted: [...w.sorted], queue: [...w.queue], cur: w.cur, lo: w.lo, hi: w.hi });
  if (w.hist.length > 60) w.hist.shift();
}
function wizardEnsure() {
  const w = S.wizard;
  if (!w) return;
  if (w.cur == null) {
    if (!w.queue.length) { wizardCommit(); return; }
    w.cur = w.queue.shift(); w.lo = 0; w.hi = w.sorted.length;
  }
}
function wizardChoose(curWins) {
  const w = S.wizard;
  wizardSnap();
  const mid = (w.lo + w.hi) >> 1;
  if (curWins) w.hi = mid; else w.lo = mid + 1;
  if (w.lo >= w.hi) { w.sorted.splice(w.lo, 0, w.cur); w.cur = null; }
  wizardEnsure(); save();
}
function wizardCommit(early) {
  const w = S.wizard;
  if (!w) return;
  let final = [...w.sorted];
  if (early) { if (w.cur != null) final.push(w.cur); final = final.concat(w.queue); }
  if (!S.posRanks[w.who]) S.posRanks[w.who] = {};
  S.posRanks[w.who][w.pos] = final;
  S.wizard = null;
  flash(`${w.pos} ranks saved for ${w.who}`);
  save();
}

function shareBlob(who) {
  return JSON.stringify({ who, posRanks: S.posRanks[who] || {}, ranks: S.ranks[who] || {} });
}
function importBlob(o) {
  if (!o || !o.who || !MANAGERS.includes(o.who)) throw new Error("bad blob");
  S.posRanks[o.who] = Object.assign(S.posRanks[o.who] || {}, o.posRanks || {});
  S.ranks[o.who] = Object.assign(S.ranks[o.who] || {}, o.ranks || {});
  save();
  return o.who;
}
function shareUrl(who) {
  const b64 = btoa(unescape(encodeURIComponent(shareBlob(who)))).replace(/\+/g, "-").replace(/\//g, "_");
  return location.origin + location.pathname + "#r=" + b64;
}

function viewDuel() {
  const w = S.wizard;
  const mid = (w.lo + w.hi) >> 1;
  const a = byId.get(w.cur), b = byId.get(w.sorted[mid]);
  if (!a || !b) { wizardCommit(true); return viewRanks(); }
  const placed = w.sorted.length, total = WIZ_N[w.pos];
  const card = p => `<div class="duelcard" data-duel="${p.id}">
      <div class="pbadge p${p.p}" style="margin:0 auto 8px">${p.p}${p.pr}</div>
      <div class="dn">${p.n}</div>
      <div class="ds">${p.t} · Bye ${p.b ?? "?"}<br>${p.ppg} ppg · ADP ${p.adp ?? "—"}</div></div>`;
  return `<div class="card"><h2>${S.who}'s ${w.pos} duels</h2>
    <div class="note">Tap the player you'd rather have <b>this season, in this league</b>.</div>
    <div class="duel">${card(a)}<div class="vs">VS</div>${card(b)}</div>
    <div class="pbar"><div style="width:${Math.round(placed / total * 100)}%"></div></div>
    <div class="note">${placed}/${total} placed</div>
    <button class="btn other" data-wundo>↩︎ Undo last answer</button>
    <button class="btn ghost" data-wback>⏸ Pause — back to positions (progress saved)</button>
    <button class="btn ghost" data-wfinish>Finish now (rest stay in model order)</button></div>`;
}

function viewRanks() {
  const who = S.who;
  const seg = `<div class="seg">${MANAGERS.map(m => `<button class="${who === m ? "on" : ""}" data-who="${m}">${m}</button>`).join("")}</div>`;
  if (S.wizard && S.wizard.who === who && S.duelOpen !== false) return seg + viewDuel();
  const otherGame = S.wizard && S.wizard.who !== who
    ? `<div class="note" style="margin:6px 4px">⏸ ${S.wizard.who} has a ${S.wizard.pos} game in progress — it resumes on ${S.wizard.who}'s tab.</div>` : "";

  const grid = Object.keys(WIZ_N).map(pos => {
    const done = S.posRanks[who] && S.posRanks[who][pos];
    const inProg = S.wizard && S.wizard.who === who && S.wizard.pos === pos;
    const sub = inProg ? `in progress (${S.wizard.sorted.length}/${WIZ_N[pos]}) — tap to resume`
      : done ? `${done.length} ranked — tap to redo`
      : `rank top ${WIZ_N[pos]} · ~${Math.ceil(WIZ_N[pos] * Math.log2(WIZ_N[pos]) / 2)} taps`;
    return `<div class="posbtn ${done ? "done" : ""}" data-posstart="${pos}">
      <div class="t">${pos} ${done ? "✓" : ""}</div>
      <div class="s">${sub}</div></div>`;
  }).join("");

  const reviews = Object.keys(WIZ_N).filter(pos => S.posRanks[who] && S.posRanks[who][pos]).map(pos => {
    const rows = S.posRanks[who][pos].map((id, i) => {
      const p = byId.get(id); if (!p) return "";
      return `<div class="slotrow"><div class="slotlabel">${pos}${i + 1}</div>
        <div style="flex:1"><b>${p.n}</b> <span class="psub">${p.t}${p.pr !== i + 1 ? ` · model ${pos}${p.pr}` : ""}</span></div>
        <div class="arrows">${i > 0 ? `<button data-mv="${pos}:${i}:-1">▲</button>` : ""}${i < S.posRanks[who][pos].length - 1 ? `<button data-mv="${pos}:${i}:1">▼</button>` : ""}</div></div>`;
    }).join("");
    return `<div class="card"><h2>${who}'s ${pos} board</h2>${rows}</div>`;
  }).join("");

  return `${seg}${otherGame}
    <div class="note" style="margin:8px 4px"><b>${who}</b>: play the duel game per position — head-to-head picks, a few minutes each. Progress saves automatically; leave and come back anytime. When you're done, hit <b>Share</b> and text the link to the chat; tapping it auto-imports on the others' phones.</div>
    <div class="posgrid">${grid}</div>
    <button class="btn mine" id="sharelink">📤 Share ${who}'s ranks (link)</button>
    <button class="btn other" id="importranks">Import from pasted link/blob</button>
    <textarea id="ranktext" placeholder="Paste a shared link or blob here, then tap Import"></textarea>
    ${reviews}`;
}

function viewSettings() {
  return `<div class="card"><h2>Settings</h2>
    <div class="slotrow"><div>Draft slot</div><input type="number" min="1" max="10" id="slotin" value="${S.slot}" style="width:4em;margin-left:auto"></div>
    <div class="slotrow"><div>My CBS team name contains</div><input id="teamin" value="${S.teamName}" style="margin-left:auto;background:var(--card2);border:1px solid var(--line);border-radius:8px;color:var(--text);padding:6px;width:11em"></div>
    <div class="note">Snake, ${TEAMS} teams, ${ROUNDS} rounds. Your picks: ${myPickNumbers().join(", ")}</div></div>`;
}

function viewInfo() {
  return `
  <div class="card"><h2>This league is not a normal league</h2><div class="note">
  <b>Total Points counts 2 QB · 4 RB · 4 WR · 2 TE · 2 K · 2 DST every week</b> — your whole 16-man lineup scores, plus 3 IR stash spots. It plays like a 2QB league that also starts two kickers and two defenses.<br><br>
  <b>Receptions are tiered, not PPR:</b> 3 catches = 0 pts, 4–5 = 3, 6–7 = 4, 8–9 = 5… Volume alone doesn't pay until it clusters. Big games matter: +3 at 100 rush/rec yds, +3 at 300 pass yds, and QBs get tiered completion bonuses (20+ completions = 3–7 pts).<br><br>
  <b>Passing TDs are 4 pts</b> and INTs −2, so volume passers with completions ≈ rushing QBs here.<br><br>
  <b>DSTs are huge:</b> points-against + yards-allowed tiers mean a good defensive day is 15–25 pts — as much as a WR1. <b>Kickers land ~8–9 ppg</b> with distance bonuses.</div></div>
  <div class="card"><h2>How the Lodge actually drafts (2025)</h2><div class="note">
  <b>QBs:</b> 5 gone by pick 23, ~14 by round 8.<br>
  <b>DST window:</b> first DST pick 69 (Packers, R7); 11 DSTs gone by pick 114 (R12). The run hits rounds 10–12 — be a starter of it, not a victim.<br>
  <b>Kickers:</b> first at pick 135 (R14), the rest rounds 15–19. Model says top Ks are worth a round earlier than the league pays.<br>
  <b>Last year we (MDM)</b> took DSTs at 140/160 and our K at 181 — the model says that punted ~40+ pts of DST edge.</div></div>
  <div class="card"><h2>Draft plan (slot ${S.slot})</h2><div class="note">
  R1–2 (#${myPickNumbers()[0]}, #${myPickNumbers()[1]}): elite RB volume — this scoring pays RB workhorses (100-yd bonuses, rush yds) and dings low-catch WRs.<br>
  R3–5: best VORP on board; grab QB1 if a top-6 QB slides.<br>
  R6–8: second QB + <b>first elite DST</b> right before the league's window (their first DST went pick 69).<br>
  R9–12: DST2 during the run, TE value, RB/WR depth.<br>
  R13–15: <b>K1 a round before the league moves (first K went 135)</b>, fill starters.<br>
  R16–19: K2, upside stashes for the 3 IR spots — rookie RBs / injured stars, not 3rd QBs (they scored ~0 marginal pts last year).<br><br>
  Watch byes at K/DST: two same-bye DSTs = a guaranteed zero week in Total Points.</div></div>
  <div class="card"><h2>Under the hood</h2><div class="note">
  Rankings = your dynasty-dashboard 2026 model, re-scored play-by-play under the CBS rules (tier bonuses from 2022-25 empirical curves), blended with the market (FFC 10-team 2QB ADP, 4,847 drafts + FantasyPros superflex ECR), VORP vs this league's replacement lines (QB21/RB41/WR41/TE21/K21/DST21). "% back next" uses league-tuned windows for K/DST, market ADP elsewhere.</div></div>`;
}

// ---------- action sheet ----------
function openSheet(id) {
  const p = byId.get(id); if (!p) return;
  const d = draftedMap().get(id);
  const el = document.getElementById("sheet");
  let btns = "";
  if (!d) {
    btns = `<button class="btn mine" data-act="mine">🏆 My pick</button>
            <button class="btn other" data-act="other">Drafted (another team)</button>`;
  } else {
    btns = `<button class="btn undo" data-act="unpick">Remove pick (was #${d.pick}${d.mine ? ", yours" : ""})</button>`;
  }
  el.innerHTML = `<div class="sheetin">
    <h3>${p.n}</h3><div class="sub">${p.p}${p.pr} · ${p.t} · Bye ${p.b ?? "?"} · ${p.ppg} ppg · VORP ${p.v > 0 ? "+" : ""}${p.v} · ADP ${p.adp ?? "—"}</div>
    ${btns}<button class="btn ghost" data-act="close">Cancel</button></div>`;
  el.classList.add("open");
  el.onclick = ev => {
    const act = ev.target.dataset?.act;
    if (ev.target === el || act === "close") { el.classList.remove("open"); return; }
    if (!act) return;
    if (act === "mine" || act === "other") { S.events.push({ id, mine: act === "mine" }); flash(act === "mine" ? `${p.n} → your team` : `${p.n} drafted`); }
    if (act === "unpick") { S.events = S.events.filter(e => e.id !== id); flash("Pick removed"); }
    save(); el.classList.remove("open"); render();
  };
}

// ---------- CBS paste parser ----------
function parseCbs(text) {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const myTeam = norm(S.teamName);
  let picks = [];
  const seen = new Set();
  const tryLine = (line, requireNum) => {
    if (requireNum && !/^\d{1,3}\s/.test(line)) return;
    const nl = norm(line);
    for (const { id, key } of nameIndex) {
      if (seen.has(id)) continue;
      if (nl.includes(key)) { picks.push({ id, mine: nl.includes(myTeam) }); seen.add(id); return; }
    }
  };
  lines.forEach(l => tryLine(l, true));
  if (picks.length === 0) { lines.forEach(l => tryLine(l, false)); }
  return picks;
}

// ---------- render ----------
function render() {
  renderHeader(); renderTabs();
  const main = document.getElementById("main");
  if (!S.onboarded) {
    main.innerHTML = viewOnboard();
    main.querySelectorAll("[data-obwho]").forEach(b => b.addEventListener("click", () => {
      S.who = b.dataset.obwho; S.onboarded = true; S.tab = "rank"; save(); render();
    }));
    const sk = main.querySelector("[data-obskip]");
    if (sk) sk.addEventListener("click", () => { S.onboarded = true; S.tab = "board"; save(); render(); });
    return;
  }
  main.innerHTML = S.tab === "rank" ? viewRanks() : S.tab === "board" ? viewBoard() : S.tab === "best" ? viewBest() : S.tab === "team" ? viewTeam() : S.tab === "sync" ? viewSync() : viewMore();

  main.querySelectorAll(".row[data-id]").forEach(r => r.addEventListener("click", () => openSheet(Number(r.dataset.id))));
  main.querySelectorAll(".chip[data-pos]").forEach(c => c.addEventListener("click", () => { S.posFilter = c.dataset.pos; save(); render(); }));
  main.querySelectorAll("[data-sort]").forEach(c => c.addEventListener("click", () => { S.sortMode = c.dataset.sort; save(); render(); }));
  main.querySelectorAll("[data-more]").forEach(c => c.addEventListener("click", () => { S.moreView = c.dataset.more; save(); render(); }));
  main.querySelectorAll("[data-who]").forEach(c => c.addEventListener("click", () => { S.who = c.dataset.who; save(); render(); }));

  const search = main.querySelector("#search");
  if (search) search.addEventListener("input", e => {
    S.search = e.target.value; save();
    // re-render list only (keep focus)
    const q = norm(S.search || "");
    let list = orderedPlayers();
    if (S.posFilter !== "ALL") list = list.filter(p => p.p === S.posFilter);
    if (q) list = list.filter(p => norm(p.n).includes(q));
    main.querySelectorAll(".row[data-id]").forEach(r => r.remove());
    search.closest("main") && main.insertAdjacentHTML("beforeend", list.map(p => rowHtml(p, "board")).join(""));
    main.querySelectorAll(".row[data-id]").forEach(r => r.addEventListener("click", () => openSheet(Number(r.dataset.id))));
  });

  const syncbtn = main.querySelector("#syncbtn");
  if (syncbtn) syncbtn.addEventListener("click", () => {
    const txt = main.querySelector("#synctext").value;
    if (!txt.trim()) { flash("Nothing pasted"); return; }
    const picks = parseCbs(txt);
    if (!picks.length) { flash("No picks recognized"); return; }
    if (picks.length >= S.events.length) S.events = picks;
    else { const have = new Set(S.events.map(e => e.id)); picks.forEach(p => { if (!have.has(p.id)) S.events.push(p); }); }
    save(); flash(`Synced ${picks.length} picks (${picks.filter(p => p.mine).length} yours)`); render();
  });
  const undobtn = main.querySelector("#undobtn");
  if (undobtn) undobtn.addEventListener("click", () => { S.events.pop(); save(); flash("Undid last pick"); render(); });
  const resetbtn = main.querySelector("#resetbtn");
  if (resetbtn) resetbtn.addEventListener("click", () => {
    if (resetbtn.dataset.armed) { S.events = []; save(); flash("Draft reset"); render(); }
    else { resetbtn.dataset.armed = "1"; resetbtn.textContent = "Tap again to confirm reset"; }
  });

  // ranking duel game
  main.querySelectorAll("[data-posstart]").forEach(b => b.addEventListener("click", () => { wizardStart(b.dataset.posstart); S.duelOpen = true; save(); render(); }));
  const wb = main.querySelector("[data-wback]");
  if (wb) wb.addEventListener("click", () => { S.duelOpen = false; save(); render(); });
  main.querySelectorAll("[data-duel]").forEach(c => c.addEventListener("click", () => {
    if (!S.wizard) return;
    wizardChoose(Number(c.dataset.duel) === S.wizard.cur);
    render();
  }));
  const wu = main.querySelector("[data-wundo]");
  if (wu) wu.addEventListener("click", () => {
    const w = S.wizard;
    if (w && w.hist.length) { Object.assign(w, w.hist.pop()); save(); render(); }
  });
  const wf = main.querySelector("[data-wfinish]");
  if (wf) wf.addEventListener("click", () => { wizardCommit(true); render(); });
  main.querySelectorAll("[data-mv]").forEach(b => b.addEventListener("click", () => {
    const [pos, iStr, dStr] = b.dataset.mv.split(":");
    const i = Number(iStr), d = Number(dStr), list = S.posRanks[S.who][pos];
    const j = i + d;
    if (j >= 0 && j < list.length) { [list[i], list[j]] = [list[j], list[i]]; save(); render(); }
  }));
  const sh = main.querySelector("#sharelink");
  if (sh) sh.addEventListener("click", async () => {
    const url = shareUrl(S.who);
    if (navigator.share) { try { await navigator.share({ title: `${S.who}'s Lodge ranks`, url }); return; } catch (e) {} }
    try { await navigator.clipboard.writeText(url); flash("Link copied — text it to the chat"); }
    catch (e) { main.querySelector("#ranktext").value = url; flash("Copy the link from the box below"); }
  });
  const im = main.querySelector("#importranks");
  if (im) im.addEventListener("click", () => {
    try {
      let txt = main.querySelector("#ranktext").value.trim();
      const m = txt.match(/#r=([A-Za-z0-9_\-]+)/);
      if (m) txt = decodeURIComponent(escape(atob(m[1].replace(/-/g, "+").replace(/_/g, "/"))));
      const who = importBlob(JSON.parse(txt));
      flash(`Imported ${who}'s ranks`); render();
    } catch (e) { flash("Couldn't read that — paste the full link or blob"); }
  });
  const slotin = main.querySelector("#slotin");
  if (slotin) slotin.addEventListener("change", e => { S.slot = Math.min(10, Math.max(1, Number(e.target.value) || 6)); save(); render(); });
  const teamin = main.querySelector("#teamin");
  if (teamin) teamin.addEventListener("change", e => { S.teamName = e.target.value || "Million Dollar Men"; save(); });
}

document.getElementById("tabs").addEventListener("click", e => {
  const b = e.target.closest("[data-tab]");
  if (b) { S.tab = b.dataset.tab; save(); render(); }
});

// auto-import ranks arriving via a shared link (#r=...)
(function () {
  const m = location.hash.match(/#r=([A-Za-z0-9_\-]+)/);
  if (!m) return;
  try {
    const who = importBlob(JSON.parse(decodeURIComponent(escape(atob(m[1].replace(/-/g, "+").replace(/_/g, "/"))))));
    history.replaceState(null, "", location.pathname);
    setTimeout(() => flash(`Imported ${who}'s ranks ✓`), 300);
  } catch (e) {}
})();

render();
