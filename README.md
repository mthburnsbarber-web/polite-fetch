# polite-fetch

Fetch the web like a guest. A drop-in `fetch` for crawlers and AI agents that honors robots.txt, paces every host,
treats shared infrastructure as one host, and leaves a site alone when it asks you to slow down.

```js
import { createPoliteFetch } from './polite-fetch.mjs';

const fetch = createPoliteFetch({ userAgent: 'MyResearchBot/1.0 (+https://example.com/bot)' });
const res = await fetch('https://www.google.com/search?q=x');
res.status;                          // 403: robots.txt disallows /search, and no request was sent
res.headers.get('x-polite-fetch');   // 'robots'
```

## Why

Agents and crawlers get blocked for the same few reasons, and most of them are bugs on the crawler's side:

- **Hammering one host.** Twenty parallel jobs that each mean well still add up to twenty requests at once.
  polite-fetch sends one request at a time per host, a set gap apart.
- **Not seeing shared infrastructure.** `catalog.college-a.edu` and `catalog.college-b.edu` can both be CNAMEs to the
  same vendor's load balancer. To you they are a hundred hosts; to the vendor's firewall they are one very busy
  client. Groups match a host *or any name in its CNAME chain*, so those domains share one queue.
- **Retrying a challenge.** A 429, an AWS WAF challenge (`x-amzn-waf-action`) or a Cloudflare challenge
  (`cf-mitigated: challenge`) means "slow down". Retrying makes it worse, and working around it is worse still.
  polite-fetch stops sending to that host for a cool-down (15 minutes by default, or longer if `Retry-After` says
  so). Further calls fail fast with `BackOffError` and never reach the site.
- **Regex robots.txt.** Turning a robots.txt rule like `/*?*&*&*&*&*z` into a regular expression backtracks without
  end on a long URL. It froze a real crawl of ours for nine minutes at 100% CPU. The matcher here is linear time.
- **Timeouts that start in the queue.** If a request's 20-second timer starts when it is *created*, every request
  waiting behind a slow host times out without ever being sent. Here the timer starts when the request goes out.

## Usage

```js
const fetch = createPoliteFetch({
  userAgent: 'MyBot/1.0 (+https://example.com/bot)', // required: name your client and give a contact URL
  robotsAgent: 'MyBot',          // robots.txt group token; defaults to the first word of userAgent
  hostGapMs: 500,                // gap between requests to one host
  groups: [                      // hosts that share infrastructure, matched against the host and its CNAMEs
    { name: 'catalog-vendor', match: (h) => h.endsWith('.vendor-catalog.example'), gapMs: 3000 }
  ],
  coolDownMs: 15 * 60 * 1000,    // leave a host alone this long after 429 or a challenge
  timeoutMs: 20000,              // per request, from the moment it is sent
  respectRobots: true
});

const res = await fetch(url, init, { deadline: Date.now() + 150_000 }); // optional per-job deadline
```

It returns real `Response` objects, so you can pass it to any library that accepts a custom fetch.

| Situation | What happens |
| --- | --- |
| robots.txt disallows the URL | `403` response with `x-polite-fetch: robots`; nothing is sent |
| No robots.txt (4xx) | everything allowed (RFC 9309) |
| robots.txt unreachable (5xx, network error) | nothing allowed for this run (RFC 9309) |
| Host answered 429 or a bot challenge | the response is returned; later calls throw `BackOffError` until the cool-down ends |
| Job deadline passed | `DeadlineError`; nothing is sent |

`fetch.coolingDown()` lists the hosts and groups you are currently leaving alone.

Zero dependencies. Node 20+ (uses `fetch`, `AbortSignal.any`, `node:dns`).

## Free templates

- [Catalog crawler example](examples/crawl.mjs): many sites, a few at a time, with a shared-vendor group and a
  per-site deadline.

## What it doesn't do

- It does not solve CAPTCHAs, rotate IPs, or spoof browser user agents. A site that says no gets left alone.
  That is the design, not a missing feature.
- It does not render JavaScript. Pair it with a headless browser if you need rendered pages, and keep the same
  manners.
- It does not cache responses. Add your own cache in front if you re-read the same pages.

## License

MIT
