import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BackOffError, createPoliteFetch, DeadlineError, parseRobots, robotsAllows, robotsMatch } from '../polite-fetch.mjs';

const UA = 'ExampleBot/1.0 (+https://example.com/bot)';
// A fake web: robots.txt per origin, a status per URL, and a record of every request sent.
function web({ robots = {}, status = {}, headers = {} } = {}) {
  const sent = [];
  const fetcher = async (url, init = {}) => {
    const u = new URL(url);
    if (u.pathname === '/robots.txt') {
      const r = robots[u.origin];
      if (r === undefined) return new Response('', { status: 404 });
      if (typeof r === 'number') return new Response('', { status: r });
      return new Response(r, { status: 200 });
    }
    sent.push({ url, at: Date.now(), ua: new Headers(init.headers).get('user-agent'), signal: init.signal });
    return new Response('ok', { status: status[url] || 200, headers: headers[url] || {} });
  };
  return { fetcher, sent };
}
const noCname = async () => { throw new Error('no cname'); };

test('robots wildcards, end anchors and prefixes match as written, in linear time', () => {
  assert.equal(robotsMatch('/private', '/private/x'), true);
  assert.equal(robotsMatch('/*?*sort=', '/list?page=2&sort=asc'), true);
  assert.equal(robotsMatch('/*.pdf$', '/a/b.pdf'), true);
  assert.equal(robotsMatch('/*.pdf$', '/a/b.pdf?x=1'), false);
  const started = Date.now();
  assert.equal(robotsMatch('/*?*&*&*&*&*&*&*&*&*&*&*&*z', '/' + 'a&'.repeat(5000)), false);
  assert.ok(Date.now() - started < 1000, 'a hostile rule must not hang the crawler');
});

test('the most specific user-agent group applies; the longest rule wins and allow wins a tie', () => {
  const text = 'User-agent: *\nDisallow: /\n\nUser-agent: examplebot\nUser-agent: other\nDisallow: /private\nAllow: /private/open\n';
  const rules = parseRobots(text, 'ExampleBot');
  assert.equal(robotsAllows(rules, '/public'), true);
  assert.equal(robotsAllows(rules, '/private/x'), false);
  assert.equal(robotsAllows(rules, '/private/open/x'), true);
  assert.equal(robotsAllows(parseRobots(text, 'SomeoneElse'), '/public'), false);
  assert.equal(robotsAllows(parseRobots('User-agent: *\nDisallow: /a\nAllow: /a\n'), '/a'), true);
});

test('a disallowed address is never requested; no robots.txt allows all; an unreachable one allows nothing', async () => {
  const w = web({ robots: { 'https://a.example': 'User-agent: *\nDisallow: /secret', 'https://down.example': 503 } });
  const f = createPoliteFetch({ userAgent: UA, fetcher: w.fetcher, resolveCname: noCname, hostGapMs: 0 });
  const blocked = await f('https://a.example/secret/page');
  assert.equal(blocked.status, 403);
  assert.equal(blocked.headers.get('x-polite-fetch'), 'robots');
  assert.equal((await f('https://a.example/open')).status, 200);
  assert.equal((await f('https://nofile.example/anything')).status, 200);
  assert.equal((await f('https://down.example/page')).status, 403);
  assert.deepEqual(w.sent.map((s) => s.url), ['https://a.example/open', 'https://nofile.example/anything']);
  assert.equal(w.sent[0].ua, UA);
});

test('one request at a time per host, a gap apart; other hosts are not held up', async () => {
  const w = web();
  const f = createPoliteFetch({ userAgent: UA, fetcher: w.fetcher, resolveCname: noCname, hostGapMs: 60, respectRobots: false });
  const t0 = Date.now();
  await Promise.all([f('https://a.example/1'), f('https://a.example/2'), f('https://b.example/1')]);
  const a = w.sent.filter((s) => s.url.includes('a.example')).map((s) => s.at), b = w.sent.find((s) => s.url.includes('b.example')).at;
  assert.ok(a[1] - a[0] >= 55, `same host requests ${a[1] - a[0]} ms apart`);
  assert.ok(b - t0 < 50, 'another host goes right away');
});

test('hosts whose CNAME points at shared infrastructure share one queue', async () => {
  const w = web();
  const cnames = { 'catalog.one.example': 'one.vendor-catalog.example', 'catalog.two.example': 'two.vendor-catalog.example' };
  const f = createPoliteFetch({
    userAgent: UA, fetcher: w.fetcher, respectRobots: false, hostGapMs: 0,
    resolveCname: async (name) => { if (cnames[name]) return [cnames[name]]; throw new Error('none'); },
    groups: [{ name: 'vendor', match: (h) => h.endsWith('.vendor-catalog.example'), gapMs: 80 }]
  });
  await Promise.all([f('https://catalog.one.example/'), f('https://catalog.two.example/')]);
  assert.ok(w.sent[1].at - w.sent[0].at >= 75, 'two customer domains on one vendor are paced as one host');
});

test('after 429 or a bot challenge the host is left alone, without another request', async () => {
  let clock = 1_000_000;
  const w = web({ status: { 'https://busy.example/a': 429, 'https://waf.example/a': 202 }, headers: { 'https://waf.example/a': { 'x-amzn-waf-action': 'challenge' } } });
  const f = createPoliteFetch({ userAgent: UA, fetcher: w.fetcher, resolveCname: noCname, respectRobots: false, hostGapMs: 0, coolDownMs: 60_000, now: () => clock, sleep: async () => {} });
  assert.equal((await f('https://busy.example/a')).status, 429);
  await assert.rejects(f('https://busy.example/b'), BackOffError);
  assert.equal((await f('https://other.example/a')).status, 200, 'other hosts are unaffected');
  assert.equal((await f('https://waf.example/a')).status, 202);
  await assert.rejects(f('https://waf.example/b'), BackOffError);
  assert.equal(w.sent.filter((s) => s.url.endsWith('/b')).length, 0, 'nothing is sent while backing off');
  clock += 61_000;
  assert.equal((await f('https://busy.example/b')).status, 200, 'the host is tried again after the cool-down');
  assert.deepEqual(f.coolingDown(), {}, 'both cool-downs have ended');
});

test('the timeout starts when the request is sent, not while it waits its turn', async () => {
  const slowFirst = async (url, init) => {
    if (url.endsWith('/1')) await new Promise((r) => setTimeout(r, 120));
    if (init.signal.aborted) throw new Error('aborted before sending');
    return new Response('ok');
  };
  const f = createPoliteFetch({ userAgent: UA, fetcher: slowFirst, resolveCname: noCname, respectRobots: false, hostGapMs: 0, timeoutMs: 80 });
  const [, second] = await Promise.allSettled([f('https://a.example/1'), f('https://a.example/2')]);
  assert.equal(second.status, 'fulfilled', 'waiting 120 ms in the queue must not use up an 80 ms timeout');
});

test('a job deadline stops new requests', async () => {
  const w = web();
  const f = createPoliteFetch({ userAgent: UA, fetcher: w.fetcher, resolveCname: noCname, respectRobots: false });
  await assert.rejects(f('https://a.example/', {}, { deadline: Date.now() - 1 }), DeadlineError);
  assert.equal(w.sent.length, 0);
  assert.throws(() => createPoliteFetch({}), /userAgent/);
});
