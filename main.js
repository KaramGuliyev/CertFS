/* CertFS Quiz — a small, no-build Obsidian plugin.
 * AI quizzes on a note, a selection or a folder through OpenRouter.
 * Subjects (folder + question style) are set in Settings. Wrong answers become
 * error notes that come back as fresh variants until mastered.
 */
'use strict';

const obsidian = require('obsidian');
const { Plugin, PluginSettingTab, Setting, Modal, Notice, requestUrl, FuzzySuggestModal, TFolder, TFile } = obsidian;

const API = 'https://openrouter.ai/api/v1';
const MAX_SOURCE_CHARS = 24000;
const HISTORY_MAX = 5000; // answers kept in history.json
const ERROR_TYPES = ['mc', 'scenario', 'multi', 'tf']; // objective types: no extra grading request

const DEFAULTS = {
  apiKey: '',
  model: '',
  count: 5,
  difficulty: 'medium',
  hints: true,
  logMistakes: true,
  masteryMode: 'days', // 'days' = each correct must be on a due day · 'any' = any time
  mastery: 3, // correct answers in a row to retire an error
  intervals: [3, 7], // days to the next check after correct #1, #2, ... (last value repeats)
  errorsFolder: 'Errors', // inside each subject folder
  archiveFolder: 'Archive', // inside the errors folder
  skipFolders: 'Mocks', // folder quiz also skips these (plus the errors folder)
  keepHistory: true,
  statsFile: 'Stats', // <subject folder>/Stats.md, rewritten after each quiz ('' = off)
  // subjects: [{ name, folder, rules, style }] — undefined until first run (then presets are offered)
  types: { mc: true, scenario: true, multi: true, tf: true, short: true, matching: true },
};

const TYPE_LABEL = {
  mc: 'Multiple choice',
  scenario: 'Scenario (exam style)',
  multi: 'Select all that apply',
  tf: 'True / false',
  short: 'Short answer',
  matching: 'Matching',
};

const GENERIC_STYLE = 'General study quiz. Use the exact terms of the source.';

/** Ready-made subjects. Offered on first run when their folder exists, or via Settings → Add presets. */
const PRESET_SUBJECTS = [
  { name: 'CSM', folder: '1 CSM', rules: 'Scrum Rules', style: 'Exam: Scrum Alliance CSM. Use Scrum Guide 2020 wording exactly (accountable, Increment, Definition of Done, Sprint Goal, Product Goal). Scenario questions describe a Scrum Team situation and ask what should happen or who is accountable. Typical traps: SM or PO running the Daily Scrum, extending a Sprint, showing undone work, managers cancelling a Sprint.' },
  { name: 'PMP', folder: '2 PMP', rules: 'Mindset Rules', style: 'Exam: PMI PMP. Scenario questions are situational: "What should the project manager do FIRST / NEXT?". Apply the PMI mindset: servant leadership, analyze before acting, follow the agreed process (change control in predictive, Product Owner + backlog in agile), involve the team and stakeholders, escalate only after trying. Mix predictive, agile and hybrid contexts. Explanations say why the best option beats the tempting second-best.' },
  { name: 'CPMAI', folder: '3 CPMAI', rules: 'CPMAI Rules', style: 'Exam: PMI-CPMAI. Use the CPMAI phase names and terms exactly as in the note. Scenario questions describe an AI project situation.' },
];

/* ---------- pure helpers (unit-tested) ---------- */

function normFolder(f) {
  return String(f || '').trim().replace(/^\/+|\/+$/g, '');
}

/** The subject whose folder holds `path` (deepest match wins), or null. */
function detectSubject(path, subjects) {
  const p = String(path || '');
  let best = null;
  for (const sub of subjects || []) {
    const f = normFolder(sub && sub.folder);
    if (!f || !(p === f || p.startsWith(`${f}/`))) continue;
    if (!best || f.length > normFolder(best.folder).length) best = sub;
  }
  return best;
}

/** Subject for a group of notes: the one most of them belong to (ties → first seen). null if none has one. */
function commonSubject(paths, subjects) {
  const counts = new Map();
  for (const p of paths || []) {
    const sub = detectSubject(p, subjects);
    if (sub) counts.set(sub, (counts.get(sub) || 0) + 1);
  }
  let best = null;
  for (const [sub, n] of counts) if (!best || n > counts.get(best)) best = sub;
  return best;
}

/** The subject's own style, or (empty) one built from its name + folder so the AI can infer the exam. */
function subjectStyle(sub) {
  if (!sub) return GENERIC_STYLE;
  if (sub.style && String(sub.style).trim()) return String(sub.style).trim();
  const name = String(sub.name || '').trim();
  const folder = normFolder(sub.folder);
  return [
    `Subject: "${name}"${folder ? ` (the student's notes are in the folder "${folder}")` : ''}.`,
    'Use the subject name and folder name to infer the course or exam (for example a certification such as CSM or PMP, or a school subject).',
    'If it is a known exam or certification, write questions in that exam\'s official style: its exact terms, question format and typical traps.',
    'If not, write a clear general study quiz. Use the exact terms of the source.',
  ].join(' ');
}

function subjectName(sub) {
  return sub && sub.name ? String(sub.name) : 'General';
}

function errorsDir(sub, settings) {
  return `${normFolder(sub.folder)}/${normFolder(settings.errorsFolder) || 'Errors'}`;
}

function archiveDir(sub, settings) {
  return `${errorsDir(sub, settings)}/${normFolder(settings.archiveFolder) || 'Archive'}`;
}

/** Days to wait after the n-th correct answer (1-based); the last interval repeats. */
function intervalFor(n, intervals) {
  const list = (Array.isArray(intervals) ? intervals : []).map(Number).filter((x) => Number.isFinite(x) && x > 0);
  if (!list.length) return 1;
  return list[Math.min(n, list.length) - 1];
}

function parseIntervals(text) {
  return String(text || '').split(/[\s,]+/).map(Number).filter((x) => Number.isInteger(x) && x > 0);
}

/** Folder quiz: skip errors/archive + the extra names from settings. */
function skipRegex(settings) {
  const names = [settings.errorsFolder, settings.archiveFolder, ...String(settings.skipFolders || '').split(',')]
    .map(normFolder).filter(Boolean).map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return names.length ? new RegExp(`(^|/)(${names.join('|')})/`) : null;
}

function enabledTypes(types) {
  return Object.keys(TYPE_LABEL).filter((t) => types && types[t]);
}

/** Spread `count` questions over the enabled types, scenario/mc first. */
function distribute(count, types) {
  const list = enabledTypes(types);
  if (!list.length) return { mc: count };
  const plan = {};
  for (let i = 0; i < count; i++) {
    const t = list[i % list.length];
    plan[t] = (plan[t] || 0) + 1;
  }
  return plan;
}

function stripFrontmatter(text) {
  return String(text || '').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
}

function buildMessages(o) {
  const plan = Object.entries(o.plan).map(([t, n]) => `${n} × ${t} (${TYPE_LABEL[t]})`).join(', ');
  const system = [
    'You write exam-prep quiz questions from the student\'s own study note.',
    o.style || GENERIC_STYLE,
    'Every correct answer MUST be supported by the SOURCE text. Never use facts that are not in it.',
    'Test understanding and application, not copying sentences. Wrong options must be plausible (common traps).',
    'Reply with ONE JSON object only, no markdown, matching this shape:',
    '{"questions":[{"type":"mc|scenario|multi|tf|short|matching","topic":"2-5 word concept","question":"...",' +
      '"options":["..."],"answer":<see rules>,"pairs":[{"left":"...","right":"..."}],"hint":"...","explanation":"..."}]}',
    'Rules per type:',
    '- mc / scenario: 4 options, "answer" = index (0-based) of the single correct option. scenario = a short realistic situation first.',
    '- multi: 4-6 options, "answer" = array of ALL correct indexes (at least 2).',
    '- tf: no options, "answer" = true or false.',
    '- short: no options, "answer" = a 1-2 sentence model answer.',
    '- matching: 3-5 "pairs" (left term -> right meaning), unique rights, no options/answer.',
    '"explanation": why the correct answer is right AND why the most tempting wrong option is wrong. 1-3 short sentences.',
    o.hints ? '"hint": one short nudge that does not give the answer away.' : '"hint": "".',
    'Use simple English, max ~25 words per question stem unless it is a scenario.',
    o.multi ? 'The SOURCE holds several notes; each starts with a "### " title line. Spread the questions across the notes.' : '',
  ].filter(Boolean).join('\n');
  const user = [
    `Write exactly: ${plan}. Difficulty: ${o.difficulty}.`,
    o.focus ? `Focus on: ${o.focus}.` : '',
    o.avoid && o.avoid.length ? `Do NOT repeat these questions:\n- ${o.avoid.join('\n- ')}` : '',
    `SOURCE (${o.title}):\n"""\n${o.text}\n"""`,
  ].filter(Boolean).join('\n\n');
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

/** Pull the first JSON object out of a model reply (handles ```json fences and chatter). */
function parseJson(text) {
  const raw = String(text || '').replace(/```(?:json)?/gi, '').trim();
  try { return JSON.parse(raw); } catch (_) { /* fall through */ }
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(raw.slice(start, end + 1)); } catch (_) { /* fall through */ }
  }
  throw new Error('The model did not return valid JSON. Try again or pick another free model.');
}

function str(v) { return typeof v === 'string' ? v.trim() : ''; }

function toIndexes(v) {
  const arr = Array.isArray(v) ? v : [v];
  return arr.map((x) => Number(x)).filter((x) => Number.isInteger(x));
}

function shuffle(arr, rnd = Math.random) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Validate + normalize questions; drop anything broken. Options are shuffled. */
function normalizeQuestions(data, rnd = Math.random) {
  const list = data && Array.isArray(data.questions) ? data.questions : [];
  const out = [];
  for (const q of list) {
    if (!q || typeof q !== 'object') continue;
    const type = str(q.type).toLowerCase();
    const base = {
      type,
      ref: q.ref === undefined || q.ref === null ? '' : String(q.ref).trim(),
      topic: str(q.topic) || 'General',
      question: str(q.question),
      hint: str(q.hint),
      explanation: str(q.explanation),
    };
    if (!base.question || !TYPE_LABEL[type]) continue;
    if (type === 'mc' || type === 'scenario' || type === 'multi') {
      const options = Array.isArray(q.options) ? q.options.map(str).filter(Boolean) : [];
      const correct = [...new Set(toIndexes(q.answer))].filter((i) => i >= 0 && i < options.length);
      if (options.length < 2 || !correct.length) continue;
      if (type !== 'multi' && correct.length !== 1) continue;
      const order = shuffle(options.map((_, i) => i), rnd);
      out.push({ ...base, options: order.map((i) => options[i]), answer: correct.map((c) => order.indexOf(c)).sort((a, b) => a - b) });
    } else if (type === 'tf') {
      let a = q.answer;
      if (typeof a === 'string') a = a.trim().toLowerCase() === 'true' ? true : a.trim().toLowerCase() === 'false' ? false : null;
      if (typeof a !== 'boolean') continue;
      out.push({ ...base, answer: a });
    } else if (type === 'short') {
      const a = str(q.answer);
      if (!a) continue;
      out.push({ ...base, answer: a });
    } else if (type === 'matching') {
      const pairs = Array.isArray(q.pairs) ? q.pairs.map((p) => ({ left: str(p && p.left), right: str(p && p.right) })).filter((p) => p.left && p.right) : [];
      if (pairs.length < 2 || new Set(pairs.map((p) => p.right)).size !== pairs.length) continue;
      out.push({ ...base, pairs, rights: shuffle(pairs.map((p) => p.right), rnd) });
    }
  }
  return out;
}

/** Objective grading. `given`: index | index[] | boolean | {left: right}. */
function grade(q, given) {
  if (q.type === 'mc' || q.type === 'scenario') return toIndexes(given).length === 1 && toIndexes(given)[0] === q.answer[0];
  if (q.type === 'multi') {
    const g = [...new Set(toIndexes(given))].sort((a, b) => a - b);
    return g.length === q.answer.length && g.every((v, i) => v === q.answer[i]);
  }
  if (q.type === 'tf') return given === q.answer;
  if (q.type === 'matching') return !!given && q.pairs.every((p) => given[p.left] === p.right);
  return false;
}

function correctText(q) {
  if (q.type === 'tf') return q.answer ? 'True' : 'False';
  if (q.type === 'short') return q.answer;
  if (q.type === 'matching') return q.pairs.map((p) => `${p.left} → ${p.right}`).join('; ');
  return q.answer.map((i) => q.options[i]).join('; ');
}

function givenText(q, given) {
  if (given === undefined || given === null) return 'Not sure';
  if (q.type === 'tf') return given ? 'True' : 'False';
  if (q.type === 'short') return String(given);
  if (q.type === 'matching') return q.pairs.map((p) => `${p.left} → ${given[p.left] || '?'}`).join('; ');
  return toIndexes(given).map((i) => q.options[i]).join('; ') || 'Not sure';
}

function ymd(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function addDays(d, n) {
  const x = new Date(d.getTime());
  x.setDate(x.getDate() + n);
  return x;
}

function safeName(s) {
  return String(s).replace(/[\\/:*?"<>|#^[\]]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60) || 'quiz mistake';
}

function errorNote(o) {
  const today = ymd(o.now);
  return [
    '---',
    'type: error',
    `exam: ${o.exam}`,
    `date: ${today}`,
    `source: ${JSON.stringify(`CertFS Quiz (${o.source})`)}`,
    'domain: ',
    'approach: ',
    'category: knowledge-gap',
    `topic: ${JSON.stringify(String(o.q.topic))}`,
    'status: new',
    'streak: 0',
    `next_review: ${ymd(addDays(o.now, 1))}`,
    '---',
    `# ${o.q.topic}`,
    '',
    `**Question (my words):** ${o.q.question}`,
    `**I picked:** ${o.given}`,
    `**Correct:** ${correctText(o.q)}`,
    `**Why:** ${o.q.explanation || o.feedback || ''}`,
    ...(o.rules ? [`**Rule:** → [[${o.rules}]]`] : []),
    '**Review log:**',
    `- ${today} wrong in CertFS Quiz`,
    '',
  ].join('\n');
}

// Same note, same day, same topic: keep every distinct question with its full answer.
function appendMistake(text, o) {
  const today = ymd(o.now);
  const base = text.trimEnd();
  if (base.includes(`**Question (my words):** ${o.q.question}`)) {
    return `${base}\n- ${today} wrong again in CertFS Quiz\n`;
  }
  return [
    base,
    '',
    `## Another miss (${today})`,
    `**Question (my words):** ${o.q.question}`,
    `**I picked:** ${o.given}`,
    `**Correct:** ${correctText(o.q)}`,
    `**Why:** ${o.q.explanation || o.feedback || ''}`,
    `- ${today} wrong in CertFS Quiz`,
    '',
  ].join('\n');
}

/* ---------- error re-quiz + archive (pure) ---------- */

/** Read the parts of an error note we need to write a fresh variant. */
function parseErrorNote(text) {
  const body = stripFrontmatter(text);
  const first = (label) => {
    const m = body.match(new RegExp(`\\*\\*${label}:\\*\\*[ \\t]*(.*)`));
    return m ? m[1].trim() : '';
  };
  const asked = [];
  for (const m of body.matchAll(/\*\*Question \(my words\):\*\*[ \t]*(.+)/g)) asked.push(m[1].trim());
  for (const m of body.matchAll(/^- \d{4}-\d{2}-\d{2} [^\n]*?(?:variant|archive test)[^\n]*? · Q: (.+)$/gm)) asked.push(m[1].trim());
  return {
    question: first('Question \\(my words\\)'),
    correct: first('Correct'),
    why: first('Why'),
    asked: [...new Set(asked.filter(Boolean))],
  };
}

function buildErrorMessages(o) {
  const system = [
    'You write fresh practice questions from a student\'s past exam-prep MISTAKES.',
    o.style || GENERIC_STYLE,
    'For EACH mistake write exactly ONE new question that tests the SAME concept and the SAME correct idea.',
    'Change the wording, the situation and, if useful, the question type, so it cannot be answered from memory.',
    'Never reuse wording from "Already asked". The correct answer must agree with "Correct" and "Why".',
    'Reply with ONE JSON object only, no markdown, matching this shape:',
    '{"questions":[{"ref":"<the mistake ref>","type":"mc|scenario|multi|tf","topic":"2-5 word concept","question":"...","options":["..."],"answer":<see rules>,"hint":"...","explanation":"..."}]}',
    '- mc / scenario: 4 options, "answer" = index (0-based) of the single correct option. scenario = a short realistic situation first.',
    '- multi: 4-6 options, "answer" = array of ALL correct indexes (at least 2).',
    '- tf: no options, "answer" = true or false.',
    '"explanation": why the correct answer is right AND why the most tempting wrong option is wrong. 1-3 short sentences.',
    o.hints ? '"hint": one short nudge that does not give the answer away.' : '"hint": "".',
    'Use simple English.',
  ].join('\n');
  const user = o.errors.map((e) => [
    `[ref ${e.ref}] Topic: ${e.topic}`,
    `Original question: ${e.question}`,
    `Correct: ${e.correct}`,
    e.why ? `Why: ${e.why}` : '',
    e.asked && e.asked.length ? `Already asked:\n- ${e.asked.join('\n- ')}` : '',
  ].filter(Boolean).join('\n')).join('\n\n');
  return [
    { role: 'system', content: system },
    { role: 'user', content: `Write ${o.errors.length} question(s), one per ref.\n\n${user}` },
  ];
}

/** Keep one objective question per known ref. */
function matchErrorQuestions(questions, refs) {
  const seen = new Set();
  return questions.filter((q) => {
    if (!refs.includes(q.ref) || seen.has(q.ref) || !ERROR_TYPES.includes(q.type)) return false;
    seen.add(q.ref);
    return true;
  });
}

function isDue(fm, now) {
  const next = fm && fm.next_review ? String(fm.next_review).slice(0, 10) : '';
  return !next || next <= ymd(now);
}

/**
 * New review state of an active error after one variant.
 * Wrong → streak 0, new, +1 day. Correct → streak +1 (in "days" mode only when it was due),
 * next check +3 then +7 days; the 3rd correct retires it to the archive.
 */
function nextErrorState(fm, ok, now, mode, action, cfg) {
  const MASTERY = Math.max(1, Number(cfg && cfg.mastery) || 3);
  const intervals = (cfg && cfg.intervals) || [3, 7];
  const streak = Number(fm && fm.streak) || 0;
  if (!ok) return { streak: 0, status: 'new', next_review: ymd(addDays(now, 1)), counted: false, archive: false };
  if (action === 'skip') return { streak: MASTERY, status: 'mastered', next_review: '', counted: true, archive: true, skipped: true };
  if (mode !== 'any' && action !== 'force' && !isDue(fm, now)) {
    return { streak, status: (fm && fm.status) || 'new', next_review: String(fm.next_review).slice(0, 10), counted: false, archive: false };
  }
  const s = streak + 1;
  if (s >= MASTERY) return { streak: MASTERY, status: 'mastered', next_review: '', counted: true, archive: true };
  return { streak: s, status: 'reviewed', next_review: mode === 'any' ? ymd(now) : ymd(addDays(now, intervalFor(s, intervals))), counted: true, archive: false };
}

function logLine(now, text) {
  return `- ${ymd(now)} ${text}`;
}

function appendLog(text, line) {
  return `${String(text).trimEnd()}\n${line}\n`;
}

/** Fit many notes into one source; each note gets a fair share of the space. */
function packNotes(notes, max) {
  if (!notes.length) return '';
  const per = Math.max(400, Math.floor(max / notes.length));
  return notes.map((n) => `### ${n.title}\n${String(n.text).trim().slice(0, per - n.title.length - 6)}`).join('\n\n').slice(0, max);
}

/* ---------- answer history (pure) ---------- */

function addHistory(list, entries, max = HISTORY_MAX) {
  const out = (Array.isArray(list) ? list : []).concat(entries);
  return out.length > max ? out.slice(out.length - max) : out;
}

/** Recent questions from the same source, so a new quiz does not repeat them. */
function recentQuestions(list, src, n = 40) {
  return (list || []).filter((h) => h.src === src).slice(-n).map((h) => h.q);
}

/** Per-subject totals, last-7-days count and weakest topics. */
function historyStats(list, now) {
  const weekAgo = ymd(addDays(now, -6));
  const by = {};
  for (const h of list || []) {
    const s = by[h.s] || (by[h.s] = { subject: h.s, total: 0, right: 0, week: 0, topics: {} });
    s.total++; if (h.ok) s.right++;
    if (h.d >= weekAgo) s.week++;
    const t = s.topics[h.t] || (s.topics[h.t] = { topic: h.t, total: 0, right: 0 });
    t.total++; if (h.ok) t.right++;
  }
  return Object.values(by).map((s) => ({
    subject: s.subject, total: s.total, right: s.right, week: s.week,
    pct: s.total ? Math.round((s.right / s.total) * 100) : 0,
    weakest: Object.values(s.topics).filter((t) => t.total >= 2 && t.right < t.total)
      .map((t) => ({ ...t, pct: Math.round((t.right / t.total) * 100) }))
      .sort((a, b) => a.pct - b.pct || b.total - a.total).slice(0, 5),
  })).sort((a, b) => b.total - a.total);
}

/** Markdown for <subject folder>/Stats.md, built from the history of one subject. */
function statsNote(list, name, now, errors, paused) {
  const mine = (list || []).filter((h) => h.s === name);
  const st = historyStats(mine, now)[0] || { total: 0, right: 0, week: 0, pct: 0, weakest: [] };
  const pct = (r, t) => (t ? `${Math.round((r / t) * 100)}%` : '—');
  const lines = [
    `# 📊 ${name} stats`,
    '',
    ...(paused ? ['> [!warning] ⏸️ Stats are paused', '> **Keep answer history** is off (Settings → CertFS Quiz), so new answers are not counted.', '> Turn it back on and the numbers update again after the next quiz.', ''] : []),
    `- 🕒 Updated: **${ymd(now)}** (after each CertFS Quiz).`,
    `- 🎯 All answers: **${st.right} / ${st.total}** right (${pct(st.right, st.total)}).`,
    `- 📅 Last 7 days: **${st.week}** answers.`,
  ];
  if (errors) lines.push(`- ❌ Errors: **${errors.due}** due today · **${errors.active}** active · **${errors.archived}** archived.`);
  lines.push('', '## 📅 Last 7 days', '', '| Day | Answers | Right |', '|---|---|---|');
  for (let i = 6; i >= 0; i--) {
    const d = ymd(addDays(now, -i));
    const day = mine.filter((h) => h.d === d);
    const r = day.filter((h) => h.ok).length;
    lines.push(`| ${d} | ${day.length} | ${day.length ? `${r} (${pct(r, day.length)})` : '—'} |`);
  }
  lines.push('', '## 🧩 Weakest topics', '');
  if (st.weakest.length) {
    lines.push('| Topic | Right | % |', '|---|---|---|');
    for (const t of st.weakest) lines.push(`| ${String(t.topic).replace(/\|/g, '/')} | ${t.right} / ${t.total} | ${t.pct}% |`);
  } else lines.push('- ✅ None yet (a topic needs 2+ answers).');
  const kinds = { note: '📖 Note / folder quiz', errors: '🔁 Quiz my errors', archive: '📦 Archive test' };
  lines.push('', '## 🧪 By quiz type', '', '| Type | Right | % |', '|---|---|---|');
  for (const [k, label] of Object.entries(kinds)) {
    const xs = mine.filter((h) => (h.m || 'note') === k);
    if (xs.length) { const r = xs.filter((h) => h.ok).length; lines.push(`| ${label} | ${r} / ${xs.length} | ${pct(r, xs.length)} |`); }
  }
  lines.push('', '---', 'ℹ️ Written by CertFS Quiz from its answer history. It needs **Keep answer history** on. Don\'t edit by hand: it is rewritten after each quiz.');
  return `${lines.join('\n')}\n`;
}

/* ---------- OpenRouter ---------- */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const REQUEST_TIMEOUT_MS = 90000;

/** requestUrl has no timeout: a stuck free model would hang the quiz forever. */
function withTimeout(promise, ms) {
  let t;
  const timer = new Promise((_, reject) => { t = setTimeout(() => reject(Object.assign(new Error('timeout'), { timeout: true })), ms); });
  return Promise.race([promise, timer]).finally(() => clearTimeout(t));
}

// OpenRouter puts the real reason in error.message and, for upstream errors, error.metadata.raw.
function errorDetail(json) {
  const e = json && json.error;
  if (!e) return '';
  if (typeof e !== 'object') return String(e);
  const parts = [e.message, e.metadata && e.metadata.provider_name, e.metadata && e.metadata.raw]
    .filter((x) => x && typeof x === 'string');
  return [...new Set(parts)].join(' | ').slice(0, 300);
}

// Only models that take text and answer with text can write a quiz.
function chatFreeModels(data) {
  return (data || [])
    .filter((m) => m && /:free$/.test(m.id))
    .filter((m) => {
      const a = m.architecture || {};
      const out = a.output_modalities || [];
      const inp = a.input_modalities || [];
      if (out.length && !out.includes('text')) return false;
      if (inp.length && !inp.includes('text')) return false;
      return !/embed|rerank|tts|transcri|safety|guard/i.test(m.id);
    })
    .map((m) => m.id)
    .sort();
}

async function chat(settings, messages, maxTokens) {
  if (!settings.apiKey) throw new Error('Add your OpenRouter API key in Settings → CertFS Quiz.');
  if (!settings.model) throw new Error('Pick a model in Settings → CertFS Quiz (use "Load free models").');
  let useFormat = true;
  for (let attempt = 0; attempt < 3; attempt++) {
    const body = { model: settings.model, messages, temperature: 0.4, max_tokens: maxTokens };
    if (useFormat) body.response_format = { type: 'json_object' };
    let res;
    try {
      res = await withTimeout(requestUrl({
        url: `${API}/chat/completions`,
        method: 'POST',
        contentType: 'application/json',
        headers: { Authorization: `Bearer ${settings.apiKey}`, 'X-Title': 'CertFS Quiz' },
        body: JSON.stringify(body),
        throw: false,
      }), settings.timeoutMs || REQUEST_TIMEOUT_MS);
    } catch (e) {
      if (e && e.timeout) throw new Error(`${settings.model} did not answer in ${Math.round((settings.timeoutMs || REQUEST_TIMEOUT_MS) / 1000)} s. Free models are sometimes stuck: try again, or pick another ":free" model.`);
      throw new Error('Could not reach OpenRouter. Check your internet connection.');
    }
    let json = null;
    try { json = res.json; } catch (_) { /* not JSON */ }
    const errMsg = errorDetail(json);
    if (res.status === 400 && useFormat) { useFormat = false; continue; } // some free models reject response_format
    if ([429, 502, 503].includes(res.status) && attempt < 2) { await sleep(4000 * (attempt + 1)); continue; }
    if (res.status === 401) throw new Error('OpenRouter rejected the API key (401). Check it in settings.');
    if (res.status === 402) throw new Error(`OpenRouter needs credits (402)${errMsg ? ': ' + errMsg : ''}. Pick a ":free" model, and leave the key's credit limit empty (not $0).`);
    if (res.status === 429) throw new Error(`Rate limit (429) on ${settings.model}${errMsg ? ': ' + errMsg : ''}. Free models are often busy upstream: try another ":free" model, or wait a minute. Your own free limit is 20/min, 50/day.`);
    if (res.status === 404) throw new Error(`Model not found (404): ${settings.model}. Use "Load free models" in settings.`);
    if (res.status < 200 || res.status >= 300 || errMsg) throw new Error(`OpenRouter error ${res.status}${errMsg ? ': ' + errMsg : ''}`);
    const choice = json && json.choices && json.choices[0];
    const content = choice && choice.message && choice.message.content;
    if (!content) throw new Error('The model returned an empty answer. Try again or pick another free model.');
    if (choice.finish_reason === 'length') throw new Error('The answer was cut off. Ask for fewer questions.');
    return content;
  }
  throw new Error('OpenRouter is busy right now. Try again in a minute.');
}

async function gradeShort(settings, q, answer) {
  const messages = [
    { role: 'system', content: 'You grade a student\'s short answer for exam prep. Judge the CONCEPT, not the wording. Reply with JSON only: {"correct":true|false,"feedback":"1-2 short sentences: what was right or missing"}' },
    { role: 'user', content: `Question: ${q.question}\nModel answer: ${q.answer}\nStudent answer: ${answer}` },
  ];
  const data = parseJson(await chat(settings, messages, 400));
  return { correct: data.correct === true || data.correct === 'true', feedback: str(data.feedback) };
}

/* ---------- UI ---------- */

class SetupModal extends Modal {
  constructor(plugin, source) {
    super(plugin.app);
    this.plugin = plugin;
    this.source = source;
    const s = plugin.settings;
    this.opts = { count: s.count, difficulty: s.difficulty, focus: '', types: { ...s.types } };
  }

  onOpen() {
    const { contentEl } = this;
    this.titleEl.setText(`Quiz: ${this.source.title}`);
    contentEl.createEl('p', { cls: 'certfs-quiz-muted', text: `Subject: ${this.source.exam}${this.source.subject ? '' : ' (no subject folder: general style, mistakes not saved)'} · ${this.source.text.length.toLocaleString()} characters sent to OpenRouter (${this.plugin.settings.model || 'no model yet'}).` });
    new Setting(contentEl).setName('Questions').addSlider((sl) => sl.setLimits(1, 15, 1).setValue(this.opts.count).setDynamicTooltip().onChange((v) => { this.opts.count = v; }));
    new Setting(contentEl).setName('Difficulty').addDropdown((d) => d.addOptions({ easy: 'Easy', medium: 'Medium', hard: 'Hard (exam-level)' }).setValue(this.opts.difficulty).onChange((v) => { this.opts.difficulty = v; }));
    new Setting(contentEl).setName('Focus (optional)').addText((t) => t.setPlaceholder('e.g. Sprint Review, change control').onChange((v) => { this.opts.focus = v.trim(); }));
    for (const t of Object.keys(TYPE_LABEL)) {
      new Setting(contentEl).setName(TYPE_LABEL[t]).addToggle((tg) => tg.setValue(!!this.opts.types[t]).onChange((v) => { this.opts.types[t] = v; }));
    }
    const status = contentEl.createEl('p', { cls: 'certfs-quiz-muted' });
    new Setting(contentEl).addButton((b) => b.setButtonText('Generate quiz').setCta().onClick(async () => {
      b.setDisabled(true);
      status.setText('Generating… (free models can take 10–40 s)');
      try {
        const questions = await this.plugin.generate(this.source, this.opts);
        this.close();
        new QuizModal(this.plugin, this.source, questions, this.opts).open();
      } catch (e) {
        status.setText(`❌ ${e.message}`);
        b.setDisabled(false);
      }
    }));
  }

  onClose() { this.contentEl.empty(); }
}

class QuizModal extends Modal {
  constructor(plugin, source, questions, opts) {
    super(plugin.app);
    this.plugin = plugin;
    this.source = source;
    this.questions = questions;
    this.opts = opts;
    this.i = 0;
    this.results = [];
  }

  onOpen() { this.modalEl.addClass('certfs-quiz'); this.render(); }
  onClose() { this.contentEl.empty(); }

  render() {
    const { contentEl } = this;
    contentEl.empty();
    if (this.i >= this.questions.length) return this.renderSummary();
    const q = this.questions[this.i];
    this.titleEl.setText(`${this.source.exam} quiz · ${this.i + 1} / ${this.questions.length}`);
    contentEl.createEl('div', { cls: 'certfs-quiz-tag', text: `${TYPE_LABEL[q.type]} · ${q.topic}` });
    contentEl.createEl('p', { cls: 'certfs-quiz-question', text: q.question });

    let read = () => null;
    if (q.type === 'mc' || q.type === 'scenario' || q.type === 'multi') {
      const multi = q.type === 'multi';
      const groupName = `certfs-quiz-opt-${Date.now()}-${this.i}`;
      const inputs = q.options.map((opt, idx) => {
        const label = contentEl.createEl('label', { cls: 'certfs-quiz-option' });
        const input = label.createEl('input', { type: multi ? 'checkbox' : 'radio' });
        input.name = groupName; // unique per question: a closing modal's radios can't steal the selection
        label.appendText(` ${String.fromCharCode(65 + idx)}) ${opt}`);
        return input;
      });
      read = () => {
        const sel = inputs.map((inp, idx) => (inp.checked ? idx : -1)).filter((x) => x >= 0);
        return sel.length ? sel : null;
      };
    } else if (q.type === 'tf') {
      const row = contentEl.createDiv({ cls: 'certfs-quiz-row' });
      let choice = null;
      const btns = [true, false].map((v) => {
        const b = row.createEl('button', { text: v ? 'True' : 'False' });
        b.onclick = () => { choice = v; btns.forEach((x) => x.removeClass('mod-cta')); b.addClass('mod-cta'); };
        return b;
      });
      read = () => choice;
    } else if (q.type === 'short') {
      const ta = contentEl.createEl('textarea', { cls: 'certfs-quiz-textarea', attr: { rows: '3', placeholder: 'Your answer in your own words' } });
      read = () => (ta.value.trim() ? ta.value.trim() : null);
    } else if (q.type === 'matching') {
      const selects = {};
      for (const p of q.pairs) {
        const row = contentEl.createDiv({ cls: 'certfs-quiz-match' });
        row.createSpan({ text: p.left });
        const sel = row.createEl('select', { cls: 'dropdown' });
        sel.createEl('option', { text: '—', value: '' });
        for (const r of q.rights) sel.createEl('option', { text: r, value: r });
        selects[p.left] = sel;
      }
      read = () => {
        const out = {};
        for (const [left, sel] of Object.entries(selects)) out[left] = sel.value;
        return Object.values(out).some(Boolean) ? out : null;
      };
    }

    const feedback = contentEl.createDiv({ cls: 'certfs-quiz-feedback' });
    const row = contentEl.createDiv({ cls: 'certfs-quiz-row' });
    if (q.hint) {
      const hb = row.createEl('button', { text: '💡 Hint' });
      hb.onclick = () => { feedback.setText(`💡 ${q.hint}`); hb.disabled = true; };
    }
    const unsure = row.createEl('button', { text: '🤷 Not sure' });
    const check = row.createEl('button', { text: 'Check', cls: 'mod-cta' });

    const finish = async (given) => {
      check.disabled = true; unsure.disabled = true;
      let ok = false; let note = '';
      if (given !== null && q.type === 'short') {
        feedback.setText('Grading…');
        try { const r = await gradeShort(this.plugin.settings, q, given); ok = r.correct; note = r.feedback; }
        catch (e) { feedback.setText(`❌ ${e.message}`); check.disabled = false; unsure.disabled = false; return; }
      } else if (given !== null) ok = grade(q, given);
      const result = { q, given, ok, feedback: note };
      this.results.push(result);
      feedback.empty();
      feedback.createEl('p', { cls: ok ? 'certfs-quiz-ok' : 'certfs-quiz-bad', text: ok ? '✅ Correct' : `❌ ${given === null ? 'Not sure' : 'Not quite'}` });
      if (!ok || q.type === 'short') feedback.createEl('p', { text: `Correct: ${correctText(q)}` });
      if (note) feedback.createEl('p', { text: `Feedback: ${note}` });
      if (q.explanation) feedback.createEl('p', { cls: 'certfs-quiz-muted', text: `Why: ${q.explanation}` });
      row.empty();
      const advance = async (action) => {
        row.querySelectorAll('button').forEach((b) => { b.disabled = true; });
        await this.plugin.commitResult(this.source, result, action);
        this.i++; this.render();
      };
      // The AI grader can be too strict on short answers: let the student overrule it.
      if (!ok && given !== null && q.type === 'short') {
        const ov = row.createEl('button', { text: '✋ I was right' });
        ov.onclick = () => { result.ok = true; ov.remove(); feedback.createEl('p', { cls: 'certfs-quiz-ok', text: '✅ Counted as correct' }); };
      }
      const nextText = this.i + 1 < this.questions.length ? 'Next →' : 'See score';
      const notDue = this.source.mode === 'errors' && ok && q.dueDate && q.dueDate > ymd(new Date()) && this.plugin.settings.masteryMode !== 'any';
      if (notDue) {
        feedback.createEl('p', { cls: 'certfs-quiz-warn', text: `⚠️ This error is not due until ${q.dueDate}. A right answer before the due date usually comes from short-term memory, so it does not count by default.` });
        const keep = row.createEl('button', { text: `${nextText} (don't count)`, cls: 'mod-cta' });
        keep.onclick = () => advance('');
        const force = row.createEl('button', { text: '⚠️ Count anyway' });
        force.onclick = () => advance('force');
        const skip = row.createEl('button', { text: '⏭️ Skip → archive', cls: 'mod-warning' });
        skip.onclick = () => {
          if (!skip.dataset.armed) { skip.dataset.armed = '1'; skip.setText(`⚠️ Sure? Archive now without ${this.plugin.settings.mastery} due-day checks`); return; }
          advance('skip');
        };
        keep.focus();
      } else if (this.source.mode === 'archive' && ok) {
        feedback.createEl('p', { text: 'Still know it. Delete this error, or keep it in the archive?' });
        row.createEl('button', { text: '🗑️ Delete' }).onclick = () => advance('delete');
        const keep = row.createEl('button', { text: '📦 Keep', cls: 'mod-cta' });
        keep.onclick = () => advance('keep');
        keep.focus();
      } else {
        const next = row.createEl('button', { text: nextText, cls: 'mod-cta' });
        next.onclick = () => advance('');
        next.focus();
      }
    };
    unsure.onclick = () => finish(null);
    check.onclick = () => {
      const given = read();
      if (given === null) { new Notice('Pick an answer, or press "Not sure".'); return; }
      finish(given);
    };
  }

  /** Show each missed question with the right answer. No re-test, nothing is graded. */
  renderReview(missed) {
    const { contentEl } = this;
    contentEl.empty();
    this.titleEl.setText(`${this.source.exam} quiz · review missed`);
    for (const [n, r] of missed.entries()) {
      const box = contentEl.createDiv({ cls: 'certfs-quiz-review' });
      box.createEl('div', { cls: 'certfs-quiz-tag', text: `${n + 1} / ${missed.length} · ${TYPE_LABEL[r.q.type]} · ${r.q.topic}` });
      box.createEl('p', { cls: 'certfs-quiz-question', text: r.q.question });
      if (r.q.options) {
        const picked = r.given === null || r.given === undefined ? [] : toIndexes(r.given);
        const ul = box.createEl('ul');
        r.q.options.forEach((opt, idx) => {
          const right = r.q.answer.includes(idx);
          const mark = right ? '✅' : picked.includes(idx) ? '❌' : '▫️';
          ul.createEl('li', { cls: right ? 'certfs-quiz-ok' : picked.includes(idx) ? 'certfs-quiz-bad' : '', text: `${mark} ${String.fromCharCode(65 + idx)}) ${opt}` });
        });
      } else {
        box.createEl('p', { cls: 'certfs-quiz-bad', text: `❌ You: ${givenText(r.q, r.given)}` });
        box.createEl('p', { cls: 'certfs-quiz-ok', text: `✅ Correct: ${correctText(r.q)}` });
      }
      if (r.q.explanation) box.createEl('p', { cls: 'certfs-quiz-muted', text: `Why: ${r.q.explanation}` });
    }
    const row = contentEl.createDiv({ cls: 'certfs-quiz-row' });
    row.createEl('button', { text: '← Back to score' }).onclick = () => { contentEl.empty(); this.renderSummary(); };
    row.createEl('button', { text: 'Close', cls: 'mod-cta' }).onclick = () => this.close();
  }

  renderSummary() {
    const { contentEl } = this;
    const right = this.results.filter((r) => r.ok).length;
    const total = this.results.length;
    const pct = total ? Math.round((right / total) * 100) : 0;
    this.titleEl.setText(`${this.source.exam} quiz · done`);
    if (!this.statsWritten) { this.statsWritten = true; this.plugin.updateStats(this.source.subject); }
    contentEl.createEl('h3', { text: `Score: ${right} / ${total} (${pct}%)` });
    const missed = this.results.filter((r) => !r.ok);
    const mode = this.source.mode || 'note';
    if (mode !== 'note') {
      const count = (k) => this.results.filter((r) => r.outcome === k).length;
      const lines = mode === 'errors'
        ? [`📦 Archived (${this.plugin.settings.mastery}/${this.plugin.settings.mastery} correct): ${count('archived')}`, `⏭️ Skipped to archive early: ${count('skipped')}`, `✅ Counted correct: ${count('counted')}`, `⏳ Correct but not due (not counted): ${count('not-due')}`, `🔁 Wrong → streak back to 0, again tomorrow: ${count('reset')}`]
        : [`🗑️ Deleted: ${count('deleted')}`, `📦 Kept in archive: ${count('kept')}`, `↩️ Wrong → back to active errors: ${count('unarchived')}`];
      const ul = contentEl.createEl('ul');
      for (const l of lines) ul.createEl('li', { text: l });
      if (missed.length) contentEl.createEl('p', { cls: 'certfs-quiz-muted', text: 'Misses were logged on the original error notes (no new notes).' });
      contentEl.createDiv({ cls: 'certfs-quiz-row' }).createEl('button', { text: 'Close', cls: 'mod-cta' }).onclick = () => this.close();
      return;
    }
    if (!missed.length) contentEl.createEl('p', { text: '🎉 No mistakes.' });
    else {
      contentEl.createEl('p', { text: `❌ Missed topics: ${[...new Set(missed.map((r) => r.q.topic))].join(', ')}` });
      const ul = contentEl.createEl('ul');
      for (const r of missed) ul.createEl('li', { text: `${r.q.question} → ${correctText(r.q)}` });
      if (this.plugin.settings.logMistakes) contentEl.createEl('p', { cls: 'certfs-quiz-muted', text: this.source.subject
        ? `Saved as error notes in ${errorsDir(this.source.subject, this.plugin.settings)} (review tomorrow).`
        : 'Not saved as error notes: this note is not inside a subject folder (Settings → Subjects).' });
    }
    const row = contentEl.createDiv({ cls: 'certfs-quiz-row' });
    if (missed.length) {
      row.createEl('button', { text: '👀 Review missed' }).onclick = () => this.renderReview(missed);
      const fresh = row.createEl('button', { text: '🆕 New questions on missed topics', cls: 'mod-cta' });
      const freshStatus = contentEl.createEl('p', { cls: 'certfs-quiz-muted' });
      fresh.onclick = async () => {
        fresh.disabled = true; fresh.setText('Generating…');
        freshStatus.setText('Generating… (free models can take 10–40 s, max 90 s)');
        try {
          const opts = { ...this.opts, count: Math.max(3, missed.length), focus: [...new Set(missed.map((r) => r.q.topic))].join(', ') };
          const qs = await this.plugin.generate(this.source, opts, this.questions.map((q) => q.question));
          this.close();
          new QuizModal(this.plugin, this.source, qs, opts).open();
        } catch (e) { freshStatus.setText(`❌ ${e.message}`); fresh.disabled = false; fresh.setText('🆕 New questions on missed topics'); }
      };
    }
    row.createEl('button', { text: 'Close' }).onclick = () => this.close();
  }
}

/** Setup for "Quiz my errors" (mode errors) and "Test my archive" (mode archive). */
class ErrorSetupModal extends Modal {
  constructor(plugin, mode, sub) {
    super(plugin.app);
    this.plugin = plugin;
    this.mode = mode;
    const subs = plugin.subjects();
    this.opts = { subject: sub ? sub.name : (subs[0] ? subs[0].name : ''), scope: 'due', count: 10 };
    this.found = 0;
  }

  onOpen() {
    const { contentEl } = this;
    this.titleEl.setText(this.mode === 'archive' ? '📦 Test my archive' : '🔁 Quiz my errors');
    const subs = this.plugin.subjects();
    if (!subs.length) {
      contentEl.createEl('p', { text: 'No subjects yet. Add one in Settings → CertFS Quiz → Subjects (a folder with your notes). Error notes are saved per subject.' });
      return;
    }
    const n = this.plugin.settings.mastery;
    contentEl.createEl('p', { cls: 'certfs-quiz-muted', text: this.mode === 'archive'
      ? 'A new version of each archived question. Right → delete or keep. Wrong → back to active errors.'
      : `A new version of each error, never the same wording. ${n} correct on ${n} due days → archived. Wrong → streak back to 0.` });
    const info = contentEl.createEl('p');
    let countBox;
    const refresh = () => {
      this.found = this.plugin.collectErrors(this.mode, this.opts.subject, this.opts.scope).length;
      if (countBox) renderCount();
      if (this.mode === 'archive') { info.setText(`Found: ${this.found} archived error(s).`); return; }
      const due = this.plugin.collectErrors('errors', this.opts.subject, 'due').length;
      const active = this.plugin.collectErrors('errors', this.opts.subject, 'all');
      const next = active.map((f) => ((this.app.metadataCache.getFileCache(f) || {}).frontmatter || {}).next_review)
        .filter(Boolean).map((d) => String(d).slice(0, 10)).sort()[0];
      info.setText(`📅 ${due} due today · ${active.length} active${due === 0 && next ? ` (next due ${next})` : ''}`);
    };
    new Setting(contentEl).setName('Subject').addDropdown((d) => {
      for (const sub of subs) d.addOption(sub.name, sub.name);
      d.setValue(this.opts.subject).onChange((v) => { this.opts.subject = v; refresh(); });
    });
    if (this.mode === 'errors') {
      new Setting(contentEl).setName('Which errors').addDropdown((d) => d.addOptions({ due: 'Due today (counts toward archive)', all: 'All active (not-due ones ask before counting)' }).setValue(this.opts.scope).onChange((v) => { this.opts.scope = v; refresh(); }));
    }
    countBox = contentEl.createDiv();
    let genBtn;
    // One new question per error: the count can never exceed the errors found.
    const renderCount = () => {
      countBox.empty();
      const max = Math.min(15, this.found);
      this.opts.count = Math.max(1, max);
      if (genBtn) genBtn.setDisabled(this.found === 0);
      if (max <= 1) {
        countBox.createEl('p', { cls: 'certfs-quiz-muted', text: max === 1 ? 'Questions: 1 (one per error).' : 'Nothing to quiz here.' });
        return;
      }
      new Setting(countBox).setName('Questions').setDesc(`One new question per error · ${this.found} found · one request to OpenRouter.`)
        .addSlider((sl) => sl.setLimits(1, max, 1).setValue(this.opts.count).setDynamicTooltip().onChange((v) => { this.opts.count = v; }));
    };
    refresh();
    const status = contentEl.createEl('p', { cls: 'certfs-quiz-muted' });
    new Setting(contentEl).addButton((b) => { genBtn = b; b.setButtonText('Generate').setCta().setDisabled(this.found === 0).onClick(async () => {
      b.setDisabled(true);
      status.setText('Generating new versions… (free models can take 10–40 s)');
      try {
        const { source, questions } = await this.plugin.generateErrorQuiz(this.mode, this.opts);
        this.close();
        new QuizModal(this.plugin, source, questions, {}).open();
      } catch (e) { status.setText(`❌ ${e.message}`); b.setDisabled(false); }
    }); });
  }

  onClose() { this.contentEl.empty(); }
}

/** Type-ahead vault search under a Settings text box (folders or notes). Needs Obsidian 1.4.10+. */
const VaultInputSuggest = obsidian.AbstractInputSuggest ? class extends obsidian.AbstractInputSuggest {
  constructor(app, inputEl, kind) { super(app, inputEl); this.inputEl = inputEl; this.kind = kind; }
  getSuggestions(query) {
    const q = String(query || '').toLowerCase();
    const items = this.kind === 'folder'
      ? this.app.vault.getAllLoadedFiles().filter((f) => f instanceof TFolder && f.path !== '/' && !f.path.startsWith('.')).map((f) => f.path)
      : this.app.vault.getMarkdownFiles().map((f) => f.basename);
    return [...new Set(items)].filter((x) => x.toLowerCase().includes(q)).sort((a, b) => a.length - b.length).slice(0, 50);
  }
  renderSuggestion(value, el) { el.setText(value); }
  selectSuggestion(value) {
    this.inputEl.value = value;
    this.inputEl.dispatchEvent(new Event('input'));
    this.close();
  }
} : null;

function attachSuggest(app, inputEl, kind) {
  if (VaultInputSuggest) new VaultInputSuggest(app, inputEl, kind);
}

class FolderSuggest extends FuzzySuggestModal {
  constructor(plugin) { super(plugin.app); this.plugin = plugin; this.setPlaceholder('Pick a folder to quiz on'); }
  getItems() { return this.app.vault.getAllLoadedFiles().filter((f) => f instanceof TFolder && f.path !== '/' && !f.path.startsWith('.')); }
  getItemText(f) { return f.path; }
  onChooseItem(f) { this.plugin.quizFolder(f); }
}

/** Pick several notes (search + checkboxes), then quiz them together. */
class NotesPickerModal extends Modal {
  constructor(plugin, preselected) {
    super(plugin.app);
    this.plugin = plugin;
    this.selected = new Map((preselected || []).map((f) => [f.path, f]));
    this.query = '';
  }

  onOpen() {
    const { contentEl } = this;
    this.modalEl.addClass('certfs-quiz');
    this.titleEl.setText('Quiz multiple notes');
    const search = contentEl.createEl('input', { type: 'text', cls: 'certfs-quiz-search', attr: { placeholder: 'Search notes by name or path…' } });
    search.addEventListener('input', () => { this.query = search.value.trim().toLowerCase(); this.renderList(); });
    this.chipsEl = contentEl.createDiv({ cls: 'certfs-quiz-chips' });
    this.listEl = contentEl.createDiv({ cls: 'certfs-quiz-picklist' });
    const row = contentEl.createDiv({ cls: 'certfs-quiz-row' });
    this.goBtn = row.createEl('button', { cls: 'mod-cta' });
    this.goBtn.addEventListener('click', () => this.go());
    row.createEl('button', { text: 'Clear' }).addEventListener('click', () => { this.selected.clear(); this.renderList(); });
    this.renderList();
    setTimeout(() => search.focus(), 0);
  }

  candidates() {
    const q = this.query;
    return this.app.vault.getMarkdownFiles()
      .filter((f) => !this.plugin.isStatsFile(f))
      .filter((f) => !q || f.path.toLowerCase().includes(q))
      .sort((a, b) => b.stat.mtime - a.stat.mtime)
      .slice(0, 100);
  }

  toggle(f, on) {
    if (on) this.selected.set(f.path, f); else this.selected.delete(f.path);
    this.renderList();
  }

  renderList() {
    this.chipsEl.empty();
    for (const f of this.selected.values()) {
      const chip = this.chipsEl.createEl('span', { cls: 'certfs-quiz-chip', text: `${f.basename} ✕`, attr: { title: `Remove ${f.path}` } });
      chip.addEventListener('click', () => this.toggle(f, false));
    }
    this.listEl.empty();
    const items = this.candidates();
    if (!items.length) this.listEl.createEl('p', { cls: 'certfs-quiz-muted', text: 'No notes match.' });
    for (const f of items) {
      const label = this.listEl.createEl('label', { cls: 'certfs-quiz-option' });
      const cb = label.createEl('input', { type: 'checkbox' });
      cb.checked = this.selected.has(f.path);
      cb.addEventListener('change', () => this.toggle(f, cb.checked));
      label.appendText(` ${f.basename} `);
      label.createEl('span', { cls: 'certfs-quiz-muted', text: f.parent && f.parent.path !== '/' ? f.parent.path : '' });
    }
    const n = this.selected.size;
    this.goBtn.setText(n ? `Quiz ${n} note${n > 1 ? 's' : ''}` : 'Pick notes');
    this.goBtn.disabled = n === 0;
  }

  async go() {
    const files = [...this.selected.values()];
    if (!files.length) return;
    this.close();
    await this.plugin.quizFiles(files);
  }

  onClose() { this.contentEl.empty(); }
}

class CertfsQuizSettingTab extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }

  display() {
    const { containerEl } = this;
    const s = this.plugin.settings;
    const save = () => this.plugin.saveSettings();
    containerEl.empty();
    new Setting(containerEl).setName('OpenRouter API key').setDesc('From openrouter.ai/keys. Stored in this plugin\'s data.json (git-ignored).')
      .addText((t) => { t.inputEl.type = 'password'; t.setValue(s.apiKey).onChange(async (v) => { s.apiKey = v.trim(); await save(); }); });
    const modelSetting = new Setting(containerEl).setName('Model').setDesc('A free model ID ends with ":free".')
      .addText((t) => t.setPlaceholder('vendor/model:free').setValue(s.model).onChange(async (v) => { s.model = v.trim(); await save(); }));
    modelSetting.addButton((b) => b.setButtonText('Load free models').onClick(async () => {
      b.setDisabled(true);
      try {
        const res = await requestUrl({ url: `${API}/models`, method: 'GET' });
        const ids = chatFreeModels(res.json && res.json.data);
        if (!ids.length) throw new Error('No free models found right now.');
        this.freeModels = ids;
        this.display();
      } catch (e) { new Notice(`Could not load models: ${e.message}`); b.setDisabled(false); }
    }));
    if (this.freeModels) {
      new Setting(containerEl).setName('Free models (live list)').addDropdown((d) => {
        d.addOption('', '— pick one —');
        for (const id of this.freeModels) d.addOption(id, id);
        d.setValue(this.freeModels.includes(s.model) ? s.model : '').onChange(async (v) => { if (v) { s.model = v; await save(); this.display(); } });
      });
    }
    new Setting(containerEl).setName('Default number of questions').addSlider((sl) => sl.setLimits(1, 15, 1).setValue(s.count).setDynamicTooltip().onChange(async (v) => { s.count = v; await save(); }));
    new Setting(containerEl).setName('Default difficulty').addDropdown((d) => d.addOptions({ easy: 'Easy', medium: 'Medium', hard: 'Hard (exam-level)' }).setValue(s.difficulty).onChange(async (v) => { s.difficulty = v; await save(); }));
    new Setting(containerEl).setName('Hints').addToggle((t) => t.setValue(s.hints).onChange(async (v) => { s.hints = v; await save(); }));
    new Setting(containerEl).setName('Default question types').setHeading();
    for (const t of Object.keys(TYPE_LABEL)) {
      new Setting(containerEl).setName(TYPE_LABEL[t]).addToggle((tg) => tg.setValue(!!s.types[t]).onChange(async (v) => { s.types[t] = v; await save(); }));
    }

    /* ----- subjects ----- */
    new Setting(containerEl).setName('Subjects').setHeading()
      .setDesc('A subject = a folder with your notes + an optional question style. A note inside that folder is quizzed in that style, and its mistakes go to <folder>/' + (normFolder(s.errorsFolder) || 'Errors') + '. Notes outside every subject still work (general style, no error notes).');
    if (!Array.isArray(s.subjects)) s.subjects = [];
    s.subjects.forEach((sub, idx) => {
      const box = containerEl.createDiv({ cls: 'certfs-quiz-subject' });
      new Setting(box).setClass('certfs-quiz-subject-row')
        .addText((t) => t.setPlaceholder('Name (e.g. Biology)').setValue(sub.name || '').onChange(async (v) => { sub.name = v.trim(); await save(); }))
        .addText((t) => { attachSuggest(this.app, t.inputEl, 'folder'); t.setPlaceholder('Folder: type to search').setValue(sub.folder || '').onChange(async (v) => { sub.folder = normFolder(v); await save(); }); })
        .addText((t) => { attachSuggest(this.app, t.inputEl, 'note'); t.setPlaceholder('Rules note: type to search').setValue(sub.rules || '').onChange(async (v) => { sub.rules = v.trim(); await save(); }); })
        .addExtraButton((b) => b.setIcon('trash').setTooltip('Remove subject (notes are not touched)').onClick(async () => { s.subjects.splice(idx, 1); await save(); this.display(); }));
      new Setting(box).setClass('certfs-quiz-style-setting').setName('Question style (optional)').setDesc('Filling name + folder above is enough to start. Empty → the AI uses the subject name and folder to guess the exam style. Write here only to steer it: exact wording, traps, scenario type.')
        .addTextArea((t) => { t.inputEl.rows = 3; t.inputEl.addClass('certfs-quiz-style'); t.setPlaceholder('Empty = auto from name + folder. Example: Exam: AWS Solutions Architect. Scenario questions about picking the right service.').setValue(sub.style || '').onChange(async (v) => { sub.style = v.trim(); await save(); }); });
      const f = normFolder(sub.folder);
      if (f && !(this.app.vault.getAbstractFileByPath(f) instanceof TFolder)) box.createEl('p', { cls: 'certfs-quiz-warn', text: `⚠️ Folder "${f}" does not exist in this vault.` });
    });
    new Setting(containerEl)
      .addButton((b) => b.setButtonText('Add subject').setCta().onClick(async () => { s.subjects.push({ name: '', folder: '', rules: '', style: '' }); await save(); this.display(); }))
      .addButton((b) => b.setButtonText('Add presets (CSM, PMP, CPMAI)').onClick(async () => {
        const have = new Set(s.subjects.map((x) => x.name));
        for (const p of PRESET_SUBJECTS) if (!have.has(p.name)) s.subjects.push({ ...p });
        await save(); this.display();
      }));

    /* ----- error notes + mastery ----- */
    new Setting(containerEl).setName('Error notes').setHeading();
    new Setting(containerEl).setName('Save mistakes as error notes').setDesc('Wrong answers go to <subject folder>/<errors folder> with next_review = tomorrow.')
      .addToggle((t) => t.setValue(s.logMistakes).onChange(async (v) => { s.logMistakes = v; await save(); }));
    new Setting(containerEl).setName('Errors folder name').setDesc('Inside each subject folder. Renaming does not move old notes.')
      .addText((t) => t.setPlaceholder('Errors').setValue(s.errorsFolder).onChange(async (v) => { s.errorsFolder = normFolder(v) || 'Errors'; await save(); }));
    new Setting(containerEl).setName('Archive folder name').setDesc('Inside the errors folder. Mastered errors move here.')
      .addText((t) => t.setPlaceholder('Archive').setValue(s.archiveFolder).onChange(async (v) => { s.archiveFolder = normFolder(v) || 'Archive'; await save(); }));
    new Setting(containerEl).setName('Folder quiz skips').setDesc('Comma-separated folder names. The errors and archive folders are always skipped.')
      .addText((t) => t.setPlaceholder('Mocks, Templates').setValue(s.skipFolders).onChange(async (v) => { s.skipFolders = v; await save(); }));
    new Setting(containerEl).setName('Correct answers to master an error').setDesc('A wrong answer resets the count to 0.')
      .addSlider((sl) => sl.setLimits(1, 10, 1).setValue(s.mastery).setDynamicTooltip().onChange(async (v) => { s.mastery = v; await save(); }));
    new Setting(containerEl).setName('Days between checks').setDesc('After correct #1, #2, … (comma-separated). The last value repeats. Wrong → again tomorrow.')
      .addText((t) => t.setPlaceholder('3, 7').setValue((s.intervals || []).join(', ')).onChange(async (v) => { const list = parseIntervals(v); if (list.length) { s.intervals = list; await save(); } }));
    new Setting(containerEl).setName('Count a correct answer').setDesc('On due days only (spaced repetition), or any time.')
      .addDropdown((d) => d.addOptions({ days: 'Only on due days', any: 'Any time' }).setValue(s.masteryMode).onChange(async (v) => { s.masteryMode = v; await save(); }));

    /* ----- history ----- */
    new Setting(containerEl).setName('Answer history').setHeading();
    new Setting(containerEl).setName('Keep answer history').setDesc('Every answer (right or wrong) goes to history.json in this plugin folder. Used for "Show my stats", the Stats note, and so new quizzes skip recent questions. Off → stats stop updating (not a bug).')
      .addToggle((t) => t.setValue(s.keepHistory).onChange(async (v) => { s.keepHistory = v; await save(); }));
    new Setting(containerEl).setName('Stats note').setDesc('Written to each subject folder and rewritten when a quiz ends. Needs "Keep answer history" on (otherwise it shows "paused"). Empty = off. The folder quiz skips it.')
      .addText((t) => t.setPlaceholder('Stats').setValue(s.statsFile).onChange(async (v) => { s.statsFile = v.trim().replace(/\.md$/i, '').replace(/[\\/:*?"<>|#^[\]]/g, ''); await save(); }));
    new Setting(containerEl).setName('Clear history').addButton((b) => b.setButtonText('Clear').setWarning().onClick(async () => {
      if (!b.buttonEl.dataset.armed) { b.buttonEl.dataset.armed = '1'; b.setButtonText('Sure? Click again'); return; }
      await this.plugin.clearHistory(); new Notice('History cleared.'); this.display();
    }));
  }
}

/** "Show my stats": totals per subject + weakest topics, from history.json. */
class StatsModal extends Modal {
  constructor(plugin, history) { super(plugin.app); this.history = history; }

  onOpen() {
    const { contentEl } = this;
    this.titleEl.setText('📊 My stats');
    const stats = historyStats(this.history, new Date());
    if (!stats.length) { contentEl.createEl('p', { text: 'No answers yet. Take a quiz first.' }); return; }
    for (const st of stats) {
      contentEl.createEl('h4', { text: `${st.subject}: ${st.right} / ${st.total} right (${st.pct}%)` });
      contentEl.createEl('p', { cls: 'certfs-quiz-muted', text: `Last 7 days: ${st.week} answers.` });
      if (st.weakest.length) {
        const ul = contentEl.createEl('ul');
        for (const t of st.weakest) ul.createEl('li', { text: `${t.topic}: ${t.right} / ${t.total} (${t.pct}%)` });
      } else contentEl.createEl('p', { text: 'No weak topics yet (needs 2+ answers on a topic).' });
    }
  }

  onClose() { this.contentEl.empty(); }
}

class CertfsQuizPlugin extends Plugin {
  async onload() {
    await this.loadSettings();
    this.addSettingTab(new CertfsQuizSettingTab(this.app, this));
    this.addRibbonIcon('brain-circuit', 'CertFS Quiz: quiz this note', () => this.quizActiveNote());
    this.addRibbonIcon('rotate-ccw', 'CertFS Quiz: quiz my errors', () => this.openErrors('errors'));
    this.addCommand({ id: 'quiz-note', name: 'Quiz this note', callback: () => this.quizActiveNote() });
    this.addCommand({ id: 'quiz-folder', name: 'Quiz a folder', callback: () => new FolderSuggest(this).open() });
    this.addCommand({ id: 'quiz-notes', name: 'Quiz multiple notes', callback: () => this.pickNotes() });
    this.addCommand({ id: 'quiz-errors', name: 'Quiz my errors', callback: () => this.openErrors('errors') });
    this.addCommand({ id: 'quiz-archive', name: 'Test my archive', callback: () => this.openErrors('archive') });
    this.addCommand({ id: 'quiz-stats', name: 'Show my stats', callback: async () => new StatsModal(this, await this.loadHistory()).open() });
    this.app.workspace.onLayoutReady(() => this.seedSubjects());
    // File explorer: select several notes (Ctrl/Cmd/Shift+click) → right-click → Quiz these notes
    this.registerEvent(this.app.workspace.on('files-menu', (menu, files) => {
      const notes = files.filter((f) => f instanceof TFile && f.extension === 'md');
      if (notes.length < 2) return;
      menu.addItem((item) => item.setTitle(`CertFS Quiz: quiz ${notes.length} notes`).setIcon('brain-circuit').onClick(() => this.quizFiles(notes)));
    }));
    this.addCommand({
      id: 'quiz-selection',
      name: 'Quiz selected text',
      editorCallback: (editor, view) => {
        const text = editor.getSelection().trim();
        if (!text) { new Notice('Select some text first.'); return; }
        const file = view.file;
        this.open({ title: `${file ? file.basename : 'Selection'} (selection)`, path: file ? file.path : '', ...this.subjectOf(file && file.path), text });
      },
    });
  }

  async loadSettings() {
    const saved = (await this.loadData()) || {};
    this.settings = { ...DEFAULTS, ...saved, types: { ...DEFAULTS.types, ...(saved.types || {}) } };
  }

  subjects() {
    return (this.settings.subjects || []).filter((x) => x && x.name && normFolder(x.folder));
  }

  /** { exam, subject } for a vault path; no subject → General style, no error notes. */
  subjectOf(path) {
    const subject = detectSubject(path, this.subjects());
    return { exam: subjectName(subject), subject };
  }

  /** First run: offer the presets whose folders exist in this vault. */
  async seedSubjects() {
    if (Array.isArray(this.settings.subjects)) return;
    this.settings.subjects = PRESET_SUBJECTS
      .filter((p) => this.app.vault.getAbstractFileByPath(p.folder) instanceof TFolder)
      .map((p) => ({ ...p }));
    await this.saveSettings();
  }

  async saveSettings() { await this.saveData(this.settings); }

  async quizActiveNote() {
    const file = this.app.workspace.getActiveFile();
    if (!file || file.extension !== 'md') { new Notice('Open a Markdown note first.'); return; }
    const text = stripFrontmatter(await this.app.vault.cachedRead(file)).trim();
    if (text.length < 80) { new Notice('This note is too short to quiz on.'); return; }
    this.open({ title: file.basename, path: file.path, ...this.subjectOf(file.path), text });
  }

  open(source) {
    source.text = source.text.slice(0, MAX_SOURCE_CHARS);
    new SetupModal(this, source).open();
  }

  async generate(source, opts, avoid) {
    const plan = distribute(opts.count, opts.types);
    avoid = [...new Set([...(avoid || []), ...(this.settings.keepHistory ? recentQuestions(await this.loadHistory(), source.path || source.title) : [])])];
    const messages = buildMessages({ style: subjectStyle(source.subject), title: source.title, text: source.text, plan, difficulty: opts.difficulty, focus: opts.focus, hints: this.settings.hints, avoid, multi: source.multi });
    const data = parseJson(await chat(this.settings, messages, Math.min(8000, 700 + opts.count * 450)));
    const questions = normalizeQuestions(data);
    if (!questions.length) throw new Error('The model returned no usable questions. Try again or pick another free model.');
    return questions;
  }

  async logMistake(source, q, given, feedback) {
    if (!this.settings.logMistakes || !source.subject) return;
    try {
      const now = new Date();
      const dir = errorsDir(source.subject, this.settings);
      const path = `${dir}/${ymd(now)} ${safeName(q.topic)}.md`;
      const existing = this.app.vault.getAbstractFileByPath(path);
      if (existing) {
        await this.app.fileManager.processFrontMatter(existing, (fm) => { fm.status = 'new'; fm.streak = 0; fm.next_review = ymd(addDays(now, 1)); });
        await this.app.vault.process(existing, (t) => appendMistake(t, { q, given, feedback, now }));
      } else {
        if (!this.app.vault.getAbstractFileByPath(dir)) await this.app.vault.createFolder(dir);
        await this.app.vault.create(path, errorNote({ exam: source.exam, rules: source.subject.rules, source: source.title, q, given, feedback, now }));
      }
    } catch (e) {
      new Notice(`Could not save the error note: ${e.message}`);
    }
  }

  /* ----- folder + multi-note quiz ----- */

  /** Read notes for a group quiz; drops ones that are too short to quiz on. */
  async readNotes(files) {
    const notes = [];
    for (const f of files) {
      const text = stripFrontmatter(await this.app.vault.cachedRead(f)).trim();
      if (text.length >= 80) notes.push({ title: f.basename, path: f.path, text });
    }
    return notes;
  }

  async quizFolder(folder) {
    const skip = skipRegex(this.settings);
    const files = this.app.vault.getMarkdownFiles()
      .filter((f) => f.path.startsWith(`${folder.path}/`))
      .filter((f) => !(skip && skip.test(f.path.slice(folder.path.length))) && !f.basename.startsWith('_') && !this.isStatsFile(f))
      .sort((a, b) => a.path.localeCompare(b.path));
    const notes = await this.readNotes(files);
    if (!notes.length) { new Notice('No study notes in this folder.'); return; }
    this.open({ title: `${folder.name} (${notes.length} notes)`, path: folder.path, ...this.subjectOf(folder.path), text: packNotes(notes, MAX_SOURCE_CHARS), multi: notes.length > 1 });
  }

  /** Open the note picker; the active note is ticked to start with. */
  pickNotes() {
    const active = this.app.workspace.getActiveFile();
    new NotesPickerModal(this, active && active.extension === 'md' ? [active] : []).open();
  }

  /** Quiz several hand-picked notes together (same flow as a folder quiz). */
  async quizFiles(files) {
    const notes = await this.readNotes(files);
    if (!notes.length) { new Notice('These notes are too short to quiz on.'); return; }
    const skipped = files.length - notes.length;
    if (skipped) new Notice(`Skipped ${skipped} note${skipped > 1 ? 's' : ''} that ${skipped > 1 ? 'are' : 'is'} too short.`);
    const paths = notes.map((n) => n.path).sort();
    const subject = commonSubject(paths, this.subjects());
    const title = notes.length === 1 ? notes[0].title : `${notes[0].title} + ${notes.length - 1} more`;
    this.open({ title, path: paths.join(' + '), exam: subjectName(subject), subject, text: packNotes(notes, MAX_SOURCE_CHARS), multi: notes.length > 1 });
  }

  /* ----- error re-quiz + archive ----- */

  openErrors(mode) {
    const file = this.app.workspace.getActiveFile();
    new ErrorSetupModal(this, mode, this.subjectOf(file && file.path).subject).open();
  }

  collectErrors(mode, name, scope) {
    const sub = this.subjects().find((x) => x.name === name);
    if (!sub) return [];
    const dir = errorsDir(sub, this.settings);
    const arch = archiveDir(sub, this.settings);
    const now = new Date();
    return this.app.vault.getMarkdownFiles().filter((f) => {
      if (f.basename.startsWith('_')) return false;
      const inArchive = f.path.startsWith(`${arch}/`);
      if (mode === 'archive') return inArchive;
      if (!f.path.startsWith(`${dir}/`) || inArchive) return false;
      const fm = (this.app.metadataCache.getFileCache(f) || {}).frontmatter || {};
      if (fm.status === 'mastered') return false;
      return scope === 'all' || isDue(fm, now);
    }).sort((a, b) => a.path.localeCompare(b.path));
  }

  async generateErrorQuiz(mode, opts) {
    const sub = this.subjects().find((x) => x.name === opts.subject);
    const files = shuffle(this.collectErrors(mode, opts.subject, opts.scope)).slice(0, opts.count);
    if (!files.length) throw new Error(mode === 'archive' ? 'The archive is empty.' : 'No errors to quiz right now. 🎉');
    const errors = [];
    const byRef = {};
    for (const [i, f] of files.entries()) {
      const parsed = parseErrorNote(await this.app.vault.read(f));
      if (!parsed.question || !parsed.correct) continue;
      const fm = (this.app.metadataCache.getFileCache(f) || {}).frontmatter || {};
      const ref = String(i + 1);
      byRef[ref] = f;
      errors.push({ ref, topic: fm.topic || f.basename, ...parsed });
    }
    if (!errors.length) throw new Error('These error notes have no Question/Correct lines to work from.');
    const messages = buildErrorMessages({ style: subjectStyle(sub), errors, hints: this.settings.hints });
    const data = parseJson(await chat(this.settings, messages, Math.min(8000, 700 + errors.length * 450)));
    const questions = matchErrorQuestions(normalizeQuestions(data), Object.keys(byRef));
    if (!questions.length) throw new Error('The model returned no usable questions. Try again or pick another free model.');
    for (const q of questions) {
      const f = byRef[q.ref];
      const fm = (this.app.metadataCache.getFileCache(f) || {}).frontmatter || {};
      q.errorPath = f.path;
      q.dueDate = fm.next_review ? String(fm.next_review).slice(0, 10) : '';
    }
    const title = mode === 'archive' ? 'archive test' : 'errors';
    return { source: { title, exam: subjectName(sub), subject: sub, mode, path: '', text: '' }, questions };
  }

  /** Called once per answer, when the student moves on. */
  async commitResult(source, result, action) {
    try {
      if (source.mode === 'errors') result.outcome = await this.applyErrorResult(result, action);
      else if (source.mode === 'archive') result.outcome = await this.applyArchiveResult(result, action);
      else if (!result.ok) await this.logMistake(source, result.q, givenText(result.q, result.given), result.feedback);
    } catch (e) {
      new Notice(`Could not update the error note: ${e.message}`);
    }
    await this.recordHistory(source, result);
  }

  /* ----- answer history (history.json in the plugin folder) ----- */

  historyPath() { return `${this.manifest.dir}/history.json`; }

  async loadHistory() {
    if (this.history) return this.history;
    try {
      const a = this.app.vault.adapter;
      this.history = (await a.exists(this.historyPath())) ? JSON.parse(await a.read(this.historyPath())) : [];
      if (!Array.isArray(this.history)) this.history = [];
    } catch (_) { this.history = []; }
    return this.history;
  }

  async recordHistory(source, result) {
    if (!this.settings.keepHistory) return;
    try {
      const q = result.q;
      const entry = { d: ymd(new Date()), s: source.exam, src: source.path || source.title, t: q.topic, q: q.question, ok: !!result.ok, m: source.mode || 'note' };
      this.history = addHistory(await this.loadHistory(), [entry]);
      await this.app.vault.adapter.write(this.historyPath(), JSON.stringify(this.history));
    } catch (e) { console.warn('CertFS Quiz: could not save history', e); }
  }

  isStatsFile(f) {
    const name = normFolder(this.settings.statsFile);
    return !!name && this.subjects().some((sub) => f.path === `${normFolder(sub.folder)}/${name}.md`);
  }

  /** Rewrite <subject folder>/Stats.md from the history. Called when a quiz ends. */
  async updateStats(sub) {
    const name = normFolder(this.settings.statsFile);
    if (!sub || !name) return;
    try {
      const path = `${normFolder(sub.folder)}/${name}.md`;
      const errors = {
        due: this.collectErrors('errors', sub.name, 'due').length,
        active: this.collectErrors('errors', sub.name, 'all').length,
        archived: this.collectErrors('archive', sub.name).length,
      };
      const text = statsNote(await this.loadHistory(), sub.name, new Date(), errors, !this.settings.keepHistory);
      const file = this.app.vault.getAbstractFileByPath(path);
      if (file) await this.app.vault.modify(file, text);
      else await this.app.vault.create(path, text);
    } catch (e) { new Notice(`Could not update the stats note: ${e.message}`); }
  }

  async clearHistory() {
    this.history = [];
    await this.app.vault.adapter.write(this.historyPath(), '[]');
  }

  async applyErrorResult(result, action) {
    const file = this.app.vault.getAbstractFileByPath(result.q.errorPath);
    if (!file) return 'missing';
    const now = new Date();
    let st;
    await this.app.fileManager.processFrontMatter(file, (fm) => {
      st = nextErrorState(fm, result.ok, now, this.settings.masteryMode, action, this.settings);
      fm.streak = st.streak; fm.status = st.status; fm.next_review = st.next_review;
    });
    const mark = !result.ok ? `❌ variant (streak → 0, picked: ${givenText(result.q, result.given)})`
      : st.skipped ? '⏭️ variant right, skipped to archive before due'
      : st.counted ? `✅ variant (${st.streak}/${this.settings.mastery})${action === 'force' ? ' (counted early, not due)' : ''}` : '✅ variant (not due, not counted)';
    await this.app.vault.process(file, (t) => appendLog(t, logLine(now, `${mark} · Q: ${result.q.question}`)));
    if (st.archive) {
      await this.moveTo(file, `${file.parent.path}/${normFolder(this.settings.archiveFolder) || 'Archive'}`);
      return st.skipped ? 'skipped' : 'archived';
    }
    return !result.ok ? 'reset' : st.counted ? 'counted' : 'not-due';
  }

  async applyArchiveResult(result, action) {
    const file = this.app.vault.getAbstractFileByPath(result.q.errorPath);
    if (!file) return 'missing';
    const now = new Date();
    if (result.ok && action === 'delete') {
      if (this.app.fileManager.trashFile) await this.app.fileManager.trashFile(file);
      else await this.app.vault.trash(file, true);
      return 'deleted';
    }
    if (result.ok) {
      await this.app.vault.process(file, (t) => appendLog(t, logLine(now, `✅ archive test (kept) · Q: ${result.q.question}`)));
      return 'kept';
    }
    await this.app.fileManager.processFrontMatter(file, (fm) => { fm.streak = 0; fm.status = 'new'; fm.next_review = ymd(addDays(now, 1)); });
    await this.app.vault.process(file, (t) => appendLog(t, logLine(now, `❌ archive test (back to active, picked: ${givenText(result.q, result.given)}) · Q: ${result.q.question}`)));
    await this.moveTo(file, file.parent.parent.path);
    return 'unarchived';
  }

  async moveTo(file, dir) {
    if (!this.app.vault.getAbstractFileByPath(dir)) await this.app.vault.createFolder(dir);
    let target = `${dir}/${file.name}`;
    for (let n = 2; this.app.vault.getAbstractFileByPath(target); n++) target = `${dir}/${file.basename} (${n}).md`;
    await this.app.fileManager.renameFile(file, target);
  }
}

module.exports = CertfsQuizPlugin;
module.exports._test = { withTimeout, detectSubject, commonSubject, subjectName, errorsDir, archiveDir, intervalFor, parseIntervals, skipRegex, addHistory, recentQuestions, historyStats, statsNote, subjectStyle, PRESET_SUBJECTS, distribute, stripFrontmatter, buildMessages, parseJson, normalizeQuestions, grade, correctText, givenText, errorNote, appendMistake, errorDetail, chatFreeModels, parseErrorNote, buildErrorMessages, matchErrorQuestions, isDue, nextErrorState, appendLog, logLine, packNotes, ymd, addDays, safeName, chat };
