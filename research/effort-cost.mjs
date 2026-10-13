#!/usr/bin/env node
// Aggregate-only effort-vs-cost measurement over local Claude Code transcripts.
// Usage: node research/effort-cost.mjs [projectsDir] [--min-turns=N] [--json]
// Reads ~/.claude/projects/**/*.jsonl. Prints aggregates only: no prompt text,
// no file contents, no paths. Project names are anonymized (P1, P2, ...) by
// first-seen order and the mapping is never printed or stored.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const root = args.find((a) => !a.startsWith('--')) ?? path.join(os.homedir(), '.claude', 'projects');
const minTurns = Number((args.find((a) => a.startsWith('--min-turns=')) ?? '--min-turns=20').split('=')[1]);
const asJson = args.includes('--json');

// Quota approximation weights, relative to one fresh input token.
// Ratios follow the public API price ratios: output 5x, cache read 0.1x,
// cache write (5m) 1.25x. Quota is not published, so this is an assumption.
const W = { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 };

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

const isWorktree = (cwd) => /[\\/]\.claude[\\/]worktrees[\\/]|orca-workspaces|[\\/]worktrees[\\/]/i.test(cwd ?? '');
const projects = new Map();
const anon = (cwd) => {
  const key = (cwd ?? '').replace(/[\\/]\.claude[\\/]worktrees.*$/i, '').toLowerCase();
  if (!projects.has(key)) projects.set(key, `P${projects.size + 1}`);
  return projects.get(key);
};

function parseSession(file) {
  const msgs = new Map(); // dedupe by message.id: keep the last usage seen
  let cwd, first, prompts = 0, rebotes = 0, despachos = 0, agentCalls = 0, agentChars = 0;
  let briefChars = 0, briefs = 0, issueChars = 0, issues = 0;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    let j;
    try { j = JSON.parse(line); } catch { continue; }
    cwd ??= j.cwd;
    if (j.timestamp) first ??= j.timestamp;
    if (j.type === 'user' && !j.isSidechain && typeof j.message?.content === 'string') prompts++;
    if (j.type !== 'assistant' || !j.message?.usage) continue;
    const id = j.message.id ?? j.uuid;
    const u = j.message.usage;
    msgs.set(id, {
      effort: j.perTurnEffort ?? j.effort ?? 'unknown',
      model: j.message.model,
      input: u.input_tokens ?? 0,
      output: u.output_tokens ?? 0,
      cacheRead: u.cache_read_input_tokens ?? 0,
      cacheWrite: u.cache_creation_input_tokens ?? 0,
    });
    for (const c of Array.isArray(j.message.content) ? j.message.content : []) {
      if (c.type !== 'tool_use') continue;
      const inp = c.input ?? {};
      if (c.name === 'Agent' || c.name === 'Task') { agentCalls++; agentChars += String(inp.prompt ?? '').length; }
      if (c.name === 'Bash' && typeof inp.command === 'string') {
        const cmd = inp.command;
        if (/orca-stack\s+rebote/.test(cmd)) rebotes++;
        if (/orca-stack\s+despachar/.test(cmd)) { despachos++; briefChars += cmd.length; briefs++; }
        if (/gh\s+issue\s+(create|edit)/.test(cmd)) { issues++; issueChars += cmd.length; }
      }
    }
  }
  const turns = [...msgs.values()];
  if (!turns.length) return null;
  const t = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const eff = {};
  const models = {};
  for (const m of turns) {
    for (const k of Object.keys(t)) t[k] += m[k];
    eff[m.effort] = (eff[m.effort] ?? 0) + 1;
    models[m.model] = (models[m.model] ?? 0) + 1;
  }
  const [domEffort, domN] = Object.entries(eff).sort((a, b) => b[1] - a[1])[0];
  const pure = domN / turns.length >= 0.9;
  const domModel = Object.entries(models).sort((a, b) => b[1] - a[1])[0][0];
  const quota = t.input * W.input + t.output * W.output + t.cacheRead * W.cacheRead + t.cacheWrite * W.cacheWrite;
  return {
    project: anon(cwd), worktree: isWorktree(cwd), sidechain: file.includes('subagents'),
    day: (first ?? '').slice(0, 10), effort: pure ? domEffort : 'mixed', model: domModel,
    turns: turns.length, prompts, ...t, quota,
    orch: despachos + rebotes + agentCalls > 0, rebotes, despachos, briefChars, briefs, issues, issueChars, agentCalls, agentChars,
  };
}

const all = walk(root).filter((f) => !f.includes(`${path.sep}subagents${path.sep}`) && !f.includes('/subagents/'));
const sessions = all.map(parseSession).filter(Boolean);
const main = sessions.filter((s) => !s.worktree && s.turns >= minTurns);

const sum = (a, k) => a.reduce((x, s) => x + s[k], 0);
const median = (a) => { const b = [...a].sort((x, y) => x - y); return b.length ? b[Math.floor(b.length / 2)] : 0; };
const f0 = (x) => Math.round(x).toLocaleString('en-US');

function summarize(group) {
  const turns = sum(group, 'turns');
  return {
    sessions: group.length, projects: new Set(group.map((s) => s.project)).size, turns,
    medianTurns: median(group.map((s) => s.turns)),
    perTurn: {
      input: sum(group, 'input') / turns, output: sum(group, 'output') / turns,
      cacheRead: sum(group, 'cacheRead') / turns, cacheWrite: sum(group, 'cacheWrite') / turns,
      quota: sum(group, 'quota') / turns,
    },
    medianQuotaPerTurn: median(group.map((s) => s.quota / s.turns)),
    medianQuotaPerSession: median(group.map((s) => s.quota)),
    rebotesPerSession: sum(group, 'rebotes') / group.length,
    despachos: sum(group, 'despachos'),
    avgDespachoChars: sum(group, 'briefs') ? sum(group, 'briefChars') / sum(group, 'briefs') : null,
    avgIssueCmdChars: sum(group, 'issues') ? sum(group, 'issueChars') / sum(group, 'issues') : null,
    agentCallsPerSession: sum(group, 'agentCalls') / group.length,
    avgAgentPromptChars: sum(group, 'agentCalls') ? sum(group, 'agentChars') / sum(group, 'agentCalls') : null,
  };
}

const byKey = (arr, fn) => arr.reduce((m, s) => ((m[fn(s)] ??= []).push(s), m), {});
// Orchestrator proxy: the session used Agent, `orca-stack despachar` or `orca-stack rebote`.
const orch = main.filter((s) => s.orch);
const both = [...new Set(main.map((s) => s.project))].filter((p) => ['high', 'xhigh'].every((e) => main.some((s) => s.project === p && s.effort === e)));
const paired = main.filter((s) => both.includes(s.project));
const days = (g) => { const d = g.map((s) => s.day).sort(); return d.length ? [d[0], d.at(-1)] : null; };
const report = {
  dateRangeByEffort: Object.fromEntries(Object.entries(byKey(main, (s) => s.effort)).map(([k, v]) => [k, days(v)])),
  byEffortOrchestratorsOnly: Object.fromEntries(Object.entries(byKey(orch, (s) => s.effort)).map(([k, v]) => [k, summarize(v)])),
  byEffortSameProjectsOnly: Object.fromEntries(Object.entries(byKey(paired, (s) => s.effort)).map(([k, v]) => [k, summarize(v)])),
  totals: { transcripts: all.length, withUsage: sessions.length, nonWorktreeLongEnough: main.length, minTurns },
  weights: W,
  effortByTurnAcrossAllTopLevel: Object.fromEntries(Object.entries(byKey(sessions, (s) => s.effort)).map(([k, v]) => [k, v.length])),
  byEffort: Object.fromEntries(Object.entries(byKey(main, (s) => s.effort)).map(([k, v]) => [k, summarize(v)])),
  byEffortAndModel: Object.fromEntries(Object.entries(byKey(main, (s) => `${s.effort} | ${s.model}`)).map(([k, v]) => [k, summarize(v)])),
  byEffortAndLength: Object.fromEntries(Object.entries(byKey(main, (s) => `${s.effort} | ${s.turns < 100 ? '<100' : s.turns < 300 ? '100-299' : '>=300'} turns`)).map(([k, v]) => [k, summarize(v)])),
  byProject: Object.fromEntries(Object.entries(byKey(main, (s) => s.project)).map(([p, v]) => [p, Object.fromEntries(Object.entries(byKey(v, (s) => s.effort)).map(([k, g]) => [k, g.length]))])),
};

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`Transcripts: ${report.totals.transcripts}; with usage: ${report.totals.withUsage}; non-worktree, >=${minTurns} turns: ${report.totals.nonWorktreeLongEnough}`);
  console.log(`Quota weights: ${JSON.stringify(W)}\n`);
  const row = (name, s) => `| ${name} | ${s.sessions} | ${s.projects} | ${s.turns} | ${s.medianTurns} | ${f0(s.perTurn.input)} | ${f0(s.perTurn.output)} | ${f0(s.perTurn.cacheRead)} | ${f0(s.perTurn.cacheWrite)} | ${f0(s.perTurn.quota)} | ${f0(s.medianQuotaPerTurn)} | ${f0(s.medianQuotaPerSession)} | ${s.rebotesPerSession.toFixed(2)} | ${s.agentCallsPerSession.toFixed(1)} | ${s.avgAgentPromptChars === null ? '-' : f0(s.avgAgentPromptChars)} | ${s.avgDespachoChars === null ? '-' : f0(s.avgDespachoChars)} |`;
  const head = '| Group | Sessions | Projects | Turns | Median turns | In/turn | Out/turn | CacheR/turn | CacheW/turn | Quota/turn (pooled) | Quota/turn (median) | Quota/session (median) | Rebotes/session | Agent calls/session | Avg Agent prompt chars | Avg despachar cmd chars |\n|' + '---|'.repeat(16);
  for (const [title, g] of [['By effort', report.byEffort], ['By effort, orchestrators only (Agent/despachar/rebote used)', report.byEffortOrchestratorsOnly], ['By effort, projects that have both high and xhigh', report.byEffortSameProjectsOnly], ['By effort and model', report.byEffortAndModel], ['By effort and session length', report.byEffortAndLength]]) {
    console.log(`### ${title}\n${head}`);
    for (const [k, v] of Object.entries(g).sort()) console.log(row(k, v));
    console.log();
  }
  console.log(`Start-day range by effort: ${JSON.stringify(report.dateRangeByEffort)}\n`);
  console.log('### Sessions per project and effort (anonymized)');
  for (const [p, v] of Object.entries(report.byProject)) console.log(`${p}: ${JSON.stringify(v)}`);
}
