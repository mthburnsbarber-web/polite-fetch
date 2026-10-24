// polite-fetch — fetch the web like a guest. A drop-in `fetch` for crawlers and AI agents that:
// - honors robots.txt (RFC 9309), matching wildcards in linear time (no regex backtracking on hostile rules);
// - sends one request at a time per host, a gap apart;
// - puts hosts that share infrastructure in one queue (decided by CNAME, so a hundred customer domains on one
//   vendor's servers count as one host);
// - leaves a host alone for a while when it answers 429 or a bot challenge, instead of retrying or working around it;
// - starts each request's timeout when the request is sent, not while it waits its turn.
// Zero dependencies.
import { resolveCname as systemResolveCname } from 'node:dns/promises';

export class BackOffError extends Error {
  constructor(key, until) { super(`backing off from ${key} until ${new Date(until).toISOString()}: it asked automated clients to slow down`); this.name = 'BackOffError'; this.key = key; this.until = until; }
}
export class DeadlineError extends Error {
  constructor(url) { super(`deadline passed before requesting ${url}`); this.name = 'DeadlineError'; }
}

// robots.txt pattern match: '*' matches any run of characters, a final '$' anchors the end, otherwise a prefix match.
// Linear time: a rule like /*?*&*&*&*&*&*z turned into a regular expression backtracks for minutes on a long URL.
export function robotsMatch(rule, path) {
  const anchored = rule.endsWith('$'), pattern = (anchored ? rule.slice(0, -1) : rule) + (anchored ? '' : '*');
  let p = 0, s = 0, star = -1, mark = 0;
  while (s < path.length) {
    if (p < pattern.length && pattern[p] !== '*' && pattern[p] === path[s]) { p++; s++; }
    else if (p < pattern.length && pattern[p] === '*') { star = p++; mark = s; }
    else if (star !== -1) { p = star + 1; s = ++mark; }
    else return false;
  }
  while (p < pattern.length && pattern[p] === '*') p++;
  return p === pattern.length;
}

// The rules that apply to `agent` (the most specific matching user-agent group, else '*'), per RFC 9309.
export function parseRobots(text, agent = '*') {
  const groups = [];
  let current = null, lastWasAgent = false;
  for (const raw of String(text).slice(0, 512 * 1024).split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim(), m = /^([a-z-]+)\s*:\s*(.*)$/i.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase(), value = m[2].trim();
    if (key === 'user-agent') {
      if (!lastWasAgent) { current = { agents: [], rules: [] }; groups.push(current); }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if ((key === 'allow' || key === 'disallow') && current) {
      lastWasAgent = false;
      if (value) current.rules.push({ allow: key === 'allow', pattern: value });
    } else lastWasAgent = false;
  }
  const name = agent.toLowerCase();
  const specific = groups.filter((g) => g.agents.some((a) => a !== '*' && name.includes(a)));
  return (specific.length ? specific : groups.filter((g) => g.agents.includes('*'))).flatMap((g) => g.rules);
}

// Longest matching rule wins; on a tie, allow wins (RFC 9309 2.2.2).
export function robotsAllows(rules, path) {
  let best = null;
  for (const r of rules) {
    if (!robotsMatch(r.pattern, path)) continue;
    if (!best || r.pattern.length > best.pattern.length || (r.pattern.length === best.pattern.length && r.allow)) best = r;
  }
  return !best || best.allow;
}

const challenged = (response) => response.status === 429
  || /challenge|captcha|block/i.test(response.headers.get('x-amzn-waf-action') || '')
  || /challenge/i.test(response.headers.get('cf-mitigated') || '');
const retryAfterMs = (response, now) => {
  const v = response.headers.get('retry-after');
  if (!v) return 0;
  const seconds = Number(v);
  return Number.isFinite(seconds) ? seconds * 1000 : Math.max(0, Date.parse(v) - now());
};

export function createPoliteFetch({
  userAgent,                          // required: name your client and a contact URL
  robotsAgent,                        // the token robots.txt groups name; defaults to the first word of userAgent
  hostGapMs = 500,                    // minimum gap between requests to one host (or group)
  groups = [],                        // [{ name, match: (hostname) => boolean, gapMs }] tested against the host and its CNAMEs
  coolDownMs = 15 * 60 * 1000,        // how long to leave a host alone after 429 or a challenge
  timeoutMs = 20000,                  // per request, counted from when it is sent
  respectRobots = true,
  fetcher = fetch,
  resolveCname = systemResolveCname,
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
} = {}) {
  if (!userAgent) throw new Error('polite-fetch needs a userAgent that names your client and a contact URL');
  const agent = robotsAgent || userAgent.split(/[\s/]/)[0];
  const robots = new Map(), queues = new Map(), keys = new Map(), coolDown = new Map(), lastSent = new Map();

  async function keyFor(host) {
    if (!keys.has(host)) {
      keys.set(host, (async () => {
        const names = [host];
        for (let name = host, i = 0; i < 5; i++) {
          const next = await resolveCname(name).then((r) => r[0]).catch(() => null);
          if (!next) break;
          names.push(next); name = next;
        }
        for (const g of groups) if (names.some((n) => g.match(n))) return { key: `group:${g.name}`, gap: g.gapMs ?? hostGapMs };
        return { key: host, gap: hostGapMs };
      })());
    }
    return keys.get(host);
  }

  // One request at a time per key, `gap` apart. Waiting here does not count against the request's timeout.
  async function turn(key, gap, task) {
    const previous = queues.get(key) || Promise.resolve();
    let release;
    const mine = new Promise((resolve) => { release = resolve; });
    queues.set(key, previous.then(() => mine));
    await previous;
    try {
      const wait = (lastSent.get(key) ?? -Infinity) + gap - now();
      if (wait > 0) await sleep(wait);
      lastSent.set(key, now());
      return await task();
    } finally { release(); }
  }

  async function rulesFor(origin) {
    if (!robots.has(origin)) {
      robots.set(origin, (async () => {
        try {
          const response = await fetcher(origin + '/robots.txt', { headers: { 'user-agent': userAgent }, signal: AbortSignal.timeout(10000), redirect: 'follow' });
          if (response.status >= 400 && response.status < 500) return [];                   // no robots.txt: everything allowed
          if (!response.ok) return [{ allow: false, pattern: '/' }];                          // unreachable: nothing allowed
          return parseRobots(await response.text(), agent);
        } catch {
          return [{ allow: false, pattern: '/' }];
        }
      })());
    }
    return robots.get(origin);
  }

  async function politeFetch(input, init = {}, { deadline } = {}) {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (deadline && now() > deadline) throw new DeadlineError(url.href);
    const { key, gap } = await keyFor(url.hostname);
    const until = coolDown.get(key);
    if (until && until > now()) throw new BackOffError(key, until);
    if (respectRobots && !robotsAllows(await rulesFor(url.origin), url.pathname + url.search)) {
      return new Response('robots.txt disallows this address', { status: 403, headers: { 'x-polite-fetch': 'robots' } });
    }
    return turn(key, gap, async () => {
      if (deadline && now() > deadline) throw new DeadlineError(url.href);
      const stillCooling = coolDown.get(key);
      if (stillCooling && stillCooling > now()) throw new BackOffError(key, stillCooling);
      const timeout = AbortSignal.timeout(timeoutMs);
      const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
      const headers = new Headers(init.headers);
      headers.set('user-agent', userAgent);
      const response = await fetcher(url.href, { ...init, headers, signal });
      if (challenged(response)) coolDown.set(key, now() + Math.max(coolDownMs, retryAfterMs(response, now)));
      return response;
    });
  }

  politeFetch.coolingDown = () => Object.fromEntries([...coolDown].filter(([, t]) => t > now()));
  return politeFetch;
}
