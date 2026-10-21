import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb, ensureTables, World, DiagnosticError } from '@terrarium/persistence';
import { defaultSettings, type Agent } from '@terrarium/shared';
import { Scheduler } from '../src/scheduler.js';

let db: ReturnType<typeof createDb>, world: World, scheduler: Scheduler | undefined, agent: Agent;
beforeEach(async () => {
  db = createDb(':memory:'); await ensureTables(db); world = new World(db);
  agent = await world.saveAgent({ name: 'Observer', instructions: 'Observe.', roomId: 'room-1', provider: 'chatgpt', model: 'fake',
    enabled: true, minIntervalMs: 60000, maxIntervalMs: 150000, contextMessageLimit: 50 });
});
afterEach(async () => { await scheduler?.close(); scheduler = undefined; await db.destroy(); vi.useRealTimers(); vi.restoreAllMocks(); });
async function oldCompleted() {
  const turn = await world.scheduleTurn(agent, Date.now()), attempt = await world.startAttempt(turn, 1, agent);
  await world.updateDiagnostic(attempt, { output: 'Saved evidence' }, 'completed'); await world.settleAttempt(attempt);
  await world.endTurn(turn, 'completed');
  await db.updateTable('decisions').set({ ended_at: '2000-01-01T00:00:00.000Z' }).where('turn_id', '=', turn).execute();
  return { turn, attempt };
}

describe('diagnostic retention lifecycle', () => {
  it.each(['stopped', 'paused'] as const)('expires old evidence while %s without making model requests', async state => {
    const handler = vi.fn(async () => {}), publish = vi.fn();
    scheduler = new Scheduler(world, handler, publish);
    if (state === 'paused') { await scheduler.start(); scheduler.pause(); }
    const record = await oldCompleted();
    await scheduler.maintainDiagnostics();
    expect(scheduler.snapshot().state).toBe(state); expect(handler).not.toHaveBeenCalled();
    await expect(world.diagnostic(record.attempt)).rejects.toThrow('no longer retained');
    expect(publish).toHaveBeenCalled();
  });
  it('protects a timed-out handler that ignores abort until its actual promise settles', async () => {
    let finish!: () => void, attemptId = '';
    const handler = vi.fn(async (_agent, _signal, _current, _applied, id) => {
      attemptId = id!;
      await world.updateDiagnostic(attemptId, { payload: { exact: 'Original submitted evidence' } });
      await new Promise<void>(resolve => { finish = resolve; });
      await world.updateDiagnostic(attemptId, { output: 'Late ignored output' }, 'applied');
    });
    scheduler = new Scheduler(world, handler, () => {}, { concurrency: 4, timeoutMs: 15, retries: 0, backoffMs: 1 });
    await scheduler.start(); await scheduler.tick();
    await vi.waitFor(() => expect(scheduler!.snapshot().agents[0].state).toBe('error'));
    await scheduler.stop();
    await db.updateTable('decisions').set({ ended_at: '2000-01-01T00:00:00.000Z' }).execute();
    await scheduler.maintainDiagnostics();
    expect(await world.diagnostic(attemptId)).toMatchObject({ outcome: 'timeout', details: { payload: { exact: 'Original submitted evidence' } } });
    expect((await world.diagnosticUsage()).protectedBytes).toBeGreaterThan(0);
    finish();
    await vi.waitFor(async () => expect((await world.diagnostics()).records).toEqual([]));
    expect(scheduler.snapshot().state).toBe('stopped'); expect(handler).toHaveBeenCalledTimes(1);
  });
  it('admits rolling work above the target and still pauses for a real cleanup failure', async () => {
    await world.saveSettings({ ...defaultSettings, diagnostics: { retention: 'rolling-size', maxPayloadMiB: 32, maxAgeMinutes: 30 } });
    const protectedTurn = await world.scheduleTurn(agent, Date.now());
    await db.updateTable('decisions').set({ bytes: 40 * 1024 * 1024 }).where('id', '=', protectedTurn).execute();
    const handler = vi.fn(async () => {});
    scheduler = new Scheduler(world, handler, () => {}, { concurrency: 4, timeoutMs: 5000, retries: 0, backoffMs: 1 });
    await scheduler.start(); await scheduler.tick();
    await vi.waitFor(() => expect(scheduler!.snapshot().agents[0].state).toBe('scheduled'));
    expect(handler).toHaveBeenCalledOnce(); expect(scheduler.snapshot()).toMatchObject({ state: 'running' });
    expect(scheduler.snapshot().error).toBeUndefined();
    vi.spyOn(world, 'pruneDiagnostics').mockRejectedValueOnce(new DiagnosticError('Disk write failed'));
    await expect(scheduler.maintainDiagnostics()).rejects.toThrow('Disk write failed');
    expect(scheduler.snapshot()).toMatchObject({ state: 'paused', error: expect.stringContaining('Disk write failed') });
  });
  it('drains a cleanup backlog in bounded yielding passes and stops the maintenance timers on close', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
    const prune = vi.spyOn(world, 'pruneDiagnostics')
      .mockResolvedValueOnce({ deletedTurns: 100, deletedRecords: 200, freedBytes: 200000, hasMore: true })
      .mockResolvedValueOnce({ deletedTurns: 1, deletedRecords: 2, freedBytes: 2000, hasMore: false })
      .mockResolvedValue({ deletedTurns: 0, deletedRecords: 0, freedBytes: 0, hasMore: false });
    scheduler = new Scheduler(world, async () => {}, () => {}); scheduler.watch();
    await scheduler.maintainDiagnostics(); expect(prune).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(100); expect(prune).toHaveBeenCalledTimes(2);
    await scheduler.close(); const count = prune.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60000); expect(prune).toHaveBeenCalledTimes(count);
  });
});
