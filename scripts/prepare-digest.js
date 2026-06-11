#!/usr/bin/env node
// ============================================================================
// Follow Builders — Prepare Digest (v2.1: RSS rotation + bilingual default)
// ============================================================================
// Changes:
// - RSS: fetch only 3 sources per day, rotating through the full list
// - Default language: bilingual
// ============================================================================

import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const USER_DIR = join(homedir(), '.follow-builders');
const CONFIG_PATH = join(USER_DIR, 'config.json');

const FEED_X_URL = 'https://raw.githubusercontent.com/Charlottttttttttttte/follow-builders/main/feed-x.json';
const FEED_PODCASTS_URL = 'https://raw.githubusercontent.com/Charlottttttttttttte/follow-builders/main/feed-podcasts.json';
const FEED_BLOGS_URL = 'https://raw.githubusercontent.com/Charlottttttttttttte/follow-builders/main/feed-blogs.json';

const PROMPTS_BASE = 'https://raw.githubusercontent.com/Charlottttttttttttte/follow-builders/main/prompts';
const PROMPT_FILES = [
  'summarize-podcast.md',
  'summarize-tweets.md',
  'summarize-blogs.md',
  'digest-intro.md',
  'translate.md'
];

async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) return null;
  return res.json();
}

async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) return null;
  return res.text();
}

// -- RSS Parsing (zero dependencies) -----------------------------------------

async function fetchRSS(url) {
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/rss+xml, application/atom+xml, application/xml' },
      signal: AbortSignal.timeout(15000)
    });
    if (!res.ok) return null;
    const text = await res.text();
    return parseRSS(text);
  } catch (err) {
    return null;
  }
}

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
  const regex = new RegExp(`<${tag}[^>]*>([\s\S]*?)</${tag}>`, 'i');
  const m = xml.match(regex);
  return m ? m[1].replace(/<[^>]+>/g, '').trim() : null;
}

function extractAttr(xml, tag, attr) {
  const regex = new RegExp(`<${tag}[^>]*${attr}=["']([^"']+)["'][^>]*>`, 'i');
  const m = xml.match(regex);
  return m ? m[1].trim() : null;
}

// -- RSS Batch Fetching ------------------------------------------------------

async function fetchRSSFeeds(sources) {
  if (!sources || !sources.length) return [];

  const results = await Promise.all(
    sources.map(async (src) => {
      const items = await fetchRSS(src.rssUrl);
      if (!items || !items.length) return null;
      return {
        source: 'blog',
        name: src.name,
        title: items[0].title,
        url: items[0].link || src.htmlUrl,
        publishedAt: items[0].pubDate,
        author: '',
        description: items[0].description,
        content: items[0].content
      };
    })
  );

  return results.filter(Boolean);
}

// -- Daily rotation helper ---------------------------------------------------

function getDailyBatch(sources, batchSize = 3) {
  if (!sources || !sources.length) return [];
  // Use UTC days since epoch for consistent rotation
  const dayIndex = Math.floor(Date.now() / 86400000);
  const totalBatches = Math.max(1, Math.ceil(sources.length / batchSize));
  const batchIndex = dayIndex % totalBatches;
  const start = batchIndex * batchSize;
  const end = Math.min(start + batchSize, sources.length);
  return sources.slice(start, end);
}

// -- Main --------------------------------------------------------------------

async function main() {
  const errors = [];

  // Default to bilingual
  let config = { language: 'bilingual', frequency: 'daily', delivery: { method: 'stdout' } };
  if (existsSync(CONFIG_PATH)) {
    try {
      const userConfig = JSON.parse(await readFile(CONFIG_PATH, 'utf-8'));
      config = { ...config, ...userConfig };
    } catch (err) {
      errors.push(`Could not read config: ${err.message}`);
    }
  }

  const [feedX, feedPodcasts, feedBlogs] = await Promise.all([
    fetchJSON(FEED_X_URL),
    fetchJSON(FEED_PODCASTS_URL),
    fetchJSON(FEED_BLOGS_URL)
  ]);

  if (!feedX) errors.push('Could not fetch tweet feed');
  if (!feedPodcasts) errors.push('Could not fetch podcast feed');
  if (!feedBlogs) errors.push('Could not fetch blog feed');

  // 3 RSS sources per day, rotating
  let rssPosts = [];
  if (feedBlogs?.rssSources && feedBlogs.rssSources.length > 0) {
    try {
      const dailySources = getDailyBatch(feedBlogs.rssSources, 3);
      rssPosts = await fetchRSSFeeds(dailySources);
    } catch (err) {
      errors.push(`RSS fetch error: ${err.message}`);
    }
  }

  const prompts = {};
  const scriptDir = decodeURIComponent(new URL('.', import.meta.url).pathname);
  const localPromptsDir = join(scriptDir, '..', 'prompts');
  const userPromptsDir = join(USER_DIR, 'prompts');

  for (const filename of PROMPT_FILES) {
    const key = filename.replace('.md', '').replace(/-/g, '_');
    const userPath = join(userPromptsDir, filename);
    const localPath = join(localPromptsDir, filename);

    if (existsSync(userPath)) {
      prompts[key] = await readFile(userPath, 'utf-8');
      continue;
    }
    const remote = await fetchText(`${PROMPTS_BASE}/${filename}`);
    if (remote) {
      prompts[key] = remote;
      continue;
    }
    if (existsSync(localPath)) {
      prompts[key] = await readFile(localPath, 'utf-8');
    } else {
      errors.push(`Could not load prompt: ${filename}`);
    }
  }

  const staticBlogs = feedBlogs?.blogs || [];
  const allBlogs = [...staticBlogs, ...rssPosts];

  const output = {
    status: 'ok',
    generatedAt: new Date().toISOString(),
    config: {
      language: config.language || 'bilingual',
      frequency: config.frequency || 'daily',
      delivery: config.delivery || { method: 'stdout' }
    },
    podcasts: feedPodcasts?.podcasts || [],
    x: feedX?.x || [],
    blogs: allBlogs,
    stats: {
      podcastEpisodes: feedPodcasts?.podcasts?.length || 0,
      xBuilders: feedX?.x?.length || 0,
      totalTweets: (feedX?.x || []).reduce((sum, a) => sum + a.tweets.length, 0),
      blogPosts: allBlogs.length,
      rssSourcesFetched: rssPosts.length,
      rssSourcesToday: feedBlogs?.rssSources ? getDailyBatch(feedBlogs.rssSources, 3).map(s => s.name) : [],
      feedGeneratedAt: feedX?.generatedAt || feedPodcasts?.generatedAt || feedBlogs?.generatedAt || null
    },
    prompts,
    errors: errors.length > 0 ? errors : undefined
  };

  console.log(JSON.stringify(output, null, 2));
}

main().catch((err) => {
  console.error(JSON.stringify({ status: 'error', message: err.message }));
  process.exit(1);
});
