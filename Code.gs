/**
 * CSP Sprint Board — Google Apps Script backend
 * -------------------------------------------------
 * Paste this into Extensions > Apps Script of a NEW Google Sheet
 * (keep it separate from the SDD board's Sheet).
 *
 * IMPORTANT: after ANY change to this file you must redeploy:
 *   Deploy > Manage deployments > pencil icon > Version: New version > Deploy
 * The /exec URL stays the same.
 */

const CONFIG = {
  // Where Commit Update and Finish Sprint snapshots go.
  // This is also the email you type on the board to open the teacher view.
  TEACHER_EMAIL: 'CHANGE_ME@lbschools.net',

  // Student emails: exactly 9 digits + @lbschools.net
  EMAIL_PATTERN: /^\d{9}@lbschools\.net$/,

  // Demo account for walking the class through the board.
  // Not on the roster, never grouped or exported, emails go to the teacher only.
  DEMO_EMAIL: '000000000@lbschools.net',

  // When the Roster tab has students in it, reject emails that aren't on it.
  // This catches typos in the 9 digits (e.g. 201125316 vs 201125361).
  REQUIRE_ROSTER: true,

  // Only used if the Roster tab is empty.
  FALLBACK_PERIODS: ['1', '2'],

  // Canvas group import. Check how your Canvas identifies students:
  //   login_id + email   -> 201125361@lbschools.net
  //   login_id + digits  -> 201125361
  //   sis_user_id + digits -> 201125361
  CANVAS_ID_COLUMN: 'login_id',   // 'login_id' or 'sis_user_id'
  CANVAS_ID_VALUE: 'email',       // 'email' or 'digits'

  // Optional: your GitHub Pages board link, included in emails.
  BOARD_URL: ''
};

const TABS = {
  ROSTER: 'Roster',
  STUDENTS: 'Students',
  GROUPS: 'ReviewGroups',
  FLAGS: 'PartnerFlags',
  LOG: 'CommitLog'
};

const ROSTER_HEADERS = ['Period', 'First', 'Last', 'Email'];
const STUDENT_HEADERS = ['Email', 'First', 'Last', 'Period', 'Partner Email', 'Partner Name',
  'Start Date', 'End Date', 'Days', 'Status', 'CPT Met', 'Cards Done', 'Cards Total',
  'Last Updated', 'Board JSON'];
const GROUP_HEADERS = ['Group', 'First', 'Last', 'Email', 'Period', 'Reviews', 'Reviews', 'CPT Met'];
const LOG_HEADERS = ['Timestamp', 'Email', 'Name', 'Period', 'Type', 'Cards Done', 'Cards Total', 'CPT Met'];

const COLUMNS = ['pick', 'dev', 'test', 'review', 'deploy', 'done'];
const COLUMN_NAMES = { pick: 'Pick Me', dev: 'Dev', test: 'Test', review: 'Review', deploy: 'Deploy', done: 'Done' };
const REQS = [
  { id: 'input', short: 'Input', label: 'Takes input (user, device, data stream, or file)' },
  { id: 'output', short: 'Output', label: 'Produces output based on input and program functionality' },
  { id: 'list', short: 'List', label: 'Uses a list or other collection to manage complexity' },
  { id: 'procedure', short: 'Procedure', label: 'Student-developed procedure with at least one parameter' },
  { id: 'algorithm', short: 'Algorithm', label: 'Procedure uses sequencing, selection, and iteration' },
  { id: 'call', short: 'Procedure call', label: 'Calls the student-developed procedure' }
];
const REQ_IDS = REQS.map(r => r.id);
const ASSET_TYPES = ['Image', 'Data', 'Sound', 'Code', 'Other'];

// Made-up partners for the demo board, so real student names never show on the projector.
const DEMO_PARTNERS = [
  { key: 'demo-a', name: 'Sample Partner A' },
  { key: 'demo-b', name: 'Sample Partner B' },
  { key: 'demo-c', name: 'Sample Partner C' }
];

const PASSCODE_PROP = 'TEACHER_PASSCODE';
const MAX_PASSCODE_TRIES = 5;   // then locked for 10 minutes

/* ================================================================
 *  Web app endpoints
 * ================================================================ */

function doGet() {
  return json_({ ok: true, message: 'CSP Sprint Board API is running.' });
}

function doPost(e) {
  try {
    const req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    const email = normEmail_(req.email);

    if (String(req.action || '').indexOf('teacher') === 0) return json_(teacher_(email, req));

    if (!CONFIG.EMAIL_PATTERN.test(email)) {
      return json_({ ok: false, error: 'Use your school email: your 9-digit student ID followed by @lbschools.net.' });
    }
    const isDemo = email === normEmail_(CONFIG.DEMO_EMAIL);
    const roster = getRoster_();
    const onRoster = roster.find(r => r.email === email);
    if (!isDemo && CONFIG.REQUIRE_ROSTER && roster.length && !onRoster) {
      return json_({ ok: false, error: "That email isn't on the class roster. Double-check your 9 digits, then ask your teacher to add you." });
    }

    switch (req.action) {
      case 'load':
        return json_(load_(email, roster, onRoster, isDemo));
      case 'save':
        return json_(withLock_(() => save_(email, req, roster, {}, isDemo).result));
      case 'commit':
        return json_(withLock_(() => {
          const s = save_(email, req, roster, {}, isDemo);
          sendSnapshot_(s, 'Commit');
          return Object.assign(s.result, { sent: true });
        }));
      case 'finish':
        return json_(withLock_(() => {
          const s = save_(email, req, roster, { finish: true }, isDemo);
          sendSnapshot_(s, 'Finish');
          return Object.assign(s.result, { sent: true });
        }));
      default:
        return json_({ ok: false, error: 'Unknown action.' });
    }
  } catch (err) {
    return json_({ ok: false, error: String((err && err.message) || err) });
  }
}

function load_(email, roster, onRoster, isDemo) {
  const sh = sheet_(TABS.STUDENTS, STUDENT_HEADERS);
  const row = findRow_(sh, email);
  const prev = row > 0 ? readRow_(sh, row) : null;
  const hasRoster = roster.length > 0;
  const periods = periodsFrom_(roster);

  let student;
  if (prev) {
    student = {
      email: email,
      first: prev['First'],
      last: prev['Last'],
      period: String(prev['Period'] || ''),
      partner: partnerOut_(prev['Partner Email'], hasRoster, isDemo),
      partnerName: prev['Partner Name'] || ''
    };
  } else if (isDemo) {
    student = { email: email, first: 'Demo', last: 'Student', period: periods[0] || '', partner: '', partnerName: '' };
  } else {
    student = {
      email: email,
      first: onRoster ? onRoster.first : '',
      last: onRoster ? onRoster.last : '',
      period: onRoster ? onRoster.period : '',
      partner: '',
      partnerName: ''
    };
  }

  let board = null;
  if (prev && prev['Board JSON']) {
    try { board = sanitizeBoard_(JSON.parse(prev['Board JSON'])); } catch (e) { board = null; }
  }

  let classmates;
  if (isDemo) {
    classmates = DEMO_PARTNERS.map((p, i) => ({ key: p.key, name: p.name, period: periods[i % periods.length] }));
  } else {
    classmates = roster
      .filter(r => r.email !== email)
      .map(r => ({ key: keyFor_(r.email), name: r.first + ' ' + r.last, last: r.last, period: r.period }))
      .sort((a, b) => a.period.localeCompare(b.period, undefined, { numeric: true }) || a.last.localeCompare(b.last))
      .map(c => ({ key: c.key, name: c.name, period: c.period }));
  }

  return {
    ok: true,
    student: student,
    board: board,
    periods: periods,
    classmates: classmates,
    rosterMode: isDemo || hasRoster,
    demo: isDemo,
    dates: prev ? datesOut_(asDate_(prev['Start Date']), asDate_(prev['End Date'])) : datesOut_(null, null)
  };
}

function save_(email, req, roster, opts, isDemo) {
  const sh = sheet_(TABS.STUDENTS, STUDENT_HEADERS);
  const periods = periodsFrom_(roster);
  const hasRoster = roster.length > 0;
  const st = req.student || {};

  const first = clean_(st.first, 40);
  const last = clean_(st.last, 40);
  const period = String(st.period == null ? '' : st.period).trim();
  if (period && periods.indexOf(period) < 0) throw new Error('Choose your class period from the list.');
  const partner = resolvePartner_(st.partner, email, roster, isDemo);
  const board = sanitizeBoard_(req.board || {});

  const row = findRow_(sh, email);
  const prev = row > 0 ? readRow_(sh, row) : {};
  let start = asDate_(prev['Start Date']);
  let end = asDate_(prev['End Date']);

  const infoDone = !!(first && last && period && partner.email);
  const reasons = finishReasons_(board, infoDone);

  // Start date: stamped the first time the student has their info filled in AND a Sprint Goal.
  if (!start && infoDone && board.goals.length) start = new Date();
  // End date: cleared automatically if the board is no longer complete (e.g. a card left Done).
  if (end && reasons.length) end = null;

  if (opts.finish) {
    if (reasons.length) throw new Error('Not ready to finish yet. ' + reasons.join(' '));
    if (!end) end = new Date();
  }

  const met = cptMet_(board);
  const done = board.cards.filter(c => c.col === 'done').length;
  const d = datesOut_(start, end);

  const values = [
    email, first, last, period, partner.email, partner.name,
    start || '', end || '', d.days == null ? '' : d.days, d.status,
    met.length + ' of ' + REQS.length, done, board.cards.length,
    new Date(), JSON.stringify(board)
  ];
  if (row > 0) sh.getRange(row, 1, 1, values.length).setValues([values]);
  else sh.appendRow(values);

  return {
    result: {
      ok: true,
      student: {
        email: email, first: first, last: last, period: period,
        partner: partnerOut_(partner.email, hasRoster, isDemo),
        partnerName: partner.name
      },
      dates: d
    },
    student: { email: email, first: first, last: last, period: period, partnerEmail: partner.email, partnerName: partner.name },
    board: board,
    dates: d,
    demo: isDemo
  };
}

/* ================================================================
 *  Teacher view
 * ================================================================ */

function teacher_(email, req) {
  if (/CHANGE_ME/i.test(CONFIG.TEACHER_EMAIL)) {
    return { ok: false, error: 'The teacher view isn\'t set up yet. Set TEACHER_EMAIL in Code.gs, then redeploy.' };
  }
  if (email !== normEmail_(CONFIG.TEACHER_EMAIL)) {
    return { ok: false, error: "That email isn't set up as the teacher account for this board." };
  }
  const saved = PropertiesService.getScriptProperties().getProperty(PASSCODE_PROP);
  if (!saved) {
    return { ok: false, error: 'No teacher passcode yet. In the Sheet, choose CSP Sprint Board > Set teacher passcode.' };
  }
  const cache = CacheService.getScriptCache();
  const fails = Number(cache.get('teacherFails') || 0);
  if (fails >= MAX_PASSCODE_TRIES) {
    return { ok: false, error: 'Too many wrong passcodes. Wait 10 minutes, then try again.' };
  }
  if (String(req.code || '') !== saved) {
    cache.put('teacherFails', String(fails + 1), 600);
    return { ok: false, error: 'That passcode is wrong.' };
  }
  cache.remove('teacherFails');

  switch (req.action) {
    case 'teacherList':
      return teacherList_();
    case 'teacherBoard':
      return teacherBoard_(normEmail_(req.student));
    case 'teacherResetDemo':
      return withLock_(() => { deleteDemoRow_(); return { ok: true }; });
    default:
      return { ok: false, error: 'Unknown action.' };
  }
}

// Every roster student (opened a board or not), plus anyone with a board who isn't on the roster.
function teacherList_() {
  const roster = getRoster_();
  const rows = allStudents_();
  const byEmail = {};
  rows.forEach(r => { byEmail[normEmail_(r['Email'])] = r; });

  const out = [];
  const seen = {};
  roster.forEach(p => {
    seen[p.email] = true;
    out.push(summary_(p.email, byEmail[p.email], p));
  });
  rows.forEach(r => {
    const e = normEmail_(r['Email']);
    if (!seen[e]) { seen[e] = true; out.push(summary_(e, r, null)); }
  });

  const sh = sheet_(TABS.STUDENTS, STUDENT_HEADERS);
  const demoEmail = normEmail_(CONFIG.DEMO_EMAIL);
  const dr = findRow_(sh, demoEmail);
  return {
    ok: true,
    periods: periodsFrom_(roster),
    students: out,
    demo: dr > 0 ? summary_(demoEmail, readRow_(sh, dr), null) : null,
    demoEmail: demoEmail
  };
}

function summary_(email, r, p) {
  if (!r) {
    return {
      email: email, first: p ? p.first : '', last: p ? p.last : '', period: p ? p.period : '',
      partner: '', status: 'Not opened', start: null, end: null, days: null,
      cardsDone: 0, cardsTotal: 0, cpt: 0, retroDone: 0, retroTotal: 0, lastUpdated: null, opened: false, onRoster: !!p
    };
  }
  const board = boardFromRow_(r);
  const d = datesOut_(asDate_(r['Start Date']), asDate_(r['End Date']));
  const lu = asDate_(r['Last Updated']);
  const pe = r['Partner Email'];
  return {
    email: email,
    first: r['First'] || (p ? p.first : ''),
    last: r['Last'] || (p ? p.last : ''),
    period: String(r['Period'] || (p ? p.period : '')),
    partner: pe === 'none' ? 'Working solo' : (r['Partner Name'] || pe || ''),
    status: d.status,
    start: d.start, end: d.end, days: d.days,
    cardsDone: board.cards.filter(c => c.col === 'done').length,
    cardsTotal: board.cards.length,
    cpt: cptMet_(board).length,
    retroDone: board.retro.filter(r => r.done).length,
    retroTotal: board.retro.length,
    lastUpdated: lu ? lu.toISOString() : null,
    opened: true,
    onRoster: !!p
  };
}

function teacherBoard_(email) {
  const sh = sheet_(TABS.STUDENTS, STUDENT_HEADERS);
  const row = findRow_(sh, email);
  if (row < 0) throw new Error("That student hasn't opened a board yet.");
  const r = readRow_(sh, row);
  const pe = r['Partner Email'];
  return {
    ok: true,
    student: {
      email: email,
      first: r['First'],
      last: r['Last'],
      period: String(r['Period'] || ''),
      partner: pe === 'none' ? 'none' : (pe ? 'chosen' : ''),
      partnerName: r['Partner Name'] || (pe && pe !== 'none' ? pe : '')
    },
    board: boardFromRow_(r),
    dates: datesOut_(asDate_(r['Start Date']), asDate_(r['End Date']))
  };
}

function boardFromRow_(r) {
  try { return sanitizeBoard_(JSON.parse(r['Board JSON'] || '{}')); } catch (e) { return sanitizeBoard_({}); }
}

function deleteDemoRow_() {
  const sh = sheet_(TABS.STUDENTS, STUDENT_HEADERS);
  const row = findRow_(sh, normEmail_(CONFIG.DEMO_EMAIL));
  if (row > 0) sh.deleteRow(row);
  return row > 0;
}

/* ================================================================
 *  Board rules (mirror the rules in index.html)
 * ================================================================ */

function finishReasons_(b, infoDone) {
  const r = [];
  if (!infoDone) r.push('Fill in your info (name, period, partner).');
  if (!b.goals.length) r.push('Add at least one Sprint Goal.');
  const empty = b.goals.filter(g => !b.cards.some(c => c.goalId === g.id));
  if (empty.length) r.push('Give every goal at least one card.');
  if (!b.cards.length) r.push('Add at least one card.');
  const open = b.cards.filter(c => c.col !== 'done').length;
  if (open) r.push('Move ' + open + ' more card' + (open === 1 ? '' : 's') + ' to Done.');
  return r;
}

function cptMet_(b) {
  return REQ_IDS.filter(id => b.cards.some(c => c.req === id && c.col === 'done'));
}

function sanitizeBoard_(b) {
  const s = (x, n) => String(x == null ? '' : x).slice(0, n);
  const arr = x => (Array.isArray(x) ? x : []);
  const hex = c => (/^#[0-9a-f]{6}$/i.test(String(c)) ? String(c) : '#D9DEE4');
  return {
    sprint: s(b.sprint, 60) || 'Sprint 1',
    goals: arr(b.goals).slice(0, 6).map(g => ({ id: s(g.id, 24), text: s(g.text, 160), color: hex(g.color) })),
    cards: arr(b.cards).slice(0, 100).map(c => ({
      id: s(c.id, 24),
      text: s(c.text, 200),
      goalId: s(c.goalId, 24),
      req: REQ_IDS.indexOf(c.req) >= 0 ? c.req : '',
      col: COLUMNS.indexOf(c.col) >= 0 ? c.col : 'pick',
      seed: !!c.seed
    })),
    retro: arr(b.retro).slice(0, 30).map(r => ({ id: s(r.id, 24), text: s(r.text, 200), done: !!r.done })),
    assets: arr(b.assets).slice(0, 40).map(a => ({
      id: s(a.id, 24),
      type: ASSET_TYPES.indexOf(a.type) >= 0 ? a.type : 'Other',
      desc: s(a.desc, 200),
      source: s(a.source, 300)
    }))
  };
}

/* ================================================================
 *  Emails
 * ================================================================ */

function sendSnapshot_(s, type) {
  if (/CHANGE_ME/i.test(CONFIG.TEACHER_EMAIL)) {
    throw new Error("Your board saved, but the teacher email isn't set up yet, so no update was sent. Let your teacher know.");
  }
  const st = s.student;
  const name = (st.first + ' ' + st.last).trim() || st.email;
  const mail = {
    to: CONFIG.TEACHER_EMAIL,
    subject: s.demo
      ? '[CSP Sprint] DEMO ' + (type === 'Finish' ? 'finished' : 'update')
      : (type === 'Finish' ? '[CSP Sprint] FINISHED: ' : '[CSP Sprint] Update: ') + name + ' (Period ' + st.period + ')',
    htmlBody: snapshotHtml_(st, s.board, s.dates, type)
  };
  // The demo account isn't a real mailbox, so it is never CC'd and never logged.
  if (!s.demo) { mail.cc = st.email; mail.replyTo = st.email; }
  MailApp.sendEmail(mail);
  if (s.demo) return;

  const log = sheet_(TABS.LOG, LOG_HEADERS);
  log.appendRow([new Date(), st.email, name, st.period, type,
    s.board.cards.filter(c => c.col === 'done').length, s.board.cards.length,
    cptMet_(s.board).length + ' of ' + REQS.length]);
}

function snapshotHtml_(st, b, d, type) {
  const e = esc_;
  const fmt = x => (x ? Utilities.formatDate(new Date(x), Session.getScriptTimeZone(), 'MMM d, yyyy') : '—');
  const goalOf = id => b.goals.find(g => g.id === id);
  const met = cptMet_(b);
  let h = '<div style="font-family:Arial,sans-serif;color:#1F2A37;max-width:760px">';
  h += '<h2 style="margin:0 0 4px">' + e(st.first + ' ' + st.last) + ', Period ' + e(st.period) + '</h2>';
  h += '<p style="margin:0 0 12px;color:#5B6776">' + e(b.sprint) + ' &nbsp;|&nbsp; Partner: ' +
    e(st.partnerEmail === 'none' ? 'Working solo' : (st.partnerName || st.partnerEmail)) + '</p>';
  h += '<p><b>Started:</b> ' + fmt(d.start) + ' &nbsp; <b>Finished:</b> ' + fmt(d.end) +
    ' &nbsp; <b>Days on sprint:</b> ' + (d.days == null ? '—' : d.days) + ' &nbsp; <b>Status:</b> ' + e(d.status) + '</p>';

  h += '<h3 style="margin:16px 0 6px">Sprint Goals</h3><ul>';
  b.goals.forEach(g => {
    const cs = b.cards.filter(c => c.goalId === g.id);
    const dn = cs.filter(c => c.col === 'done').length;
    h += '<li><span style="display:inline-block;width:12px;height:12px;background:' + g.color +
      ';border-radius:2px;margin-right:6px"></span>' + e(g.text) + ' <span style="color:#5B6776">(' + dn + ' of ' + cs.length + ' done)</span></li>';
  });
  h += '</ul>';

  h += '<h3 style="margin:16px 0 6px">Board</h3><table cellpadding="6" style="border-collapse:collapse;width:100%;font-size:13px">';
  COLUMNS.forEach(col => {
    const cs = b.cards.filter(c => c.col === col);
    h += '<tr><td style="vertical-align:top;border-top:1px solid #C9D1DA;width:90px"><b>' + COLUMN_NAMES[col] + '</b> (' + cs.length + ')</td><td style="border-top:1px solid #C9D1DA">';
    h += cs.map(c => {
      const g = goalOf(c.goalId);
      const req = REQS.find(r => r.id === c.req);
      return '<span style="display:inline-block;margin:2px 4px 2px 0;padding:3px 6px;background:' + (g ? g.color : '#D9DEE4') +
        ';border-radius:3px">' + e(c.text) + (req ? ' <i>[' + req.short + ']</i>' : '') + '</span>';
    }).join('') || '<span style="color:#5B6776">—</span>';
    h += '</td></tr>';
  });
  h += '</table>';

  h += '<h3 style="margin:16px 0 6px">Create PT checklist (' + met.length + ' of ' + REQS.length + ')</h3><ul>';
  REQS.forEach(r => { h += '<li>' + (met.indexOf(r.id) >= 0 ? '&#10003; ' : '&#9675; ') + e(r.label) + '</li>'; });
  h += '</ul>';

  if (b.retro.length) {
    h += '<h3 style="margin:16px 0 6px">Retro Actions (' + b.retro.filter(r => r.done).length + ' of ' + b.retro.length + ' done)</h3><ul>';
    b.retro.forEach(r => { h += '<li>' + (r.done ? '<s>' + e(r.text) + '</s>' : e(r.text)) + '</li>'; });
    h += '</ul>';
  }
  if (b.assets.length) {
    h += '<h3 style="margin:16px 0 6px">Assets &amp; Sources</h3><ul>';
    b.assets.forEach(a => { h += '<li><b>' + e(a.type) + ':</b> ' + e(a.desc) + ' — <i>' + e(a.source || 'no source listed') + '</i></li>'; });
    h += '</ul>';
  }
  if (CONFIG.BOARD_URL) h += '<p><a href="' + e(CONFIG.BOARD_URL) + '">Open the sprint board</a></p>';
  h += '</div>';
  return h;
}

/* ================================================================
 *  Teacher menu
 * ================================================================ */

function onOpen() {
  SpreadsheetApp.getUi().createMenu('CSP Sprint Board')
    .addItem('Set up tabs', 'setupSheets')
    .addItem('Set teacher passcode', 'setTeacherPasscode')
    .addSeparator()
    .addItem('Check partners', 'checkPartners')
    .addItem('Make review groups', 'makeReviewGroups')
    .addItem('Export groups for Canvas', 'exportCanvasCsv')
    .addSeparator()
    .addItem('Reset demo board', 'resetDemoBoard')
    .addToUi();
}

function setupSheets() {
  sheet_(TABS.ROSTER, ROSTER_HEADERS);
  const st = sheet_(TABS.STUDENTS, STUDENT_HEADERS);
  st.getRange('G:H').setNumberFormat('yyyy-mm-dd');
  st.getRange('N:N').setNumberFormat('yyyy-mm-dd h:mm');
  sheet_(TABS.LOG, LOG_HEADERS);
  SpreadsheetApp.getUi().alert(
    'Tabs are ready.\n\nNext: paste both classes into the Roster tab (Period, First, Last, Email). ' +
    'Emails must be the 9-digit ID + @lbschools.net.\n\n' +
    'Then choose CSP Sprint Board > Set teacher passcode to turn on the teacher view.');
}

function setTeacherPasscode() {
  const ui = SpreadsheetApp.getUi();
  const r = ui.prompt('Set teacher passcode',
    'Choose a passcode for the teacher view, at least 6 characters. ' +
    'You type it on the board after your email (' + CONFIG.TEACHER_EMAIL + ').',
    ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return;
  const v = r.getResponseText().trim();
  if (v.length < 6) { ui.alert('Use at least 6 characters. The passcode was not changed.'); return; }
  PropertiesService.getScriptProperties().setProperty(PASSCODE_PROP, v);
  CacheService.getScriptCache().remove('teacherFails');
  ui.alert('Passcode saved. On the board, type ' + CONFIG.TEACHER_EMAIL + ', then this passcode.');
}

function resetDemoBoard() {
  const ui = SpreadsheetApp.getUi();
  const resp = ui.alert('Reset demo board', 'Delete everything on the demo board (' + CONFIG.DEMO_EMAIL + ')?', ui.ButtonSet.YES_NO);
  if (resp !== ui.Button.YES) return;
  const removed = withLock_(() => deleteDemoRow_());
  ui.alert(removed ? 'Demo board cleared.' : 'The demo board was already empty.');
}

function checkPartners() {
  const rows = allStudents_();
  const byEmail = {};
  rows.forEach(r => { byEmail[r['Email']] = r; });
  const flags = [];
  rows.forEach(r => {
    const p = r['Partner Email'];
    const name = r['First'] + ' ' + r['Last'];
    if (!p) { flags.push([name, r['Email'], r['Period'], '', 'No partner chosen yet']); return; }
    if (p === 'none') return;
    const q = byEmail[p];
    if (!q) flags.push([name, r['Email'], r['Period'], p, "Partner hasn't opened a board yet"]);
    else if (q['Partner Email'] !== r['Email']) {
      flags.push([name, r['Email'], r['Period'], p,
        'Partner listed ' + (q['Partner Email'] === 'none' ? 'no partner' : (q['Partner Email'] || 'nobody yet'))]);
    }
  });
  const sh = resetSheet_(TABS.FLAGS, ['Student', 'Email', 'Period', 'Partner Email', 'Issue']);
  if (flags.length) sh.getRange(2, 1, flags.length, 5).setValues(flags);
  SpreadsheetApp.getUi().alert(flags.length
    ? flags.length + ' partner issue(s) found. See the ' + TABS.FLAGS + ' tab.'
    : 'All partners match.');
}

function makeReviewGroups() {
  const ui = SpreadsheetApp.getUi();
  const resp = ui.alert('Make review groups',
    'Group only students who have FINISHED their sprint?\n\nYes = finished only\nNo = everyone who has started',
    ui.ButtonSet.YES_NO_CANCEL);
  if (resp === ui.Button.CANCEL || resp === ui.Button.CLOSE) return;

  const pool = allStudents_().filter(r => (resp === ui.Button.YES ? r['End Date'] : r['Start Date']));
  if (pool.length < 3) { ui.alert('Need at least 3 students to make groups. Found ' + pool.length + '.'); return; }

  const people = pool.map(r => {
    let met = [];
    try { met = cptMet_(sanitizeBoard_(JSON.parse(r['Board JSON'] || '{}'))); } catch (e) { met = []; }
    return { email: r['Email'], first: r['First'], last: r['Last'], period: String(r['Period']), partner: r['Partner Email'], met: met };
  });
  const allPeriods = {};
  people.forEach(p => { allPeriods[p.period] = true; });
  const multiPeriod = Object.keys(allPeriods).length > 1;
  const sizes = groupSizes_(people.length);

  let best = null;
  for (let t = 0; t < 5000; t++) {
    const order = shuffle_(people.slice());
    const groups = [];
    let i = 0;
    sizes.forEach(n => { groups.push(order.slice(i, i + n)); i += n; });
    const sc = scoreGroups_(groups, multiPeriod);
    if (!best || sc < best.score) best = { score: sc, groups: groups };
    if (sc === 0) break;
  }
  best = improveGroups_(best.groups, multiPeriod);

  const out = [];
  best.groups.forEach((g, gi) => {
    const label = 'CPT Review ' + String(gi + 1).padStart(2, '0');
    const k = g.length;
    g.forEach((p, i) => {
      const a = g[(i + 1) % k];
      const b = k > 2 ? g[(i + 2) % k] : null;
      out.push([label, p.first, p.last, p.email, p.period,
        a.first + ' ' + a.last, b ? b.first + ' ' + b.last : '', p.met.length + ' of ' + REQS.length]);
    });
  });

  const sh = resetSheet_(TABS.GROUPS, GROUP_HEADERS);
  sh.getRange(2, 1, out.length, GROUP_HEADERS.length).setValues(out);
  let r = 2;
  best.groups.forEach((g, gi) => {
    sh.getRange(r, 1, g.length, GROUP_HEADERS.length).setBackground(gi % 2 ? '#FFFFFF' : '#EEF1F4');
    r += g.length;
  });

  const partnerClash = best.score >= 1000;
  ui.alert('Made ' + best.groups.length + ' groups from ' + people.length + ' students.' +
    (partnerClash ? '\n\nHeads up: at least one group has partners together. Swap them by hand in the Group column.' : '') +
    '\n\nYou can edit the Group column by hand, then run "Export groups for Canvas".');
}

function exportCanvasCsv() {
  const ui = SpreadsheetApp.getUi();
  const sh = SpreadsheetApp.getActive().getSheetByName(TABS.GROUPS);
  if (!sh || sh.getLastRow() < 2) { ui.alert('Run "Make review groups" first.'); return; }
  const demo = normEmail_(CONFIG.DEMO_EMAIL);
  const rows = sh.getRange(2, 1, sh.getLastRow() - 1, 5).getValues()
    .filter(r => r[0] && r[3] && normEmail_(r[3]) !== demo);
  const q = v => '"' + String(v).replace(/"/g, '""') + '"';
  const idOf = email => (CONFIG.CANVAS_ID_VALUE === 'digits' ? String(email).split('@')[0] : String(email));
  const lines = ['name,' + CONFIG.CANVAS_ID_COLUMN + ',group_name'];
  rows.forEach(r => lines.push([q(r[1] + ' ' + r[2]), q(idOf(r[3])), q(r[0])].join(',')));
  const stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  const file = DriveApp.createFile('CSP review groups - Canvas import ' + stamp + '.csv', lines.join('\n'), MimeType.CSV);
  const html = HtmlService.createHtmlOutput(
    '<p style="font-family:Arial">Saved ' + rows.length + ' students to your Google Drive.</p>' +
    '<p style="font-family:Arial"><a href="' + file.getUrl() + '" target="_blank">Open the CSV</a>, then File &gt; Download.</p>'
  ).setWidth(380).setHeight(140);
  ui.showModalDialog(html, 'Canvas export ready');
}

/* ================================================================
 *  Grouping helpers
 * ================================================================ */

function groupSizes_(n) {
  if (n <= 5) return [n];
  const g = Math.floor(n / 3), r = n % 3;
  const sizes = [];
  for (let i = 0; i < g; i++) sizes.push(3);
  for (let i = 0; i < r; i++) sizes[i]++;   // leftovers make groups of 4
  return sizes;
}

function scoreGroups_(groups, multiPeriod) {
  let score = 0;
  groups.forEach(g => {
    const emails = g.map(p => p.email);
    // Partners must never review each other's projects.
    g.forEach(p => { if (p.partner && p.partner !== 'none' && emails.indexOf(p.partner) >= 0) score += 1000; });
    // Mix the two classes when possible.
    if (multiPeriod) {
      const ps = {};
      g.forEach(p => { ps[p.period] = true; });
      if (Object.keys(ps).length < 2) score += 40;
    }
    // Together the group should cover as much of the Create PT checklist as possible.
    const union = {};
    g.forEach(p => p.met.forEach(m => { union[m] = true; }));
    score += (REQS.length - Object.keys(union).length) * 6;
  });
  return score;
}

// Try swapping students between groups; keep any swap that lowers the score.
function improveGroups_(groups, multiPeriod) {
  let score = scoreGroups_(groups, multiPeriod);
  let improved = true, passes = 0;
  while (improved && score > 0 && passes < 20) {
    improved = false; passes++;
    for (let a = 0; a < groups.length; a++) {
      for (let b = a + 1; b < groups.length; b++) {
        for (let i = 0; i < groups[a].length; i++) {
          for (let j = 0; j < groups[b].length; j++) {
            const t = groups[a][i]; groups[a][i] = groups[b][j]; groups[b][j] = t;
            const s = scoreGroups_(groups, multiPeriod);
            if (s < score) { score = s; improved = true; }
            else { groups[b][j] = groups[a][i]; groups[a][i] = t; }
          }
        }
      }
    }
  }
  return { score: score, groups: groups };
}

function shuffle_(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

/* ================================================================
 *  Sheet + utility helpers
 * ================================================================ */

function getRoster_() {
  const sh = SpreadsheetApp.getActive().getSheetByName(TABS.ROSTER);
  if (!sh || sh.getLastRow() < 2) return [];
  const demo = normEmail_(CONFIG.DEMO_EMAIL);
  return sh.getRange(2, 1, sh.getLastRow() - 1, 4).getValues()
    .map(r => ({ period: String(r[0]).trim(), first: String(r[1]).trim(), last: String(r[2]).trim(), email: normEmail_(r[3]) }))
    .filter(r => CONFIG.EMAIL_PATTERN.test(r.email) && r.email !== demo);
}

function periodsFrom_(roster) {
  if (!roster.length) return CONFIG.FALLBACK_PERIODS.slice();
  const seen = {};
  roster.forEach(r => { if (r.period) seen[r.period] = true; });
  return Object.keys(seen).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

function resolvePartner_(value, email, roster, isDemo) {
  const v = String(value == null ? '' : value).trim();
  if (v === 'none') return { email: 'none', name: '' };
  if (!v) return { email: '', name: '' };
  if (isDemo) {
    const d = DEMO_PARTNERS.find(p => p.key === v);
    if (!d) throw new Error('Choose a partner from the list.');
    return { email: d.key, name: d.name };
  }
  if (roster.length) {
    const m = roster.find(r => keyFor_(r.email) === v);
    if (!m) throw new Error('Choose your partner from the list.');
    if (m.email === email) throw new Error("You can't pick yourself as your partner.");
    return { email: m.email, name: m.first + ' ' + m.last };
  }
  const pe = normEmail_(v);
  if (!CONFIG.EMAIL_PATTERN.test(pe)) throw new Error("Your partner's email must be their 9-digit student ID followed by @lbschools.net.");
  if (pe === email) throw new Error("You can't pick yourself as your partner.");
  return { email: pe, name: '' };
}

// What the page gets back for the partner field.
function partnerOut_(partnerEmail, hasRoster, isDemo) {
  if (!partnerEmail) return '';
  if (partnerEmail === 'none') return 'none';
  if (isDemo) return partnerEmail;            // demo partners are stored by their sample key
  return hasRoster ? keyFor_(partnerEmail) : partnerEmail;
}

// Opaque key so the page never receives classmates' email addresses.
function keyFor_(email) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, 'csp-board:' + email);
  return Utilities.base64EncodeWebSafe(bytes).slice(0, 16);
}

function datesOut_(start, end) {
  const days = start ? daysBetween_(start, end || new Date()) : null;
  return {
    start: start ? start.toISOString() : null,
    end: end ? end.toISOString() : null,
    days: days,
    status: !start ? 'Not started' : (end ? 'Finished' : 'In progress')
  };
}

// Calendar days, counting both the start day and the end day.
function daysBetween_(a, b) {
  const d0 = new Date(a.getFullYear(), a.getMonth(), a.getDate());
  const d1 = new Date(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.round((d1 - d0) / 86400000) + 1;
}

// Real students only: the demo board is left out of partners, groups, and exports.
function allStudents_() {
  const sh = sheet_(TABS.STUDENTS, STUDENT_HEADERS);
  if (sh.getLastRow() < 2) return [];
  const demo = normEmail_(CONFIG.DEMO_EMAIL);
  return sh.getRange(2, 1, sh.getLastRow() - 1, STUDENT_HEADERS.length).getValues()
    .filter(r => r[0] && normEmail_(r[0]) !== demo)
    .map(r => { const o = {}; STUDENT_HEADERS.forEach((h, i) => { o[h] = r[i]; }); return o; });
}

function sheet_(name, headers) {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

function resetSheet_(name, headers) {
  const sh = sheet_(name, headers);
  sh.clear();
  sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
  sh.setFrozenRows(1);
  return sh;
}

function findRow_(sh, email) {
  const n = sh.getLastRow() - 1;
  if (n < 1) return -1;
  const col = sh.getRange(2, 1, n, 1).getValues();
  for (let i = 0; i < n; i++) if (normEmail_(col[i][0]) === email) return i + 2;
  return -1;
}

function readRow_(sh, row) {
  const v = sh.getRange(row, 1, 1, STUDENT_HEADERS.length).getValues()[0];
  const o = {};
  STUDENT_HEADERS.forEach((h, i) => { o[h] = v[i]; });
  return o;
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try { return fn(); } finally { lock.releaseLock(); }
}

function asDate_(v) { return v instanceof Date && !isNaN(v) ? v : null; }
function normEmail_(e) { return String(e == null ? '' : e).trim().toLowerCase(); }
function clean_(v, n) { return String(v == null ? '' : v).trim().replace(/\s+/g, ' ').slice(0, n); }
function esc_(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
