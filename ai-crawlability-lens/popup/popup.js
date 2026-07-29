/**
 * popup/popup.js
 *
 * The orchestrator and the UI.
 *
 * ES module. Owns three things the other contexts cannot:
 *   1. The USER GESTURE, which `chrome.permissions.request()` requires.
 *      Service workers have no gesture context; a popup click handler does.
 *   2. `chrome.scripting` injection of the content-side engine.
 *   3. Rendering, export and history.
 *
 * Flow of one check:
 *   click -> permissions.request(origin)  [gesture-critical, first statement]
 *         -> executeScript(engine + content, isolated world)
 *         -> executeScript(framework-detect, MAIN world)
 *         -> tabs.sendMessage(AICL_RUN) -> content orchestrates -> analysis
 *         -> render + persist history summary
 */

import { getHistory, addHistoryEntry, clearHistory } from '../shared/storage.js';
import { downloadReport } from '../shared/report.js';
import { getFrameworkFix } from '../data/framework-fixes.js';
import { BOTS } from '../data/bot-user-agents.js';

/**
 * Injected in this order. html-extractor must precede everything that uses it;
 * main.js must be last because it wires the message listener.
 */
const CONTENT_FILES = [
  'engine/html-extractor.js',
  'engine/diff.js',
  'engine/cloaking.js',
  'engine/verdict.js',
  'content/capture-blocks.js',
  'content/overlay.js',
  'content/main.js'
];

const el = (id) => document.getElementById(id);

const ui = {
  pageUrl: el('pageUrl'),
  launch: el('launch'),
  checkBtn: el('checkBtn'),
  launchHint: el('launchHint'),
  permissionNotice: el('permissionNotice'),
  errorNotice: el('errorNotice'),
  progress: el('progress'),
  barFill: el('barFill'),
  progressLabel: el('progressLabel'),
  results: el('results'),
  banners: el('banners'),
  botRows: el('botRows'),
  botTabs: el('botTabs'),
  botDetail: el('botDetail'),
  overlayBtn: el('overlayBtn'),
  frameworkCard: el('frameworkCard'),
  exportBtn: el('exportBtn'),
  recheckBtn: el('recheckBtn'),
  historyList: el('historyList'),
  clearHistoryBtn: el('clearHistoryBtn'),
  revokeBtn: el('revokeBtn'),
  fetchCount: el('fetchCount')
};

const state = {
  tabId: null,
  url: null,
  origin: null,
  checkable: false,
  running: false,
  result: null,
  framework: null,
  selectedBotId: null,
  overlayVisible: false
};

/* -------------------------------------------------------------------------- */
/* Init                                                                        */
/* -------------------------------------------------------------------------- */

init().catch((err) => showError(String((err && err.message) || err)));

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab) {
    disableWith('No active tab to check.');
    await renderHistory();
    return;
  }

  if (!tab.url) {
    // Chrome only exposes `tab.url` once the extension has access to that tab.
    // Clicking the toolbar icon grants `activeTab`, which is the normal path —
    // so this branch means the popup was opened some other way (as a tab, or
    // from a context where the grant did not apply).
    disableWith(
      'Chrome did not share this tab’s address. Open AI Crawlability Lens from the toolbar icon ' +
        'while viewing a normal http or https page.'
    );
    await renderHistory();
    return;
  }

  state.tabId = tab.id;
  state.url = tab.url;
  ui.pageUrl.textContent = tab.url;
  ui.pageUrl.title = tab.url;

  let parsed;
  try {
    parsed = new URL(tab.url);
  } catch {
    disableWith('This tab has no checkable address.');
    await renderHistory();
    return;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    // chrome://, file://, the Web Store, the PDF viewer: none of these can be
    // scripted or fetched. Saying so beats failing opaquely.
    disableWith(
      `Only http and https pages can be checked. This tab is a ${parsed.protocol.replace(':', '')} page.`
    );
    await renderHistory();
    return;
  }

  state.origin = parsed.origin;
  state.checkable = true;
  if (ui.fetchCount) ui.fetchCount.textContent = fetchCountPhrase();

  const granted = await chrome.permissions.contains({ origins: [`${state.origin}/*`] });
  ui.revokeBtn.classList.toggle('hidden', !granted);
  if (granted) {
    ui.launchHint.textContent =
      `Access to this site is already granted. ${fetchCountPhrase()} and compares the raw HTML they ` +
      'receive against what you can see. Keep this popup open while it runs.';
  }

  wireEvents();
  await renderHistory();
}

/**
 * The number of fetches is the number of bots, so it has to come from the bot
 * list. It was hard-coded as "six", and adding three crawlers left the UI
 * confidently stating the wrong number — caught only because it appeared in a
 * store screenshot.
 *
 * @returns {string}
 */
function fetchCountPhrase() {
  return `Fetches this page ${BOTS.length} times — once as each crawler —`;
}

function wireEvents() {
  ui.checkBtn.addEventListener('click', onCheckClick);
  ui.recheckBtn.addEventListener('click', onCheckClick);
  ui.overlayBtn.addEventListener('click', onOverlayToggle);
  ui.exportBtn.addEventListener('click', onExport);
  ui.clearHistoryBtn.addEventListener('click', onClearHistory);
  ui.revokeBtn.addEventListener('click', onRevoke);

  chrome.runtime.onMessage.addListener((message) => {
    if (message && message.type === 'AICL_PROGRESS') onProgress(message);
  });
}

function disableWith(message) {
  ui.checkBtn.disabled = true;
  ui.launchHint.textContent = message;
}

/* -------------------------------------------------------------------------- */
/* Run                                                                         */
/* -------------------------------------------------------------------------- */

async function onCheckClick() {
  if (!state.checkable || state.running) return;

  // GESTURE-CRITICAL. `chrome.permissions.request()` must be the first thing
  // this handler does: any `await` before it drops the user-gesture context and
  // Chrome rejects the request outright.
  const requestPromise = chrome.permissions.request({ origins: [`${state.origin}/*`] });

  hide(ui.permissionNotice);
  hide(ui.errorNotice);

  let granted = false;
  try {
    granted = await requestPromise;
  } catch (err) {
    showError(`Permission request failed: ${String((err && err.message) || err)}`);
    return;
  }

  if (!granted) {
    ui.permissionNotice.innerHTML =
      '<strong>Access not granted</strong>AI Crawlability Lens needs permission to fetch this page as ' +
      'different bots — grant access to check this site, or it stays inactive here.';
    show(ui.permissionNotice);
    return;
  }

  ui.revokeBtn.classList.remove('hidden');
  await runCheck();
}

async function runCheck() {
  state.running = true;
  state.result = null;
  state.framework = null;
  state.overlayVisible = false;

  ui.checkBtn.disabled = true;
  ui.recheckBtn.disabled = true;
  hide(ui.results);
  hide(ui.errorNotice);
  show(ui.progress);
  setProgress(0, 'Injecting analysis engine…');

  try {
    // 1. Inject the isolated-world engine. Repeat injections are safe:
    //    content/main.js guards its listener registration.
    await chrome.scripting.executeScript({
      target: { tabId: state.tabId },
      files: CONTENT_FILES
    });

    // 2. Framework detection, MAIN world. It needs the PAGE's window object —
    //    `window.__NEXT_DATA__` and friends do not exist in the isolated world,
    //    so from there every SSR framework would look like an unknown SPA.
    setProgress(5, 'Detecting framework…');
    try {
      const [frameworkResult] = await chrome.scripting.executeScript({
        target: { tabId: state.tabId },
        files: ['content/framework-detect.js'],
        world: 'MAIN'
      });
      state.framework = (frameworkResult && frameworkResult.result) || null;
    } catch {
      // A strict page CSP or an unusual document can block MAIN-world
      // injection. Losing the recommendation bucket must not fail the check.
      state.framework = null;
    }

    // 3. Hand control to the page. It fetches via the worker, extracts, diffs.
    setProgress(10, 'Fetching robots.txt…');
    const response = await chrome.tabs.sendMessage(state.tabId, {
      type: 'AICL_RUN',
      url: state.url
    });

    if (!response || !response.ok) {
      throw new Error((response && response.error) || 'The page did not return a result.');
    }

    state.result = response.result;
    state.selectedBotId = state.result.defaultBotId || state.result.order[0];

    setProgress(100, 'Done.');
    hide(ui.progress);
    renderResults();
    await addHistoryEntry(state.result);
    await renderHistory();
  } catch (err) {
    hide(ui.progress);
    showError(explainRunError(err));
  } finally {
    state.running = false;
    ui.checkBtn.disabled = false;
    ui.recheckBtn.disabled = false;
  }
}

function onProgress(message) {
  const total = message.total || 1;
  // Reserve the first 10% for injection and detection.
  const pct = 10 + Math.round((message.completed / total) * 88);
  setProgress(pct, message.label || 'Working…');
}

function setProgress(pct, label) {
  ui.barFill.style.width = `${Math.max(0, Math.min(100, pct))}%`;
  ui.progressLabel.textContent = label;
}

/**
 * @param {unknown} err
 * @returns {string}
 */
function explainRunError(err) {
  const msg = String((err && err.message) || err);

  if (msg.includes('PERMISSION_MISSING')) {
    return 'Access to this site was revoked before the check finished. Click Check again to re-grant it.';
  }
  if (/Could not establish connection|Receiving end does not exist/i.test(msg)) {
    return (
      'The analysis engine could not run on this page. Chrome blocks extension scripts on its own ' +
      'pages, the Web Store, the PDF viewer, and some sites with a very strict Content-Security-Policy.'
    );
  }
  if (/Cannot access contents of|extension manifest/i.test(msg)) {
    return 'Chrome would not allow scripting on this page. It is likely a restricted or internal URL.';
  }
  return msg;
}

/* -------------------------------------------------------------------------- */
/* Rendering                                                                   */
/* -------------------------------------------------------------------------- */

function renderResults() {
  renderBanners();
  renderBotTable();
  renderBotTabs();
  renderBotDetail();
  renderFramework();
  ui.overlayBtn.textContent = 'Highlight invisible content on the page';
  show(ui.results);
}

function renderBanners() {
  const r = state.result;
  ui.banners.textContent = '';

  // The answer first. Everything below this is the evidence for it.
  if (r.pageVerdict) {
    const v = document.createElement('div');
    v.className = `page-verdict ${r.pageVerdict.severity}`;
    const kicker = document.createElement('span');
    kicker.className = 'kicker';
    kicker.textContent = 'Verdict';
    const b = document.createElement('b');
    b.textContent = r.pageVerdict.headline;
    const p = document.createElement('p');
    p.textContent = r.pageVerdict.detail;
    v.append(kicker, b, p);
    ui.banners.appendChild(v);
  }

  const blockedBots = r.order.map((id) => r.perBot[id]).filter((b) => b && b.robotsBlocked);
  const blockedTokens = Object.values(r.robots.tokenVerdicts || {}).filter((t) => t && !t.allowed);
  const serverBlocked = r.order.map((id) => r.perBot[id]).filter((b) => b && b.status === 'blocked');

  // robots.txt first and loudest: it overrides everything below it. A bot
  // disallowed here never requests the page at all, so its Visibility Score is
  // an academic number about content it will never fetch.
  if (blockedBots.length) {
    ui.banners.appendChild(
      banner(
        'critical',
        'CRITICAL — blocked in robots.txt',
        `${blockedBots.map((b) => b.label).join(', ')} ${blockedBots.length === 1 ? 'is' : 'are'} ` +
          'disallowed from this page and will never request it. Rendering is irrelevant for ' +
          `${blockedBots.length === 1 ? 'this bot' : 'these bots'}.`,
        blockedBots.map((b) => `${b.label} — ${b.robotsRule || 'disallowed'}`)
      )
    );
  }

  if (blockedTokens.length) {
    ui.banners.appendChild(
      banner(
        'critical',
        'CRITICAL — AI-specific robots.txt tokens disallowed',
        blockedTokens.some((t) => t.id === 'google-extended')
          ? 'Google-Extended is not Googlebot. It controls whether Google may use your content for ' +
              'Gemini and Vertex AI grounding — allowing Googlebot does not allow it.'
          : 'One or more AI-specific crawler tokens are disallowed.',
        blockedTokens.map((t) => `${t.label} — ${t.matchedRule || 'disallowed'}`)
      )
    );
  }

  if (serverBlocked.length) {
    ui.banners.appendChild(
      banner(
        'critical',
        'Server-level bot blocking',
        `The server refused ${serverBlocked
          .map((b) => `${b.label} (HTTP ${b.httpStatus})`)
          .join(', ')}. This is separate from a low score — these bots received no content at all.`
      )
    );
  }

  if (r.robots.state === 'unreachable' || r.robots.state === 'unknown') {
    ui.banners.appendChild(
      banner(
        'info',
        'robots.txt could not be read reliably',
        r.robots.fetchError
          ? `Fetch failed: ${r.robots.fetchError}`
          : `robots.txt returned HTTP ${r.robots.httpStatus}. A 5xx is ambiguous — conservative crawlers treat it as disallow-all.`
      )
    );
  }

  if (r.cloaking) {
    ui.banners.appendChild(
      banner(r.cloaking.detected ? 'info' : 'good', r.cloaking.headline, r.cloaking.detail)
    );
  }
}

/**
 * @param {'critical'|'info'|'good'} kind
 * @param {string} title
 * @param {string} body
 * @param {string[]} [items]
 */
function banner(kind, title, body, items) {
  const div = document.createElement('div');
  div.className = `banner ${kind}`;

  const strong = document.createElement('strong');
  strong.textContent = title;
  div.appendChild(strong);
  div.appendChild(document.createTextNode(body));

  if (items && items.length) {
    const ul = document.createElement('ul');
    for (const item of items) {
      const li = document.createElement('li');
      li.textContent = item;
      ul.appendChild(li);
    }
    div.appendChild(ul);
  }
  return div;
}

function renderBotTable() {
  const r = state.result;
  ui.botRows.textContent = '';

  for (const id of r.order) {
    const b = r.perBot[id];
    if (!b) continue;

    const tr = document.createElement('tr');

    // Bot name
    const tdName = document.createElement('td');
    const name = document.createElement('span');
    name.className = 'bot-name';
    name.textContent = b.label;
    const sub = document.createElement('span');
    sub.className = 'bot-sub';
    sub.textContent = b.executesJs ? 'renders JavaScript' : 'raw HTML only';
    tdName.append(name, sub);

    // robots.txt
    const tdRobots = document.createElement('td');
    tdRobots.appendChild(
      pill(b.robotsBlocked ? 'red' : 'green', b.robotsBlocked ? 'Disallowed' : 'Allowed')
    );

    // Fetch
    const tdFetch = document.createElement('td');
    if (b.status === 'ok') tdFetch.appendChild(pill('green', `OK ${b.httpStatus}`));
    else if (b.status === 'blocked') tdFetch.appendChild(pill('red', `Blocked ${b.httpStatus}`));
    else tdFetch.appendChild(pill('amber', b.httpStatus ? `Error ${b.httpStatus}` : 'Error'));

    // Score
    const tdScore = document.createElement('td');
    tdScore.className = 'num';
    tdScore.appendChild(
      b.scoreMeaningful && typeof b.score === 'number'
        ? pill(b.band, String(b.score))
        : pill('none', 'n/a')
    );

    tr.append(tdName, tdRobots, tdFetch, tdScore);
    ui.botRows.appendChild(tr);
  }
}

function pill(kind, text) {
  const span = document.createElement('span');
  span.className = `pill ${kind}`;
  span.textContent = text;
  return span;
}

function renderBotTabs() {
  const r = state.result;
  ui.botTabs.textContent = '';

  for (const id of r.order) {
    const b = r.perBot[id];
    if (!b) continue;

    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = 'tab';
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-selected', String(id === state.selectedBotId));

    const dot = document.createElement('span');
    dot.className = `dot ${b.band}`;
    tab.append(dot, document.createTextNode(b.label));

    tab.addEventListener('click', async () => {
      state.selectedBotId = id;
      renderBotTabs();
      renderBotDetail();
      // Keep the on-page overlay in step with the popup selection.
      if (state.overlayVisible) {
        try {
          await chrome.tabs.sendMessage(state.tabId, { type: 'AICL_OVERLAY_SHOW', botId: id });
        } catch {
          state.overlayVisible = false;
          ui.overlayBtn.textContent = 'Highlight invisible content on the page';
        }
      }
    });

    ui.botTabs.appendChild(tab);
  }
}

function renderBotDetail() {
  const r = state.result;
  const b = r.perBot[state.selectedBotId];
  ui.botDetail.textContent = '';
  if (!b) return;

  // Why this bot can or cannot read the page, and the gate chain behind it.
  if (b.verdict) {
    ui.botDetail.appendChild(renderVerdict(b.verdict));
    const strip = renderBlockStrip(b);
    if (strip) ui.botDetail.appendChild(strip);
    const hr = document.createElement('p');
    hr.className = 'hint';
    hr.textContent = 'Measurements';
    hr.style.marginBottom = '2px';
    ui.botDetail.appendChild(hr);
  }

  const add = (label, value) => {
    const row = document.createElement('div');
    row.className = 'stat-row';
    const l = document.createElement('span');
    l.textContent = label;
    const v = document.createElement('b');
    v.textContent = value;
    row.append(l, v);
    ui.botDetail.appendChild(row);
  };

  add('Visibility Score', b.scoreMeaningful && typeof b.score === 'number' ? `${b.score} / 100` : 'n/a');
  add('Blocks visible in raw HTML', `${b.visibleCount} of ${b.totalBlocks}`);
  add('Headings visible in raw HTML', `${b.totalHeadings - b.invisibleHeadings} of ${b.totalHeadings}`);
  add('Raw HTML size', `${formatBytes(b.byteLength)}`);
  add('Fetch time', `${b.elapsedMs} ms`);

  // Every access finding rests on the server recognising a User-Agent this tool
  // hard-codes, and a stale string fails silently. When a bot did not get a
  // clean response, show exactly what was sent so the finding can be checked
  // rather than trusted.
  if (b.status !== 'ok') {
    const sent = document.createElement('p');
    sent.className = 'hint';
    sent.style.wordBreak = 'break-all';
    sent.textContent = `Sent as: ${b.ua}`;
    ui.botDetail.appendChild(sent);
  }

  // Anything the verdict does not already cover: an off-origin redirect, a
  // truncated body, a non-HTML Content-Type.
  const extra = supplementaryNotes(b);
  if (extra) {
    const note = document.createElement('div');
    note.className = 'notice warn';
    note.textContent = extra;
    ui.botDetail.appendChild(note);
  }

  // The verdict above already explains why there is no score.
  if (!b.scoreMeaningful) return;

  if (b.invisibleBlocks.length === 0) {
    const good = document.createElement('div');
    good.className = 'notice good';
    good.textContent = 'Every rendered content block is present in the raw HTML this bot received.';
    ui.botDetail.appendChild(good);
    return;
  }

  const heading = document.createElement('p');
  heading.className = 'hint';
  heading.textContent = `Content invisible to ${b.label}:`;
  ui.botDetail.appendChild(heading);

  const ul = document.createElement('ul');
  ul.className = 'excerpts';
  for (const block of b.invisibleBlocks) {
    const li = document.createElement('li');
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = block.tag;
    li.append(tag, document.createTextNode(block.text));
    ul.appendChild(li);
  }
  ui.botDetail.appendChild(ul);

  if (b.invisibleTruncated) {
    const more = document.createElement('p');
    more.className = 'hint';
    more.textContent = `Showing the first ${b.invisibleBlocks.length} of ${b.invisibleCount}.`;
    ui.botDetail.appendChild(more);
  }
}

/** Above this, the strip stops being readable and starts being wallpaper. */
const MAX_STRIP_BLOCKS = 240;

/**
 * The block strip: one square per content block, in document order.
 *
 * This is the icon drawn from the page's own data — solid ink where the block
 * reached the crawler, a shrunken vermilion square where it did not. Keeping
 * document order is the point: it shows *where* the page comes apart, which
 * separates a lazy-loaded tail from a hydration problem running throughout.
 *
 * @param {Object} b  A per-bot entry.
 * @returns {HTMLElement|null}
 */
function renderBlockStrip(b) {
  const total = b.totalBlocks;
  if (!total || !b.scoreMeaningful) return null;

  const invisible = new Set(b.invisibleIndices || []);
  const shown = Math.min(total, MAX_STRIP_BLOCKS);

  const wrap = document.createElement('div');

  const strip = document.createElement('div');
  strip.className = 'blockstrip';
  strip.setAttribute('role', 'img');
  strip.setAttribute(
    'aria-label',
    `${b.visibleCount} of ${total} content blocks reach ${b.label}; ` +
      `${b.invisibleCount} exist only after JavaScript runs.`
  );

  for (let i = 0; i < shown; i += 1) {
    const cell = document.createElement('i');
    if (invisible.has(i)) cell.className = 'off';
    strip.appendChild(cell);
  }
  wrap.appendChild(strip);

  const key = document.createElement('div');
  key.className = 'blockstrip-key';
  key.innerHTML =
    `<span><i></i>${b.visibleCount} in the HTML</span>` +
    `<span><i class="off"></i>${b.invisibleCount} JavaScript-only</span>`;
  wrap.appendChild(key);

  if (total > shown) {
    const more = document.createElement('p');
    more.className = 'hint';
    more.textContent = `Showing the first ${shown} of ${total} blocks.`;
    wrap.appendChild(more);
  }

  return wrap;
}

/**
 * Caveats about the fetch itself that the verdict's gate chain does not carry.
 *
 * @param {Object} b
 * @returns {string}
 */
function supplementaryNotes(b) {
  const parts = [];
  if (b.redirectedCrossOrigin) {
    parts.push(
      `Redirected off-origin to ${b.finalUrl} — the spoofed User-Agent is not carried across origins, ` +
        'so this row reflects the redirect target fetched as a normal browser.'
    );
  }
  if (b.truncated) parts.push('The response body was very large and was truncated before analysis.');
  return parts.join(' ');
}

/** Glyph per gate state. Shape as well as colour, so it survives a screenshot. */
const GATE_GLYPH = { pass: '✓', fail: '✕', warn: '!', skip: '·' };

/**
 * The verdict card: the answer, the reason, the fix, then the gate chain that
 * produced it — in the order a real request meets those gates.
 *
 * @param {Object} verdict
 * @returns {HTMLElement}
 */
function renderVerdict(verdict) {
  const wrap = document.createElement('div');

  const card = document.createElement('div');
  card.className = `verdict ${verdict.severity}`;

  const head = document.createElement('b');
  head.textContent = verdict.headline;
  card.appendChild(head);

  const why = document.createElement('p');
  why.textContent = verdict.because;
  card.appendChild(why);

  if (verdict.fix) {
    const fix = document.createElement('p');
    fix.className = 'fix';
    fix.textContent = verdict.fix;
    card.appendChild(fix);
  }
  wrap.appendChild(card);

  const list = document.createElement('ul');
  list.className = 'gates';
  for (const g of verdict.gates) {
    const li = document.createElement('li');
    li.className = 'gate' + (g.state === 'skip' ? ' is-skip' : '');

    const glyph = document.createElement('span');
    glyph.className = `g ${g.state}`;
    glyph.textContent = GATE_GLYPH[g.state] || '·';
    glyph.setAttribute('aria-hidden', 'true');

    const text = document.createElement('div');
    const label = document.createElement('b');
    label.textContent = g.label;
    const detail = document.createElement('span');
    detail.textContent = g.detail;
    text.append(label, detail);

    li.append(glyph, text);
    list.appendChild(li);
  }
  wrap.appendChild(list);

  return wrap;
}

function renderFramework() {
  const fix = getFrameworkFix(state.framework && state.framework.id);
  ui.frameworkCard.textContent = '';

  const h3 = document.createElement('h3');
  h3.textContent = fix.label;
  if (state.framework && state.framework.confidence && state.framework.confidence !== 'none') {
    const conf = document.createElement('span');
    conf.className = 'muted';
    conf.textContent = ` (${state.framework.confidence} confidence)`;
    h3.appendChild(conf);
  }

  const p = document.createElement('p');
  setTextWithCode(p, fix.fix);

  ui.frameworkCard.append(h3, p);

  if (fix.detail) {
    const d = document.createElement('p');
    d.className = 'muted';
    setTextWithCode(d, fix.detail);
    ui.frameworkCard.appendChild(d);
  }

  if (state.framework && state.framework.signals && state.framework.signals.length) {
    const s = document.createElement('p');
    s.className = 'muted';
    s.textContent = `Signals: ${state.framework.signals.join('; ')}`;
    ui.frameworkCard.appendChild(s);
  }
}

/* -------------------------------------------------------------------------- */
/* Actions                                                                     */
/* -------------------------------------------------------------------------- */

async function onOverlayToggle() {
  if (!state.result) return;

  try {
    if (state.overlayVisible) {
      await chrome.tabs.sendMessage(state.tabId, { type: 'AICL_OVERLAY_HIDE' });
      state.overlayVisible = false;
      ui.overlayBtn.textContent = 'Highlight invisible content on the page';
    } else {
      const res = await chrome.tabs.sendMessage(state.tabId, {
        type: 'AICL_OVERLAY_SHOW',
        botId: state.selectedBotId
      });
      if (!res || !res.ok) {
        showError((res && res.error) || 'The overlay could not be shown.');
        return;
      }
      state.overlayVisible = true;
      ui.overlayBtn.textContent = 'Hide highlights';
    }
  } catch (err) {
    showError(explainRunError(err));
  }
}

function onExport() {
  if (!state.result) return;
  try {
    downloadReport(state.result, state.framework);
    ui.exportBtn.textContent = 'Report saved to Downloads';
    setTimeout(() => {
      ui.exportBtn.textContent = 'Export HTML report';
    }, 2500);
  } catch (err) {
    showError(`Export failed: ${String((err && err.message) || err)}`);
  }
}

async function onClearHistory() {
  await clearHistory();
  await renderHistory();
}

async function onRevoke() {
  const removed = await chrome.permissions.remove({ origins: [`${state.origin}/*`] });
  if (removed) {
    ui.revokeBtn.classList.add('hidden');
    ui.permissionNotice.innerHTML =
      '<strong>Access revoked</strong>This extension can no longer read or fetch anything on ' +
      `${escapeText(state.origin)}. Click Check to grant it again.`;
    show(ui.permissionNotice);
  }
}

/* -------------------------------------------------------------------------- */
/* History                                                                     */
/* -------------------------------------------------------------------------- */

async function renderHistory() {
  const history = await getHistory();
  ui.historyList.textContent = '';

  if (!history.length) {
    const li = document.createElement('li');
    const span = document.createElement('span');
    span.className = 'empty';
    span.textContent = 'No checks yet.';
    li.appendChild(span);
    ui.historyList.appendChild(li);
    ui.clearHistoryBtn.classList.add('hidden');
    return;
  }

  ui.clearHistoryBtn.classList.remove('hidden');

  for (const entry of history) {
    const li = document.createElement('li');

    const main = document.createElement('div');
    main.className = 'h-main';

    const title = document.createElement('span');
    title.className = 'h-title';
    title.textContent = entry.title || entry.url;
    title.title = entry.url;

    const meta = document.createElement('span');
    meta.className = 'h-meta';
    const bits = [new Date(entry.checkedAt).toLocaleString()];
    bits.push(
      entry.lowestScore === null
        ? 'no score'
        : `lowest ${entry.lowestScore} (${entry.lowestScoreBot})`
    );
    if (entry.robotsBlockedCount > 0) {
      bits.push(`${entry.robotsBlockedCount} robots-blocked`);
    }
    if (entry.cloakingDetected) bits.push('cloaking flagged');
    meta.textContent = bits.join(' · ');

    main.append(title, meta);
    li.appendChild(main);

    if (entry.lowestScore !== null) {
      li.appendChild(pill(scoreBand(entry.lowestScore), String(entry.lowestScore)));
    } else if (entry.robotsBlockedCount > 0) {
      li.appendChild(pill('red', 'blocked'));
    }

    ui.historyList.appendChild(li);
  }
}

/* -------------------------------------------------------------------------- */
/* Small helpers                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Append text to an element, rendering `backticked` spans as <code>.
 *
 * The recommendation strings name real API identifiers (`getServerSideProps`,
 * `'use client'`). Rendered as flat text the backticks read as noise; rendered
 * as code they read as what they are.
 *
 * @param {HTMLElement} el
 * @param {string} text
 */
function setTextWithCode(el, text) {
  const parts = String(text).split('`');
  for (let i = 0; i < parts.length; i += 1) {
    if (!parts[i]) continue;
    // Odd indices sit between a pair of backticks.
    if (i % 2 === 1) {
      const code = document.createElement('code');
      code.textContent = parts[i];
      el.appendChild(code);
    } else {
      el.appendChild(document.createTextNode(parts[i]));
    }
  }
}

function scoreBand(score) {
  if (score === null || score === undefined) return 'none';
  if (score < 40) return 'red';
  if (score <= 75) return 'amber';
  return 'green';
}

function formatBytes(n) {
  if (!n) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function show(node) {
  node.classList.remove('hidden');
}

function hide(node) {
  node.classList.add('hidden');
}

function showError(message) {
  ui.errorNotice.textContent = '';
  const strong = document.createElement('strong');
  strong.textContent = 'Could not complete the check';
  ui.errorNotice.append(strong, document.createTextNode(message));
  show(ui.errorNotice);
}

function escapeText(s) {
  return String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
}
