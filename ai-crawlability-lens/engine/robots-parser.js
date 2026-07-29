/**
 * engine/robots-parser.js
 *
 * A real robots.txt parser and matcher, following RFC 9309 ("Robots Exclusion
 * Protocol") plus the de-facto `*` / `$` wildcard extensions that Google, Bing,
 * OpenAI, Perplexity and Anthropic all honour.
 *
 * ES module. Pure — no DOM, no network, no globals. Every export is a function
 * of its arguments only, which is what makes it reasonable to trust.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS WRITTEN OUT PROPERLY INSTEAD OF REGEXED
 * ---------------------------------------------------------------------------
 * The precedence rules are the part implementations get wrong, and getting them
 * wrong here produces a false CRITICAL banner telling a user that GPTBot is
 * blocked when it is not. That is the most damaging error this tool could make,
 * so the three rules that matter are implemented explicitly:
 *
 *   1. GROUP SELECTION.  A crawler obeys exactly ONE group: the one whose
 *      product token is the longest case-insensitive prefix of the crawler's own
 *      token. `*` is a fallback and is used only when no specific group matches
 *      at all — it is never merged with a specific group.
 *
 *   2. RULE PRECEDENCE.  Within the selected group, the rule with the LONGEST
 *      matching pattern wins, regardless of the order rules appear in.
 *
 *   3. TIE-BREAK.  If an `Allow` and a `Disallow` pattern of equal length both
 *      match, `Allow` wins.
 *
 * So `Disallow: /` followed by `Allow: /blog/` leaves `/blog/post` CRAWLABLE,
 * even though the Disallow came first and is broader.
 */

/**
 * @typedef {Object} RobotsRule
 * @property {'allow'|'disallow'} type
 * @property {string} path   The raw pattern as written in the file.
 */

/**
 * @typedef {Object} RobotsGroup
 * @property {string[]} agents  Product tokens this group applies to (as written).
 * @property {RobotsRule[]} rules
 */

/**
 * @typedef {Object} ParsedRobots
 * @property {RobotsGroup[]} groups
 * @property {string[]} sitemaps
 * @property {number} lineCount
 * @property {boolean} empty  True when the file contained no groups at all.
 */

/**
 * Parse robots.txt source text into groups.
 *
 * Grammar handled:
 *   - `#` starts a comment, to end of line, anywhere on the line.
 *   - `field: value`, split on the FIRST colon; field is case-insensitive.
 *   - CONSECUTIVE `User-agent:` lines form a single group header. The first
 *     rule line after them closes the header; the next `User-agent:` after a
 *     rule line starts a brand new group.
 *   - Unknown fields (`Crawl-delay`, `Host`, vendor extensions) are ignored but
 *     do NOT close a group header, matching real-world crawler behaviour.
 *   - `Sitemap:` is a global directive and is collected separately.
 *
 * @param {string} text  Raw robots.txt body.
 * @returns {ParsedRobots}
 */
export function parseRobotsTxt(text) {
  /** @type {RobotsGroup[]} */
  const groups = [];
  /** @type {string[]} */
  const sitemaps = [];

  if (typeof text !== 'string') {
    return { groups, sitemaps, lineCount: 0, empty: true };
  }

  // Strip a UTF-8 BOM if the server sent one — otherwise the very first
  // "User-agent" field name would be "﻿user-agent" and silently never match.
  const body = text.replace(/^\uFEFF/, '');
  const lines = body.split(/\r\n|\r|\n/);

  /** @type {RobotsGroup|null} */
  let current = null;
  // True while we are still accumulating `User-agent:` lines for `current`.
  let collectingAgents = false;

  for (const rawLine of lines) {
    // Comments run to end of line and may appear after a value.
    const line = rawLine.split('#')[0].trim();
    if (!line) continue;

    const colon = line.indexOf(':');
    if (colon === -1) continue; // Malformed line; skip it rather than guess.

    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();

    if (field === 'user-agent' || field === 'useragent') {
      if (!value) continue;
      if (current && collectingAgents) {
        // Consecutive User-agent lines share one group.
        current.agents.push(value);
      } else {
        current = { agents: [value], rules: [], crawlDelay: null };
        groups.push(current);
        collectingAgents = true;
      }
      continue;
    }

    // Not in RFC 9309, but honoured by Bing, Yandex and most WAF vendors, and
    // it is the one place a site states the request rate it will tolerate.
    // Worth reading even though this tool sends one request per crawler.
    if (field === 'crawl-delay' || field === 'crawldelay') {
      if (!current) continue;
      collectingAgents = false;
      const seconds = Number(value);
      // Ignore junk and negatives rather than guessing at intent.
      if (Number.isFinite(seconds) && seconds >= 0) current.crawlDelay = seconds;
      continue;
    }

    if (field === 'sitemap') {
      if (value) sitemaps.push(value);
      continue;
    }

    if (field === 'allow' || field === 'disallow') {
      // A rule line before any User-agent line is orphaned. Real crawlers
      // ignore it; so do we.
      if (!current) continue;
      collectingAgents = false;

      // `Disallow:` with an empty value is the canonical "allow everything"
      // and carries no path, so it contributes no rule.
      // `Allow:` with an empty value is meaningless; drop it too.
      if (value === '') continue;

      current.rules.push({ type: /** @type {'allow'|'disallow'} */ (field), path: value });
      continue;
    }

    // Unknown field (Host, Clean-param, vendor extensions). Ignored, and
    // deliberately does NOT close the agent header.
  }

  return {
    groups,
    sitemaps,
    lineCount: lines.length,
    empty: groups.length === 0
  };
}

/**
 * Merge every group that names the same product token.
 *
 * RFC 9309 §2.2.1 requires records for the same user-agent to be combined, so
 * two separate `User-agent: GPTBot` blocks behave as one. Without this, a file
 * that declares GPTBot twice would silently lose the rules in the second block.
 *
 * @param {RobotsGroup[]} groups
 * @returns {Map<string, RobotsRule[]>}  lowercased token -> merged rules
 */
export function mergeGroupsByAgent(groups) {
  /** @type {Map<string, RobotsRule[]>} */
  const byAgent = new Map();
  for (const group of groups) {
    for (const agent of group.agents) {
      const key = agent.trim().toLowerCase();
      if (!key) continue;
      const existing = byAgent.get(key);
      if (existing) {
        existing.push(...group.rules);
      } else {
        byAgent.set(key, group.rules.slice());
      }
    }
  }
  return byAgent;
}

/**
 * Pick the ONE group a crawler must obey.
 *
 * Longest case-insensitive prefix match on the product token, with `*` as a
 * fallback that is only consulted when nothing specific matched.
 *
 * Example: with groups for `googlebot` and `googlebot-news`, the crawler
 * `Googlebot-News` selects `googlebot-news` (longer prefix), while plain
 * `Googlebot` selects `googlebot`.
 *
 * @param {Map<string, RobotsRule[]>} byAgent
 * @param {string} botToken  e.g. "GPTBot"
 * @returns {{ agentKey: string|null, rules: RobotsRule[], usedWildcard: boolean }}
 */
export function selectGroupForBot(byAgent, botToken) {
  const { agentKey, usedWildcard } = selectAgentKey(byAgent.keys(), botToken);
  if (agentKey === null) return { agentKey: null, rules: [], usedWildcard: false };
  return { agentKey, rules: byAgent.get(agentKey) || [], usedWildcard };
}

/**
 * The group-selection rule on its own: longest case-insensitive prefix match,
 * with `*` consulted only when nothing specific matched.
 *
 * Extracted so rules and Crawl-delay resolve through the same code rather than
 * through two implementations that agree until one of them is edited.
 *
 * @param {Iterable<string>} keys  lowercased agent tokens
 * @param {string} botToken
 * @returns {{ agentKey: string|null, usedWildcard: boolean }}
 */
export function selectAgentKey(keys, botToken) {
  const token = String(botToken || '').trim().toLowerCase();

  let bestKey = null;
  let hasWildcard = false;
  for (const key of keys) {
    if (key === '*') { hasWildcard = true; continue; }
    if (!token.startsWith(key)) continue;
    if (bestKey === null || key.length > bestKey.length) bestKey = key;
  }

  if (bestKey !== null) return { agentKey: bestKey, usedWildcard: false };
  if (hasWildcard) return { agentKey: '*', usedWildcard: true };
  return { agentKey: null, usedWildcard: false };
}

/**
 * Collect `Crawl-delay` per agent token.
 *
 * Where a token appears in several groups, the LARGEST delay wins. The values
 * disagree only in a malformed file, and in that case the site's most cautious
 * statement is the honest one to obey.
 *
 * @param {RobotsGroup[]} groups
 * @returns {Map<string, number>}  lowercased token -> seconds
 */
export function crawlDelaysByAgent(groups) {
  /** @type {Map<string, number>} */
  const byAgent = new Map();
  for (const group of groups) {
    if (typeof group.crawlDelay !== 'number') continue;
    for (const agent of group.agents) {
      const key = agent.trim().toLowerCase();
      if (!key) continue;
      const existing = byAgent.get(key);
      if (existing === undefined || group.crawlDelay > existing) {
        byAgent.set(key, group.crawlDelay);
      }
    }
  }
  return byAgent;
}

/**
 * The `Crawl-delay` that applies to one bot, in seconds, or null.
 *
 * Resolved through the same group selection as the Allow/Disallow rules: a
 * bot that obeys the `*` group for rules obeys the `*` group's delay too.
 *
 * @param {ParsedRobots} parsed
 * @param {string} botToken
 * @returns {number|null}
 */
export function crawlDelayForBot(parsed, botToken) {
  const byAgent = crawlDelaysByAgent(parsed.groups);
  if (byAgent.size === 0) return null;

  // Selection must consider every declared group, not only those that happen
  // to carry a delay — otherwise a bot with its own delay-less group would
  // silently inherit the `*` delay it does not obey.
  const allKeys = new Set();
  for (const group of parsed.groups) {
    for (const agent of group.agents) {
      const key = agent.trim().toLowerCase();
      if (key) allKeys.add(key);
    }
  }

  const { agentKey } = selectAgentKey(allKeys, botToken);
  if (agentKey === null) return null;

  const delay = byAgent.get(agentKey);
  return delay === undefined ? null : delay;
}

/**
 * Compile a robots.txt path pattern into an anchored RegExp.
 *
 * Wildcard semantics (the Google/Bing/OpenAI/Perplexity/Anthropic dialect):
 *   `*`  matches any sequence of characters, including `/`.
 *   `$`  anchors the end of the URL, but ONLY as the final character of the
 *        pattern. Anywhere else it is a literal `$`.
 *   Every pattern is anchored at the start of the path.
 *
 * @param {string} pattern
 * @returns {RegExp}
 */
export function compilePathPattern(pattern) {
  let p = String(pattern);

  let anchorEnd = false;
  if (p.endsWith('$')) {
    anchorEnd = true;
    p = p.slice(0, -1);
  }

  // Escape every regex metacharacter, then re-enable `*` only.
  // `$` is escaped here because any remaining `$` is a mid-pattern literal.
  let out = '';
  for (const ch of p) {
    if (ch === '*') {
      out += '.*';
    } else if ('\\^$.|?+()[]{}'.includes(ch)) {
      out += '\\' + ch;
    } else {
      out += ch;
    }
  }

  return new RegExp('^' + out + (anchorEnd ? '$' : ''));
}

/**
 * The effective "specificity" of a pattern for precedence purposes.
 *
 * RFC 9309: the most specific (longest) matching pattern wins. Length is
 * measured on the pattern as written, minus a trailing `$` (which anchors but
 * does not itself add path specificity).
 *
 * @param {string} pattern
 * @returns {number}
 */
function patternSpecificity(pattern) {
  const p = String(pattern);
  return p.endsWith('$') ? p.length - 1 : p.length;
}

/**
 * Decide whether a single bot may crawl a single path.
 *
 * @param {ParsedRobots} parsed
 * @param {string} botToken   Product token, e.g. "GPTBot".
 * @param {string} path       Path plus query, e.g. "/blog/post?x=1".
 * @returns {{
 *   allowed: boolean,
 *   matchedRule: string|null,
 *   matchedGroup: string|null,
 *   usedWildcardGroup: boolean,
 *   reason: string
 * }}
 */
export function isPathAllowed(parsed, botToken, path) {
  const byAgent = mergeGroupsByAgent(parsed.groups);
  const { agentKey, rules, usedWildcard } = selectGroupForBot(byAgent, botToken);

  if (agentKey === null) {
    return {
      allowed: true,
      matchedRule: null,
      matchedGroup: null,
      usedWildcardGroup: false,
      reason: 'No matching User-agent group and no * group — nothing restricts this bot.'
    };
  }

  if (rules.length === 0) {
    return {
      allowed: true,
      matchedRule: null,
      matchedGroup: agentKey,
      usedWildcardGroup: usedWildcard,
      reason: `Group "${agentKey}" contains no Allow/Disallow rules — everything is crawlable.`
    };
  }

  const target = normalizePathForMatching(path);

  /** @type {{type: 'allow'|'disallow', path: string, spec: number}|null} */
  let winner = null;

  for (const rule of rules) {
    let re;
    try {
      re = compilePathPattern(rule.path);
    } catch {
      continue; // A pattern that will not compile cannot be enforced.
    }
    if (!re.test(target)) continue;

    const spec = patternSpecificity(rule.path);

    if (winner === null || spec > winner.spec) {
      winner = { type: rule.type, path: rule.path, spec };
    } else if (spec === winner.spec && rule.type === 'allow' && winner.type === 'disallow') {
      // Rule 3: equal-length tie goes to Allow.
      winner = { type: rule.type, path: rule.path, spec };
    }
  }

  if (winner === null) {
    return {
      allowed: true,
      matchedRule: null,
      matchedGroup: agentKey,
      usedWildcardGroup: usedWildcard,
      reason: `No rule in group "${agentKey}" matches this path.`
    };
  }

  const allowed = winner.type === 'allow';
  const directive = winner.type === 'allow' ? 'Allow' : 'Disallow';

  return {
    allowed,
    matchedRule: `${directive}: ${winner.path}`,
    matchedGroup: agentKey,
    usedWildcardGroup: usedWildcard,
    reason: allowed
      ? `Longest matching rule in group "${agentKey}" is "${directive}: ${winner.path}".`
      : `Blocked by "${directive}: ${winner.path}" in group "${agentKey}".`
  };
}

/**
 * Normalise a URL path for pattern matching.
 *
 * Patterns in robots.txt are written against the path-and-query portion of the
 * URL. We accept either a bare path or a full URL and reduce it to that.
 *
 * @param {string} pathOrUrl
 * @returns {string}
 */
export function normalizePathForMatching(pathOrUrl) {
  let p = String(pathOrUrl || '/');

  if (/^https?:\/\//i.test(p)) {
    // Strip scheme and authority without needing the URL constructor, so this
    // module stays free of any host-environment dependency.
    const afterScheme = p.replace(/^https?:\/\//i, '');
    const slash = afterScheme.indexOf('/');
    p = slash === -1 ? '/' : afterScheme.slice(slash);
  }

  // The fragment is never sent to the server and is never matched.
  const hash = p.indexOf('#');
  if (hash !== -1) p = p.slice(0, hash);

  if (!p.startsWith('/')) p = '/' + p;
  return p;
}

/**
 * Evaluate a whole set of bot tokens against one path in a single pass.
 *
 * When a bot declares more than one token (ClaudeBot also answers to
 * `anthropic-ai`), the STRICTEST verdict wins: if either token is disallowed,
 * the bot is reported as disallowed, and the blocking rule is the one shown.
 *
 * @param {ParsedRobots} parsed
 * @param {{id: string, label: string, robotsTokens: string[]}[]} bots
 * @param {string} path
 * @returns {Record<string, {
 *   id: string, label: string, allowed: boolean, matchedRule: string|null,
 *   matchedGroup: string|null, usedWildcardGroup: boolean,
 *   token: string, reason: string
 * }>}
 */
export function evaluateBots(parsed, bots, path) {
  /** @type {Record<string, any>} */
  const out = {};

  for (const bot of bots) {
    /** @type {any} */
    let verdict = null;
    /** @type {number|null} */
    let crawlDelay = null;

    for (const token of bot.robotsTokens) {
      const r = isPathAllowed(parsed, token, path);
      const candidate = { id: bot.id, label: bot.label, token, ...r };

      // Strictest across a bot's tokens, same rule as the allow/deny verdict.
      const d = crawlDelayForBot(parsed, token);
      if (d !== null && (crawlDelay === null || d > crawlDelay)) crawlDelay = d;

      if (verdict === null) {
        verdict = candidate;
      } else if (verdict.allowed && !candidate.allowed) {
        // Strictest wins.
        verdict = candidate;
      }
    }

    if (verdict) verdict.crawlDelay = crawlDelay;
    out[bot.id] = verdict;
  }

  return out;
}
