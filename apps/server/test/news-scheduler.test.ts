import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb, ensureTables, World, DiagnosticError } from '@terrarium/persistence';
import { defaultSettings, type AgentInput, type NewsItem } from '@terrarium/shared';
import { Scheduler } from '../src/scheduler.js';

let db: ReturnType<typeof createDb>, world: World;
const schedulers: Scheduler[] = [];
const input: AgentInput = { name: 'Observer', instructions: 'Observe quietly.', roomId: 'room-1', provider: 'chatgpt', model: 'fake', enabled: true,
  minIntervalMs: 1000, maxIntervalMs: 1000, contextMessageLimit: 50 };
const currentNews: NewsItem = { id: 'news-1', sequence: 1, headline: 'A restored garden opens this weekend', description: 'Visitors can explore the garden.',
  category: 'nature', publishedAt: null, sourceUrls: ['https://example.org/garden'], retrievedAt: '2020-01-01T00:00:00.000Z' };
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};
const createScheduler = (news: NonNullable<ConstructorParameters<typeof Scheduler>[5]>,
  handler: ConstructorParameters<typeof Scheduler>[1] = async () => {}, timeoutMs = 5000) => {
  const scheduler = new Scheduler(world, handler, () => {}, { concurrency: 4, timeoutMs, retries: 2, backoffMs: 1 }, undefined, news);
  schedulers.push(scheduler); return scheduler;
};
const enableNews = () => world.saveSettings({ ...defaultSettings, news: { ...defaultSettings.news, enabled: true, intervalMs: 1000 } });

beforeEach(async () => { db = createDb(':memory:'); await ensureTables(db); world = new World(db); });
afterEach(async () => {
  await Promise.all(schedulers.splice(0).map(scheduler => scheduler.close()));
  await db.destroy(); vi.restoreAllMocks();
});

describe('shared news scheduling', () => {
  it('reports a late diagnostic write failure after a news timeout has already released its active operation', async () => {
    await enableNews(); const pending = deferred();
    const scheduler = createScheduler(async () => { await pending.promise; throw new DiagnosticError('Late diagnostic write failed'); }, async () => {}, 10);
    await scheduler.start(); await scheduler.tick();
    await vi.waitFor(() => expect(scheduler.snapshot().newsError).toContain('timed out'));
    pending.resolve();
    await vi.waitFor(() => expect(scheduler.snapshot()).toMatchObject({ state: 'paused', error: expect.stringContaining('Late diagnostic write failed') }));
    expect(scheduler.hasActiveWork()).toBe(false);
  });
  it('runs immediately only when enabled without a current display and creates no resident entry', async () => {
    let now = 1000000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const news = vi.fn(async () => {}), scheduler = createScheduler(news);
    await scheduler.start(); await scheduler.tick();
    expect(news).not.toHaveBeenCalled();
    expect(scheduler.snapshot().nextNewsAt).toBeUndefined();
    await scheduler.stop(); await enableNews(); await scheduler.start();
    expect(scheduler.snapshot().nextNewsAt).toBe(now);
    await scheduler.tick();
    await vi.waitFor(() => expect(scheduler.snapshot().nextNewsAt).toBe(1001000));
    expect(news).toHaveBeenCalledOnce();
    expect(news.mock.calls[0].slice(3)).toEqual([1000000, 1000000]);
    expect(scheduler.snapshot().agents).toEqual([]);
    expect(await world.agents()).toEqual([]);
    now = 1000999; await scheduler.tick(); expect(news).toHaveBeenCalledOnce();
  });

  it('waits a fresh interval on Start when a display already exists without replaying overdue polls', async () => {
    let now = 1000000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    await enableNews();
    vi.spyOn(world, 'newsDisplay').mockResolvedValue(currentNews);
    const news = vi.fn(async () => {}), scheduler = createScheduler(news);
    await scheduler.start(); await scheduler.tick();
    expect(news).not.toHaveBeenCalled();
    expect(scheduler.snapshot().nextNewsAt).toBe(1001000);
    await scheduler.stop(); now = 2000000;
    await scheduler.start(); await scheduler.tick();
    expect(news).not.toHaveBeenCalled();
    expect(scheduler.snapshot().nextNewsAt).toBe(2001000);
    now = 2001000; await scheduler.tick();
    await vi.waitFor(() => expect(news).toHaveBeenCalledOnce());
  });

  it('counts a shared news request against the same four slots as resident operations', async () => {
    await enableNews();
    for (let index = 0; index < 5; index++) await world.saveAgent({ ...input, name: `Agent ${index}` });
    const running = new Map<string, ReturnType<typeof deferred>>();
    let peak = 0;
    const begin = async (id: string) => {
      expect(running.has(id)).toBe(false);
      const pending = deferred(); running.set(id, pending); peak = Math.max(peak, running.size);
      await pending.promise; running.delete(id);
    };
    const scheduler = createScheduler(() => begin('news'), agent => begin(agent.id));
    await scheduler.start(); await scheduler.tick();
    await vi.waitFor(() => expect(running.size).toBe(4));
    expect(running.has('news')).toBe(true);
    expect([...running.keys()].filter(id => id !== 'news')).toHaveLength(3);
    await scheduler.tick(); expect(running.size).toBe(4); expect(peak).toBe(4);
    for (const pending of running.values()) pending.resolve();
    await vi.waitFor(() => expect(running.size).toBe(0));
  });

  it('freezes future news clocks and lets an active request finish during Pause', async () => {
    let now = 1000000, stillCurrent: (() => boolean) | undefined;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    await enableNews();
    const pending = deferred(), news = vi.fn(async (_signal, current) => { stillCurrent = current; await pending.promise; });
    const scheduler = createScheduler(news);
    await scheduler.start(); await scheduler.tick();
    now = 1000400; scheduler.pause();
    now = 1010400;
    expect(stillCurrent!()).toBe(true);
    pending.resolve();
    await vi.waitFor(() => expect(scheduler.snapshot().nextNewsAt).toBe(1001400));
    await scheduler.start();
    expect(scheduler.snapshot().nextNewsAt).toBe(1011400);
    now = 1011399; await scheduler.tick(); expect(news).toHaveBeenCalledOnce();
    now = 1011400; await scheduler.tick();
    await vi.waitFor(() => expect(news).toHaveBeenCalledTimes(2));
  });

  it('retains a timed-out news slot until an abort-ignoring handler settles, including across Stop', async () => {
    let now = 1000000, stillCurrent: (() => boolean) | undefined;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    await enableNews();
    const pending = deferred(), news = vi.fn(async (_signal, current) => { stillCurrent = current; await pending.promise; });
    const scheduler = createScheduler(news, async () => {}, 10);
    await scheduler.start(); await scheduler.tick();
    await vi.waitFor(() => expect(scheduler.snapshot().newsError).toContain('timed out'));
    expect(news).toHaveBeenCalledOnce(); expect(stillCurrent!()).toBe(false);
    now = 1005000; await scheduler.tick(); expect(news).toHaveBeenCalledOnce();
    await scheduler.stop();
    expect(scheduler.hasActiveWork()).toBe(true);
    await scheduler.start(); await scheduler.tick(); expect(news).toHaveBeenCalledOnce();
    pending.resolve();
    await vi.waitFor(() => expect(scheduler.hasActiveWork()).toBe(false));
    await scheduler.tick();
    await vi.waitFor(() => expect(news).toHaveBeenCalledTimes(2));
  });

  it('reports a failed poll and waits for the next interval without retry bursts', async () => {
    let now = 1000000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    await enableNews();
    const news = vi.fn().mockRejectedValueOnce(new Error('Search was unavailable.')).mockResolvedValue(undefined);
    const scheduler = createScheduler(news);
    await scheduler.start(); await scheduler.tick();
    await vi.waitFor(() => expect(scheduler.snapshot().newsError).toBe('Search was unavailable.'));
    expect(news).toHaveBeenCalledOnce();
    expect(scheduler.snapshot().nextNewsAt).toBe(1001000);
    now = 1000999; await scheduler.tick(); expect(news).toHaveBeenCalledOnce();
    now = 1001000; await scheduler.tick();
    await vi.waitFor(() => expect(scheduler.snapshot().nextNewsAt).toBe(1002000));
    expect(news).toHaveBeenCalledTimes(2); expect(scheduler.snapshot().newsError).toBeUndefined();
  });
});
