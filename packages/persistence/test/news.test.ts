import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'kysely';
import { defaultSettings, canonicalNewsUrl, newsProposalSchema, conversationMessageSchema, type NewsProposal } from '@terrarium/shared';
import { createDb, ensureTables, World } from '../src/index.js';

let db: ReturnType<typeof createDb>, world: World;
const directories: string[] = [];
const input = { name: 'Resident', instructions: 'Be curious.', roomId: 'room-1', provider: 'chatgpt' as const,
  model: 'fake', enabled: true, minIntervalMs: 1000, maxIntervalMs: 1000, contextMessageLimit: 50 };
const item: NewsProposal = { headline: 'A new marine species documented', description: 'Researchers report a newly documented marine species.',
  category: 'nature', publishedAt: '2026-10-19T00:00:00.000Z', sourceUrls: ['https://example.org/science/marine-species?utm_source=test#results'] };
beforeEach(async () => { db = createDb(':memory:'); await ensureTables(db); world = new World(db); });
afterEach(async () => {
  await db.destroy();
  for (const directory of directories.splice(0)) {
    if (!directory.startsWith(join(tmpdir(), 'terrarium-news-'))) throw new Error('Unsafe cleanup path');
    rmSync(directory, { recursive: true, force: true });
  }
});
const enableNews = async () => world.saveSettings({ ...defaultSettings, news: { ...defaultSettings.news, enabled: true } });
const publish = async (proposal = item) => world.publishNews(proposal, proposal.sourceUrls, (await world.settings()).version, () => true);

describe('shared current news', () => {
  it('publishes one attributed local event and gives arrivals only the current display', async () => {
    const local = await world.saveAgent(input), remote = await world.saveAgent({ ...input, roomId: 'room-2' });
    const disabled = await world.saveAgent({ ...input, enabled: false });
    await enableNews();
    await world.speak('room-1', 'Earlier local conversation');
    const published = await publish();
    expect(published.item).toMatchObject({ ...item, sourceUrls: ['https://example.org/science/marine-species'], id: expect.any(String), retrievedAt: expect.any(String) });
    expect(published.event).toMatchObject({ roomId: 'room-1', agentId: 'world-news', speaker: 'News display', type: 'news' });
    expect(published.event).not.toHaveProperty('conversationId');
    expect(conversationMessageSchema.parse(published.event)).toEqual(published.event);
    expect((await world.memory(local.id)).at(-1)).toEqual(published.event);
    expect((await world.memory(disabled.id)).at(-1)).toEqual(published.event);
    expect(await world.memory(remote.id)).toEqual([]);
    expect(await world.newsDisplay('room-2')).toBeNull();
    await world.applyAction(remote.id, remote.revision, { type: 'move', roomId: 'room-1' }, () => true);
    expect(await world.newsDisplay('room-1')).toEqual(published.item);
    expect((await world.memory(remote.id)).map(event => event.type)).toEqual(['departure', 'arrival']);
    await expect(world.applyAction(local.id, local.revision, { type: 'wait' }, () => true, undefined,
      { appraisals: [{ sourceId: published.event.id, reaction: 'like', reason: 'An interesting headline.' }] })).rejects.toThrow('Appraisals require');
    await world.saveRoom({ id: 'room-1', name: 'A renamed room', description: 'Same capability' });
    expect(await world.newsDisplay('room-1')).toEqual(published.item);
    await world.saveSettings({ ...defaultSettings, news: { ...defaultSettings.news, enabled: true, roomId: 'room-2' } });
    expect(await world.newsDisplay('room-1')).toBeNull();
    expect(await world.newsDisplay('room-2')).toEqual(published.item);
  });

  it('rejects ungrounded sources, invalid categories and duplicates while retaining the last display on failure or successful no-change checks', async () => {
    const settings = await enableNews();
    expect(canonicalNewsUrl('https://example.org/story?item=1&utm_campaign=a&fbclid=b#part')).toBe('https://example.org/story?item=1');
    for (const source of ['file:///secret', 'javascript:alert(1)', 'https://user:password@example.org/story'])
      expect(newsProposalSchema.safeParse({ ...item, sourceUrls: [source] }).success).toBe(false);
    await expect(world.publishNews(item, ['https://example.org/unrelated'], settings.version, () => true)).rejects.toThrow('completed web search');
    await expect(publish({ ...item, category: 'not configured' })).rejects.toThrow('configured topics');
    const first = await publish();
    await expect(publish({ ...item, headline: 'An alternative title for the same article' })).rejects.toThrow('repeats');
    await expect(publish({ ...item, headline: 'A NEW MARINE SPECIES DOCUMENTED!', sourceUrls: ['https://another.example/story'] })).rejects.toThrow('repeats');
    const failed = await world.recordNewsFailure('Search unavailable', settings.version, () => true);
    expect(failed.current).toEqual(first.item); expect(failed.error).toBe('Search unavailable');
    const agent = await world.saveAgent({ ...input, name: 'Diagnostic job identity' });
    const attempt = await world.startAttempt(await world.scheduleTurn(agent, Date.now(), 'news'), 1, agent);
    const checked = await world.recordNewsCheck(settings.version, () => true, attempt);
    expect(checked.current).toEqual(first.item); expect(checked.error).toBeNull();
    expect((await world.history({ roomId: 'room-1' })).messages).toHaveLength(1);
    expect(await world.diagnostic(attempt)).toMatchObject({ outcome: 'applied-noop', action: 'news', details: { eventIds: [] } });
    await expect(world.recordNewsCheck(settings.version, () => true, attempt)).rejects.toThrow('already ended');
    const second = await publish({ ...item, headline: 'An upcoming championship announced', category: 'sport and upcoming events', publishedAt: null, sourceUrls: ['https://example.org/sport/championship'] });
    expect((await world.newsHistory({ limit: 1 })).items).toEqual([second.item]);
    expect((await world.newsHistory({ limit: 1 })).hasMore).toBe(true);
    expect((await world.newsHistory({ before: second.item.sequence })).items).toEqual([first.item]);
  });

  it('rolls back news state, identity, observation delivery and diagnostics on write failure or stale completion', async () => {
    const settings = await enableNews(), agent = await world.saveAgent(input);
    const attempt = await world.startAttempt(await world.scheduleTurn(agent, Date.now(), 'news'), 1, agent);
    await sql`CREATE TRIGGER reject_news_evidence BEFORE UPDATE ON decisions WHEN NEW.outcome = 'applied' BEGIN SELECT RAISE(ABORT, 'News evidence failed'); END`.execute(db);
    await expect(world.publishNews(item, item.sourceUrls, settings.version, () => true, attempt)).rejects.toThrow('News evidence failed');
    expect((await world.newsState()).current).toBeNull(); expect((await world.newsHistory()).items).toEqual([]); expect(await world.memory(agent.id)).toEqual([]);
    await sql`DROP TRIGGER reject_news_evidence`.execute(db);
    let checks = 0;
    await expect(world.publishNews(item, item.sourceUrls, settings.version, () => ++checks === 1, attempt)).rejects.toThrow('no longer current');
    expect((await world.newsState()).current).toBeNull(); expect(await world.memory(agent.id)).toEqual([]);
    await sql`CREATE TRIGGER reject_news_observation BEFORE INSERT ON observations BEGIN SELECT RAISE(ABORT, 'Observation failed'); END`.execute(db);
    await expect(publish()).rejects.toThrow('Observation failed');
    await sql`DROP TRIGGER reject_news_observation`.execute(db);
    const published = await world.publishNews(item, item.sourceUrls, settings.version, () => true, attempt);
    expect((await world.diagnostic(attempt)).details?.news).toEqual(published.item);
    await expect(world.publishNews({ ...item, headline: 'Duplicate attempt', sourceUrls: ['https://example.org/another'] }, ['https://example.org/another'], settings.version, () => true, attempt)).rejects.toThrow('already ended');
    await world.saveSettings({ ...defaultSettings, news: { ...defaultSettings.news, enabled: true, intervalMs: 120000 } });
    await expect(world.recordNewsFailure('Late failure', settings.version, () => true)).rejects.toThrow('no longer current');
    expect((await world.newsState()).error).toBeNull();
  });

  it('keeps persisted deduplication and current display across history clearing and restart', async () => {
    await db.destroy(); const directory = mkdtempSync(join(tmpdir(), 'terrarium-news-')); directories.push(directory);
    const path = join(directory, 'restart.db'); db = createDb(path); await ensureTables(db); world = new World(db);
    await enableNews(); const published = await publish();
    await world.clearHistory({ scope: 'all' });
    expect((await world.newsState()).current).toEqual(published.item);
    await db.destroy(); db = createDb(path); await ensureTables(db); world = new World(db); await world.interruptUnfinished();
    expect(await world.newsDisplay('room-1')).toEqual(published.item);
    await expect(publish({ ...item, sourceUrls: ['https://example.org/science/marine-species?gclid=another'] })).rejects.toThrow('repeats');
    expect((await world.history({ roomId: 'room-1' })).messages).toEqual([]);
    const exported = await world.exportConfiguration();
    expect(exported.version).toBe(8); expect(JSON.stringify(exported)).not.toContain(item.headline);
  });

  it('upgrades version 5 without renaming rooms or changing existing private state and validates explicit room assignment', async () => {
    await world.saveRoom({ id: 'room-1', name: 'Reading Room', description: 'Authored room description' });
    const agent = await world.saveAgent({ ...input, intention: 'Authored intention' });
    await world.saveReflection(agent.id, agent.revision, { reaction: 'Preserved state', intention: 'Observe' }, () => true);
    const source = await world.speak('room-1', 'Preserved archive');
    const { news, media, prompts: { newsSelection, mediaParticipation, mediaVote, ...prompts }, ...settings } = defaultSettings;
    await db.updateTable('settings').set({ value: JSON.stringify({ ...settings, scheduling: { ...settings.scheduling, reflectionIntervalMs: 120000 },
      relationships: { ...settings.relationships, maxAppraisalsPerReflection: 1 }, prompts: { ...prompts, relationshipSummary: 'Custom summary instructions' } }) }).execute();
    for (const table of ['news_items', 'news_sources', 'news_state'] as const) await db.schema.dropTable(table).execute();
    await db.deleteFrom('schema_migrations').where('version', '=', 6).execute();
    await ensureTables(db); await ensureTables(db);
    expect((await world.settings()).value).toMatchObject({ news: { ...news, enabled: false }, scheduling: { reflectionIntervalMs: 120000 },
      relationships: { maxAppraisalsPerReflection: 1 }, prompts: { relationshipSummary: 'Custom summary instructions', newsSelection } });
    expect((await world.rooms()).find(room => room.id === 'room-1')).toMatchObject({ name: 'Reading Room', description: 'Authored room description' });
    expect((await world.reflection(agent.id)).reaction).toBe('Preserved state'); expect((await world.memory(agent.id))[0]).toEqual(source);
    await expect(world.saveSettings({ ...defaultSettings, news: { ...news, enabled: true, roomId: 'missing' } })).rejects.toThrow('existing assigned room');
    const configuration = await world.exportConfiguration(); configuration.settings!.news = { ...news, enabled: true, roomId: 'new-news-room' };
    await expect(world.previewConfiguration(configuration)).rejects.toThrow('existing assigned room');
    configuration.rooms.push({ id: 'new-news-room', name: 'News Room', description: 'Current news', isFoodSource: false });
    await world.importConfiguration(configuration, (await world.previewConfiguration(configuration)).token);
    expect((await world.settings()).value.news.roomId).toBe('new-news-room');
    expect(await world.newsDisplay('new-news-room')).toBeNull();
  });
});
