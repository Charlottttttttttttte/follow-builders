#!/usr/bin/env node
// ============================================================================
// Follow Builders — RSS Feed Generator (Zero API keys)
// ============================================================================
// Fetches upstream static blogs + rotates through user's RSS sources daily.
// ============================================================================

import { readFile, writeFile } from 'fs/promises';

const UPSTREAM_BLOGS_PATH = '/tmp/feed-blogs-upstream.json';
const LOCAL_FEED_PATH = 'feed-blogs.json';
const BATCH_SIZE = 3;

// -- RSS Parsing (zero dependencies) ---------------------------------------

function parseRSS(xml) {
  const items = [];
  const itemRegex = /<item[\s\S]*?<\/item>/g;
  let match;
  while ((match = itemRegex.exec(xml)) !== null) {
    items.push(parseItem(match[0]));
  }
  const entryRegex = /<entry[\s\S]*?<\/entry>/g;
  while ((match = entryRegex.exec(xml)) !== null) {
    items.push(parseEntry(match[0]));
  }
  return items;
}

function parseItem(item) {
  return {
    title: extractTag(item, 'title') || '',
    link: extractTag(item, 'link') || extractAttr(item, 'link', 'href') || '',
    description: extractTag(item, 'description') || extractTag(item, 'summary') || '',
    pubDate: extractTag(item, 'pubDate') || extractTag(item, 'published') || '',
    content: extractTag(item, 'content:encoded') || extractTag(item, 'content') || extractTag(item, 'description') || ''
  };
}

function parseEntry(entry) {
  return {
    title: extractTag(entry, 'title') || '',
    link: extractAttr(entry, 'link', 'href') || extractTag(entry, 'link') || '',
    description: extractTag(entry, 'summary') || extractTag(entry, 'content') || '',
    pubDate: extractTag(entry, 'published') || extractTag(entry, 'updated') || extractTag(entry, 'pubDate') || '',
    content: extractTag(entry, 'content') || extractTag(entry, 'summary') || ''
  };
}

function extractTag(xml, tag) {
  const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const m = xml.match(regex);
  if (!m) return null;
  let content = m[1];
  content = content.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  content = content.replace(/<[^>]+>/g, '').trim();
  return content || null;
}

function extractAttr(xml, tag, attr) {
  const regex = new RegExp(`<${tag}[^>]*${attr}=["']([^"']+)["'][^>]*>`, 'i');
  const m = xml.match(regex);
  return m ? m[1].trim() : null;
}

// -- Daily Rotation ----------------------------------------------------------

function getDailyBatch(sources, batchSize = 3) {
  if (!sources || !sources.length) return [];
  const dayIndex = Math.floor(Date.now() / 86400000);
  const totalBatches = Math.ceil(sources.length / batchSize);
  const batchIndex = dayIndex % totalBatches;
  const start = batchIndex * batchSize;
  return sources.slice(start, start + batchSize);
}

// -- RSS Fetching ------------------------------------------------------------

async function fetchRSS(url) {
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/rss+xml, application/atom+xml, application/xml' },
      signal: AbortSignal.timeout(15000)
    });
    if (!res.ok) return null;
    return parseRSS(await res.text());
  } catch (err) {
    console.error(`    RSS fetch failed: ${url} — ${err.message}`);
    return null;
  }
}

// -- Main --------------------------------------------------------------------

async function main() {
  const errors = [];

  // 1. Read local feed-blogs.json for rssSources
  let localFeed;
  try {
    localFeed = JSON.parse(await readFile(LOCAL_FEED_PATH, 'utf-8'));
  } catch (err) {
    console.error(`Failed to read ${LOCAL_FEED_PATH}: ${err.message}`);
    process.exit(1);
  }

  const rssSources = localFeed.rssSources || [];
  const staticBlogs = localFeed.blogs || localFeed.sources || [];

  // 2. Read upstream blogs (optional fallback)
  let upstreamBlogs = [];
  try {
    const upstream = JSON.parse(await readFile(UPSTREAM_BLOGS_PATH, 'utf-8'));
    upstreamBlogs = upstream.blogs || upstream.sources || [];
  } catch (err) {
    console.error(`Upstream blogs not available: ${err.message}`);
  }

  // 3. Fetch today's RSS batch
  const batch = getDailyBatch(rssSources, BATCH_SIZE);
  const totalBatches = Math.ceil(rssSources.length / BATCH_SIZE) || 1;
  const currentBatch = (Math.floor(Date.now() / 86400000) % totalBatches) + 1;
  console.log(`RSS: batch ${currentBatch}/${totalBatches} — ${batch.length} sources today`);

  const rssResults = await Promise.all(
    batch.map(async (src) => {
      console.log(`  Fetching: ${src.name}`);
      const items = await fetchRSS(src.rssUrl);
      if (!items || !items.length) {
        errors.push(`No items from ${src.name}`);
        return null;
      }
      const item = items[0];
      console.log(`    → ${item.title}`);
      return {
        source: 'blog',
        name: src.name,
        title: item.title,
        url: item.link || src.htmlUrl,
        publishedAt: item.pubDate,
        author: '',
        description: item.description,
        content: item.content
      };
    })
  );

  const rssPosts = rssResults.filter(Boolean);

  // 4. Merge & deduplicate by URL
  const seenUrls = new Set();
  const allBlogs = [];

  for (const blog of [...upstreamBlogs, ...staticBlogs, ...rssPosts]) {
    const url = blog.url || blog.link;
    if (url && seenUrls.has(url)) continue;
    if (url) seenUrls.add(url);
    allBlogs.push(blog);
  }

  // 5. Write new feed-blogs.json
  const output = {
    generatedAt: new Date().toISOString(),
    sources: localFeed.sources || [],
    blogs: allBlogs,
    rssSources: rssSources,
    stats: {
      ...(localFeed.stats || {}),
      blogPosts: allBlogs.length,
      rssSourcesFetched: rssPosts.length,
      rssSourcesTotal: rssSources.length,
      staticPosts: upstreamBlogs.length + staticBlogs.length
    },
    errors: errors.length > 0 ? errors : undefined
  };

  await writeFile(LOCAL_FEED_PATH, JSON.stringify(output, null, 2));
  console.log(`\nDone: ${allBlogs.length} total posts (${rssPosts.length} RSS, ${upstreamBlogs.length + staticBlogs.length} static)`);
  if (errors.length) {
    console.log(`Errors: ${errors.length}`);
    errors.forEach(e => console.log(`  - ${e}`));
  }
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
