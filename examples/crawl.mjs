// Read many sites a few at a time, politely: one request at a time per host, one queue for a shared vendor,
// a deadline per site, and sites that push back are skipped rather than retried.
// Usage: node examples/crawl.mjs https://site-one.example https://site-two.example ...
import { BackOffError, createPoliteFetch, DeadlineError } from '../polite-fetch.mjs';

const fetch = createPoliteFetch({
  userAgent: 'ExampleCrawler/1.0 (+https://example.com/crawler)',
  groups: [{ name: 'catalog-vendor', match: (h) => /\.vendor-catalog\.example$/.test(h), gapMs: 3000 }]
});

async function visit(site) {
  try {
    const res = await fetch(site, {}, { deadline: Date.now() + 150_000 });
    if (res.headers.get('x-polite-fetch') === 'robots') return { site, status: 'robots_disallowed' };
    const html = await res.text();
    return { site, status: res.status, title: /<title>([^<]*)/i.exec(html)?.[1]?.trim() || null };
  } catch (error) {
    if (error instanceof BackOffError) return { site, status: 'backing_off', until: new Date(error.until).toISOString() };
    if (error instanceof DeadlineError) return { site, status: 'deadline' };
    return { site, status: 'error', detail: error.message };
  }
}

const sites = process.argv.slice(2);
let next = 0;
await Promise.all(Array.from({ length: 6 }, async () => {
  while (next < sites.length) console.log(JSON.stringify(await visit(sites[next++])));
}));
