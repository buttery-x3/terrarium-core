import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb, ensureTables, World, DiagnosticError } from '@terrarium/persistence';
import { createChatGptPayload, type LmProvider } from '@terrarium/lm-providers';
import { performNews, previewNews } from '../src/news.js';

let db: ReturnType<typeof createDb>, world: World;
const story = { headline: 'A new garden opens for migrating butterflies', description: 'Volunteers have created a public butterfly garden.',
  category: 'nature', publishedAt: '2026-10-19T00:00:00.000Z', sourceUrls: ['https://example.org/garden'] };
const provider = (item: unknown = story, sources = story.sourceUrls): LmProvider => ({ name: 'fake', complete: async request => {
  await request.onRequest?.(createChatGptPayload(request));
  return { content: JSON.stringify({ item }), search: { sources: sources.map(url => ({ url })) } };
} });
const select = (model = provider(), signal = new AbortController().signal, current = () => true, notify = vi.fn()) =>
  performNews(world, model, signal, current, vi.fn(), notify, Date.now(), Date.now());
beforeEach(async () => {
  db = createDb(':memory:'); await ensureTables(db); world = new World(db);
  const settings = (await world.settings()).value;
  await world.saveSettings({ ...settings, news: { ...settings.news, enabled: true } });
});
afterEach(async () => { await db.destroy(); });

describe('shared searched news', () => {
  it('still closes the completed news turn if cleanup fails while releasing its execution pin', async () => {
    vi.spyOn(world, 'pruneDiagnostics').mockRejectedValueOnce(new DiagnosticError('Cleanup failed'));
    await expect(select()).rejects.toThrow('Cleanup failed');
    const rows = await db.selectFrom('decisions').selectAll().execute();
    expect(rows).toHaveLength(2);
    expect(rows.every(row => row.ended_at !== null && row.execution_pending === 0)).toBe(true);
    expect(rows.find(row => row.attempt === 1)?.outcome).toBe('applied');
  });
  it('previews the real search-enabled request using only shared news context', async () => {
    const agent = await world.saveAgent({ name: 'Private resident', instructions: 'SECRET PROFILE', roomId: 'room-1',
      provider: 'chatgpt', model: 'fake', enabled: true, minIntervalMs: 60000, maxIntervalMs: 150000, contextMessageLimit: 30 });
    await world.saveReflection(agent.id, agent.revision, { reaction: 'SECRET REACTION' }, () => true);
    const preview = await previewNews(world);
    expect(preview.payload).toMatchObject({ tools: [{ type: 'web_search' }], tool_choice: 'required' });
    expect(JSON.stringify(preview)).not.toContain('SECRET');
    expect((await world.diagnostics()).records).toEqual([]);
  });
  it('publishes one witnessed event, records exact search evidence, and supplies a current display to arrivals', async () => {
    const input = { instructions: 'Observe', roomId: 'room-1', provider: 'chatgpt' as const, model: 'fake', enabled: true,
      minIntervalMs: 60000, maxIntervalMs: 150000, contextMessageLimit: 30 };
    const local = await world.saveAgent({ ...input, name: 'Local' }), remote = await world.saveAgent({ ...input, name: 'Arrival', roomId: 'room-2' });
    const notify = vi.fn(); await select(provider(), undefined, undefined, notify);
    expect(notify).toHaveBeenCalledOnce(); expect((await world.memory(local.id)).map(item => item.type)).toEqual(['news']);
    expect(await world.memory(remote.id)).toEqual([]);
    const diagnostics = await world.diagnostics({}, true);
    const attempt = diagnostics.records.find(item => item.attempt === 1)!;
    expect(attempt.details?.payload).toMatchObject({ tools: [{ type: 'web_search' }] });
    expect(attempt.details?.searchSources).toEqual([{ url: story.sourceUrls[0] }]);
    await world.applyAction(remote.id, remote.revision, { type: 'move', roomId: 'room-1' }, () => true);
    const { contextProjection } = await import('../src/turns.js');
    const context = await contextProjection(world, (await world.agent(remote.id))!);
    expect(JSON.stringify(context)).toContain(story.headline);
    expect(context.memory.some(item => item.type === 'news')).toBe(false);
    expect(await world.newsDisplay('room-2')).toBeNull();
  });
  it('keeps the current item and exposes failures when search is absent or sources are fabricated', async () => {
    await select();
    const before = (await world.newsState()).current;
    await expect(select({ name: 'fake', complete: async () => ({ content: JSON.stringify({ item: story }) }) })).rejects.toThrow('completed web search');
    expect((await world.newsState()).current).toEqual(before);
    expect((await world.newsState()).error).toContain('completed web search');
    await expect(select(provider({ ...story, headline: 'Unsupported claim', sourceUrls: ['https://invented.example/story'] }))).rejects.toThrow();
    expect((await world.newsHistory()).items).toHaveLength(1);
  });
  it('allows no suitable new story and clears a prior retrieval error without inventing an event', async () => {
    await select();
    await expect(select({ name: 'failed', complete: async () => { throw Error('Search unavailable'); } })).rejects.toThrow();
    const notify = vi.fn(); await select(provider(null, []), undefined, undefined, notify);
    expect((await world.newsState()).error).toBeNull();
    expect((await world.newsState()).current?.headline).toBe(story.headline);
    expect(notify).not.toHaveBeenCalled(); expect((await world.newsHistory()).items).toHaveLength(1);
  });
  it('rejects late output after cancellation', async () => {
    const controller = new AbortController(); let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const complete = vi.fn(async () => { await pending; return { content: JSON.stringify({ item: story }), search: { sources: [{ url: story.sourceUrls[0] }] } }; });
    const running = select({ name: 'slow', complete }, controller.signal, () => !controller.signal.aborted);
    await vi.waitFor(() => expect(complete).toHaveBeenCalledOnce()); controller.abort(); release();
    await expect(running).rejects.toThrow(); expect((await world.newsState()).current).toBeNull();
    expect((await world.history({ roomId: 'room-1' })).messages).toEqual([]);
  });
  it('retains the committed item when notification fails', async () => {
    await expect(select(provider(), undefined, undefined, () => { throw Error('Socket unavailable'); })).rejects.toThrow('Socket unavailable');
    expect((await world.newsHistory()).items).toHaveLength(1);
    expect((await world.newsState()).error).toBeNull();
    expect((await world.diagnostics()).records.some(item => item.outcome === 'applied-notification-failure')).toBe(true);
  });
});
