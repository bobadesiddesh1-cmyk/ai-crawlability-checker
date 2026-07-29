/**
 * shared/storage.js
 *
 * The only thing this extension ever persists: a 20-entry check history.
 *
 * ES module, imported by popup/popup.js.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS AND IS NOT STORED
 * ---------------------------------------------------------------------------
 * STORED: URL, page title, timestamp, the lowest bot score, how many bots are
 * robots.txt-blocked, and whether cloaking was flagged. Enough to recognise a
 * past check.
 *
 * NOT STORED, EVER: page text, block excerpts, raw HTML, robots.txt bodies,
 * scores per bot, or anything else. This tool gets pointed at client sites and
 * staging environments under NDA; keeping a local corpus of their content would
 * be indefensible.
 *
 * `chrome.storage.local`, not `sync`: an audit history is not something to
 * silently replicate across a user's devices.
 */

const HISTORY_KEY = 'aicl_history_v1';
const MAX_HISTORY = 20;

/**
 * @typedef {Object} HistoryEntry
 * @property {string} url
 * @property {string} title
 * @property {string} checkedAt      ISO timestamp.
 * @property {number|null} lowestScore
 * @property {string|null} lowestScoreBot
 * @property {number} robotsBlockedCount
 * @property {string[]} robotsBlockedLabels
 * @property {boolean} cloakingDetected
 * @property {number} totalBlocks
 */

/**
 * @returns {Promise<HistoryEntry[]>} Newest first.
 */
export async function getHistory() {
  const stored = await chrome.storage.local.get(HISTORY_KEY);
  const list = stored[HISTORY_KEY];
  return Array.isArray(list) ? list : [];
}

/**
 * Record a completed check.
 *
 * Re-checking the same URL replaces the previous entry rather than stacking
 * duplicates — during an audit you re-run the same page repeatedly, and twenty
 * copies of one URL would push out every other result.
 *
 * @param {Object} result  The analysis object from content/main.js.
 * @returns {Promise<HistoryEntry[]>} The updated history.
 */
export async function addHistoryEntry(result) {
  const entry = summarise(result);
  const current = await getHistory();
  const deduped = current.filter((e) => e.url !== entry.url);
  const next = [entry, ...deduped].slice(0, MAX_HISTORY);
  await chrome.storage.local.set({ [HISTORY_KEY]: next });
  return next;
}

/** @returns {Promise<void>} */
export async function clearHistory() {
  await chrome.storage.local.remove(HISTORY_KEY);
}

/**
 * Reduce a full analysis to the handful of fields worth keeping.
 *
 * @param {Object} result
 * @returns {HistoryEntry}
 */
export function summarise(result) {
  let lowestScore = null;
  let lowestScoreBot = null;
  const robotsBlockedLabels = [];

  for (const id of result.order || []) {
    const bot = result.perBot[id];
    if (!bot) continue;

    if (bot.robotsBlocked) robotsBlockedLabels.push(bot.label);

    if (bot.scoreMeaningful && typeof bot.score === 'number') {
      if (lowestScore === null || bot.score < lowestScore) {
        lowestScore = bot.score;
        lowestScoreBot = bot.label;
      }
    }
  }

  return {
    url: result.url,
    title: (result.pageMeta && result.pageMeta.title) || result.url,
    checkedAt: result.checkedAt || new Date().toISOString(),
    lowestScore,
    lowestScoreBot,
    robotsBlockedCount: robotsBlockedLabels.length,
    robotsBlockedLabels,
    cloakingDetected: !!(result.cloaking && result.cloaking.detected),
    totalBlocks: (result.rendered && result.rendered.totalBlocks) || 0
  };
}

export { HISTORY_KEY, MAX_HISTORY };
