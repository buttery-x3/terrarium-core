import { describe, expect, it, vi } from 'vitest';
import { render } from 'svelte/server';
import type { NewsItem as NewsRecord } from '@terrarium/shared';
import NewsItem from '../src/NewsItem.svelte';
import NewsPanel from '../src/NewsPanel.svelte';
import ActivityItem from '../src/ActivityItem.svelte';

describe('sourced news display', () => {
  const item: NewsRecord = {
    id: 'news-1', sequence: 1, headline: 'A new nature trail opens', description: 'The trail opens on Saturday.', category: 'Nature',
    publishedAt: null, retrievedAt: '2026-10-19T00:00:00.000Z', sourceUrls: ['https://example.org/trail-opening'],
  };
  it('keeps source attribution and retrieval time separate from an unknown publication time', () => {
    const html = render(NewsItem, { props: { item } }).body;
    expect(html).toContain(item.headline);
    expect(html).toContain(item.description);
    expect(html).toContain('Topic: Nature');
    expect(html).toContain('Publication time not supplied.');
    expect(html).toContain('datetime="2026-10-19T00:00:00.000Z"');
    expect(html).toContain('href="https://example.org/trail-opening"');
    expect(html).toContain('news-1');
  });
  it('escapes untrusted news text and refuses executable source URLs', () => {
    const html = render(NewsItem, { props: { item: { ...item, headline: '<script>headline</script>',
      description: '<img src=x onerror=alert(1)>', sourceUrls: ['javascript:alert(1)', 'https://example.org/safe'],
    } } }).body;
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('href="javascript:');
    expect(html).toContain('&lt;script>headline&lt;/script>');
    expect(html).toContain('href="https://example.org/safe"');
  });
  it('renders news as room display content rather than attributed speech or an agent emote', () => {
    const html = render(ActivityItem, { props: { item: {
      id: 'event-1', roomId: 'room-1', agentId: 'world-news', speaker: 'News display', createdAt: item.retrievedAt,
      type: 'news', content: item.headline,
    } } }).body;
    expect(html).toContain('data-event-type="news"');
    expect(html).toContain(`News display: ${item.headline}`);
    expect(html).not.toContain('<em>');
  });
  it('shows an honest empty state without starting a selection request', () => {
    const request = vi.fn();
    const html = render(NewsPanel, { props: { connected: false, enabled: false, roomName: 'News Room', request } }).body;
    expect(html).toContain('No headline has been selected yet.');
    expect(html).toContain('News selection disabled.');
    expect(html).toContain('Next selection: Not scheduled');
    expect(html).not.toContain('Invalid Date');
    expect(request).not.toHaveBeenCalled();
  });
});
