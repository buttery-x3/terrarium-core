import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'kysely';
import { defaultSettings, type Agent, type Settings } from '@terrarium/shared';
import { createDb, ensureTables, World } from '../src/index.js';

let db: ReturnType<typeof createDb>, world: World, agent: Agent;
const start = Date.parse('2026-10-22T00:00:00.000Z');
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(start);
  db = createDb(':memory:'); await ensureTables(db); world = new World(db);
  agent = await world.saveAgent({ name: 'Observer', instructions: 'Watch.', roomId: 'room-1', provider: 'chatgpt', model: 'fake',
    enabled: true, minIntervalMs: 1000, maxIntervalMs: 1000, contextMessageLimit: 50 });
});
afterEach(async () => { vi.useRealTimers(); await db.destroy(); });
async function policy(retention: Settings['diagnostics']['retention'], maxAgeMinutes = 30) {
  await world.saveSettings({ ...defaultSettings, diagnostics: { retention, maxAgeMinutes, maxPayloadMiB: 32 } });
}
async function completed(attempts = 1) {
  const turn = await world.scheduleTurn(agent, Date.now()), ids: string[] = [];
  for (let number = 1; number <= attempts; number++) {
    const id = await world.startAttempt(turn, number, agent); ids.push(id);
    await world.updateDiagnostic(id, { output: `Evidence ${number}` }, number === attempts ? 'applied' : 'provider');
    await world.settleAttempt(id);
  }
  await world.endTurn(turn, 'completed'); return { turn, ids };
}

describe('whole-turn diagnostic retention', () => {
  it('defaults to 30 wall-clock minutes and expires the whole retry group at the completion boundary', async () => {
    expect((await world.settings()).value.diagnostics).toEqual({ retention: 'rolling-time', maxAgeMinutes: 30, maxPayloadMiB: 256 });
    const turn = await world.scheduleTurn(agent, Date.now());
    const first = await world.startAttempt(turn, 1, agent);
    await world.updateDiagnostic(first, { output: 'First failure' }, 'provider'); await world.settleAttempt(first);
    vi.setSystemTime(start + 10 * 60000);
    const second = await world.startAttempt(turn, 2, agent);
    await world.updateDiagnostic(second, { output: 'Final evidence' }, 'applied'); await world.settleAttempt(second);
    await world.endTurn(turn, 'completed');
    vi.setSystemTime(start + 40 * 60000 - 1);
    expect((await world.pruneDiagnostics()).deletedRecords).toBe(0);
    expect((await world.diagnostics({}, true)).records).toHaveLength(3);
    vi.setSystemTime(start + 40 * 60000);
    expect(await world.pruneDiagnostics()).toMatchObject({ deletedTurns: 1, deletedRecords: 3 });
    expect((await world.diagnosticUsage()).pruneGeneration).toBe(1);
    await expect(world.diagnostic(first)).rejects.toThrow('no longer retained');
    expect((await world.diagnostics({}, true)).records).toEqual([]);
  });
  it('protects scheduled and terminal-but-unsettled handlers, including late writes after cancellation', async () => {
    const turn = await world.scheduleTurn(agent, Date.now()), attempt = await world.startAttempt(turn, 1, agent);
    await world.updateDiagnostic(attempt, { payload: { exact: 'Active evidence' } }, 'timeout');
    await world.endTurn(turn, 'timeout');
    const scheduled = await world.scheduleTurn(agent, Date.now());
    vi.setSystemTime(start + 60 * 60000);
    expect((await world.pruneDiagnostics()).deletedRecords).toBe(0);
    expect((await world.diagnosticUsage()).protectedBytes).toBe((await world.diagnosticUsage()).bytes);
    await world.updateDiagnostic(attempt, { output: 'Late output' }, 'applied');
    expect((await world.diagnostic(attempt)).details).toEqual({ payload: { exact: 'Active evidence' } });
    await world.settleAttempt(attempt);
    expect((await world.diagnostics()).records.map(record => record.id)).toEqual([scheduled]);
  });
  it('allows full evidence above both quotas in rolling modes and evicts an oversized settled group whole', async () => {
    await policy('rolling-size');
    const turn = await world.scheduleTurn(agent, Date.now()), attempt = await world.startAttempt(turn, 1, agent);
    const output = 'x'.repeat(33 * 1024 * 1024);
    await world.updateDiagnostic(attempt, { output }, 'applied');
    await world.endTurn(turn, 'completed');
    expect((await world.diagnostic(attempt)).details?.output).toHaveLength(output.length);
    const usage = await world.diagnosticUsage();
    expect(usage.bytes).toBeGreaterThan(usage.limitBytes); expect(usage.reservedBytes).toBe(0);
    const another = await world.scheduleTurn(agent, Date.now());
    await expect(world.startAttempt(another, 1, agent)).resolves.toBeTypeOf('string');
    await world.settleAttempt(attempt);
    expect((await world.diagnostics()).records.every(record => record.turnId !== turn)).toBe(true);
    await policy('rolling-time');
    const timeAttempt = await world.startAttempt(another, 2, agent);
    await expect(world.updateDiagnostic(timeAttempt, { output })).resolves.toBeUndefined();
    expect((await world.diagnostic(timeAttempt)).details?.output).toHaveLength(output.length);
  });
  it('evicts oldest eligible groups for size while preserving younger groups and active history', async () => {
    await policy('manual');
    const first = await completed(2);
    vi.setSystemTime(start + 1000); const second = await completed();
    vi.setSystemTime(start + 2000); const active = await world.scheduleTurn(agent, Date.now());
    await db.updateTable('decisions').set({ bytes: 12 * 1024 * 1024 }).where('id', 'in', [first.ids[0], second.ids[0], active]).execute();
    await policy('rolling-size');
    expect(await world.pruneDiagnostics()).toMatchObject({ deletedTurns: 1, deletedRecords: 3 });
    expect((await world.diagnostics()).records.map(record => record.turnId)).not.toContain(first.turn);
    expect((await world.diagnostic(second.ids[0])).details?.output).toBe('Evidence 1');
    expect((await world.diagnosticUsage()).bytes).toBeLessThanOrEqual(32 * 1024 * 1024);
  });
  it('retains manual admission and per-attempt reservations without automatic expiry', async () => {
    await policy('manual'); const group = await completed();
    vi.setSystemTime(start + 365 * 86400000);
    expect((await world.pruneDiagnostics()).deletedRecords).toBe(0);
    const turn = await world.scheduleTurn(agent, Date.now());
    for (let n = 1; n <= 3; n++) await world.startAttempt(turn, n, agent);
    await expect(world.startAttempt(turn, 4, agent)).rejects.toThrow('capacity');
    await expect(world.updateDiagnostic(group.ids[0], { output: 'late' })).resolves.toBeUndefined();
    const active = (await world.diagnostics()).records.find(record => record.turnId === turn && record.attempt === 1)!;
    await expect(world.updateDiagnostic(active.id, { output: 'x'.repeat(8 * 1024 * 1024) })).rejects.toThrow('reserved diagnostic capacity');
    expect((await world.diagnostic(active.id)).details).toEqual({});
  });
  it('bounds each cleanup batch and continues remaining eligible groups without altering conversation history', async () => {
    await policy('manual'); await world.speak('room-1', 'Conversation remains.');
    for (let n = 0; n < 103; n++) await completed();
    await policy('rolling-time', 1); vi.setSystemTime(start + 60000);
    expect(await world.pruneDiagnostics()).toMatchObject({ deletedTurns: 100, deletedRecords: 200, hasMore: true });
    expect(await world.pruneDiagnostics()).toMatchObject({ deletedTurns: 3, deletedRecords: 6, hasMore: false });
    expect((await world.history({ roomId: 'room-1' })).messages[0].content).toBe('Conversation remains.');
  });
  it('rolls back a failed cleanup, including its generation counter', async () => {
    const group = await completed(2); vi.setSystemTime(start + 30 * 60000);
    await sql`create trigger reject_retention before delete on decisions begin select raise(abort, 'blocked deletion'); end`.execute(db);
    await expect(world.pruneDiagnostics()).rejects.toThrow('blocked deletion');
    expect((await world.diagnostics()).records).toHaveLength(3);
    expect((await world.diagnostic(group.ids[0])).details?.output).toBe('Evidence 1');
    expect((await world.diagnosticUsage()).pruneGeneration).toBe(0);
  });
  it('releases orphaned execution pins on restart without changing already terminal evidence', async () => {
    const turn = await world.scheduleTurn(agent, Date.now()), attempt = await world.startAttempt(turn, 1, agent);
    await world.updateDiagnostic(attempt, { output: 'Cancelled evidence' }, 'cancelled'); await world.endTurn(turn, 'cancelled');
    vi.setSystemTime(start + 30 * 60000); await world.interruptUnfinished();
    expect(await world.diagnostic(attempt)).toMatchObject({ outcome: 'cancelled', details: { output: 'Cancelled evidence' } });
    expect((await world.pruneDiagnostics()).deletedRecords).toBe(2);
  });
  it('migrates legacy manual settings without deletion and preserves custom settings and exported policy', async () => {
    const group = await completed();
    const old = { ...defaultSettings, diagnostics: { retention: 'manual', maxPayloadMiB: 64 },
      prompts: { ...defaultSettings.prompts, framing: 'Authored guidance' } };
    await db.updateTable('settings').set({ value: JSON.stringify(old) }).where('id', '=', 1).execute();
    await db.schema.dropIndex('decisions_retention').execute();
    await db.schema.alterTable('decisions').dropColumn('execution_pending').execute();
    await db.schema.dropTable('diagnostic_retention').execute();
    await db.deleteFrom('schema_migrations').where('version', '=', 8).execute();
    vi.setSystemTime(start + 86400000); await ensureTables(db); await ensureTables(db);
    expect((await world.settings()).value).toMatchObject({ diagnostics: { retention: 'manual', maxPayloadMiB: 64, maxAgeMinutes: 30 },
      prompts: { framing: 'Authored guidance' } });
    expect((await world.diagnostic(group.ids[0])).details?.output).toBe('Evidence 1');
    expect(await world.exportConfiguration()).toMatchObject({ version: 8, settings: { diagnostics: { retention: 'manual', maxAgeMinutes: 30 } } });
    expect((await world.diagnosticUsage()).pruneGeneration).toBe(0);
  });
});
