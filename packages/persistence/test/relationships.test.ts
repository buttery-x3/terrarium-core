import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'kysely';
import { defaultSettings, type Agent, type AppraisalProposal, type RelationshipSummaryInput } from '@terrarium/shared';
import { createDb, ensureTables, World } from '../src/index.js';

let db: ReturnType<typeof createDb>, world: World;
const directories: string[] = [];
const input = { name: 'Observer', instructions: 'Be curious.', roomId: 'room-1', provider: 'chatgpt' as const,
  model: 'fake', enabled: true, minIntervalMs: 1000, maxIntervalMs: 1000, contextMessageLimit: 50 };
beforeEach(async () => { db = createDb(':memory:'); await ensureTables(db); world = new World(db); });
afterEach(async () => {
  await db.destroy();
  for (const directory of directories.splice(0)) {
    if (!directory.startsWith(join(tmpdir(), 'terrarium-relationships-'))) throw new Error('Unsafe cleanup path');
    rmSync(directory, { recursive: true, force: true });
  }
});
const speak = async (agent: Agent, message = 'A specific contribution') =>
  (await world.applyAction(agent.id, agent.revision, { type: 'speak', message }, () => true)).message!;
const appraise = async (observer: Agent, sourceId: string, reaction: 'like' | 'dislike' = 'like') =>
  world.applyAction(observer.id, observer.revision, { type: 'wait' }, () => true, undefined,
    { sourceIds: (await world.memory(observer.id)).map(item => item.id), appraisals: [{ sourceId, reaction, reason: 'This specific contribution interests me.' }] });
const proposal = (source: RelationshipSummaryInput) => ({ targetAgentId: source.targetAgentId, previousVersion: source.previous?.version ?? 0,
  throughSequence: source.throughSequence, summary: 'Enjoys this resident\'s specific contributions.', appraisalIds: source.appraisals.map(item => item.id) });

describe('evidence-based relationship memory', () => {
  it('accepts speech and emotes from the supplied witnessed snapshot exactly once with directional scores and durable source copies', async () => {
    const a = await world.saveAgent({ ...input, contextMessageLimit: 1 }), b = await world.saveAgent({ ...input, name: 'Resident' });
    const source = await speak(b);
    const sourceIds = [source.id];
    await world.speak(a.roomId, 'Evicts the source from the rolling observation');
    const turn = await world.scheduleTurn(a, Date.now(), 'reflection'), attempt = await world.startAttempt(turn, 1, a);
    const result = await world.applyAction(a.id, a.revision, { type: 'wait' }, () => true, attempt,
      { sourceIds, appraisals: [{ sourceId: source.id, reaction: 'like', reason: 'A useful explanation.' }] });
    const saved = result.acceptedAppraisals[0];
    expect(saved).toMatchObject({ observerId: a.id, targetAgentId: b.id, source, reaction: 'like', reason: 'A useful explanation.', scoreAfter: 1 });
    expect((await world.diagnostic(attempt)).details?.acceptedAppraisals).toEqual([saved]);
    const duplicate = await world.applyAction(a.id, a.revision, { type: 'wait' }, () => true, undefined,
      { sourceIds, appraisals: [{ sourceId: source.id, reaction: 'dislike', reason: 'An attempted rewrite.' }] });
    expect(duplicate).toMatchObject({ acceptedAppraisals: [], duplicateAppraisalIds: [saved.id] });
    expect((await world.appraisal(saved.id))?.reaction).toBe('like');
    expect((await world.relationshipPage({ observerId: a.id })).relationships[0].score).toBe(1);
    expect((await world.relationshipPage({ observerId: b.id })).relationships).toEqual([]);
    const emote = (await world.applyAction(b.id, b.revision, { type: 'emote', message: 'Resident folds a paper bird.' }, () => true)).message!;
    await appraise(a, emote.id, 'dislike');
    expect((await world.relationshipPage({ observerId: a.id })).relationships[0].score).toBe(0);
    expect((await world.appraisals({ observerId: a.id, limit: 1 })).hasMore).toBe(true);
    expect((await world.appraisals({ observerId: a.id, before: 2 })).appraisals).toEqual([saved]);
    await expect(db.insertInto('appraisals').values({ ...(await db.selectFrom('appraisals').selectAll().where('id', '=', saved.id).executeTakeFirstOrThrow()),
      sequence: undefined, id: 'duplicate-write' }).execute()).rejects.toThrow('UNIQUE');
  });

  it('rejects invalid evidence, wrong targets, empty reasons, capacity overflow and stale or failed atomic writes', async () => {
    const a = await world.saveAgent(input), b = await world.saveAgent({ ...input, name: 'Other' });
    const outsider = await world.saveAgent({ ...input, name: 'Remote', roomId: 'room-2' });
    const own = await speak(a), human = await world.speak(a.roomId, 'Operator speech'), unseen = await speak(outsider);
    const movement = await world.applyAction(b.id, b.revision, { type: 'move', roomId: 'room-2' }, () => true);
    const good = own.id;
    for (const sourceId of [own.id, human.id, unseen.id, movement.events[0].id, 'unknown'])
      await expect(world.applyAction(a.id, a.revision, { type: 'wait' }, () => true, undefined,
        { sourceIds: (await world.memory(a.id)).map(item => item.id), appraisals: [{ sourceId, reaction: 'like', reason: 'A reason' }] })).rejects.toThrow('Appraisals require');
    for (const invalid of [{ sourceId: good, reaction: 'like', reason: '' }, { sourceId: good, reaction: 'like', reason: 'Why', targetAgentId: b.id }])
      await expect(world.applyAction(a.id, a.revision, { type: 'wait' }, () => true, undefined, { appraisals: [invalid as AppraisalProposal] })).rejects.toThrow();
    const localB = await world.saveAgent({ ...input, id: b.id, name: 'Other' });
    const source = await speak(localB);
    const appraisal = { sourceId: source.id, reaction: 'like' as const, reason: 'Clear explanation' };
    await expect(world.applyAction(a.id, a.revision, { type: 'wait' }, () => true, undefined, { appraisals: [appraisal, appraisal, appraisal] })).rejects.toThrow('capacity');
    const attempt = await world.startAttempt(await world.scheduleTurn(a, Date.now()), 1, a);
    await sql`CREATE TRIGGER reject_relationship_evidence BEFORE UPDATE ON decisions WHEN NEW.outcome = 'applied' BEGIN SELECT RAISE(ABORT, 'Evidence failed'); END`.execute(db);
    await expect(world.applyAction(a.id, a.revision, { type: 'speak', message: 'Must roll back' }, () => true, attempt,
      { appraisals: [appraisal], reflection: { reaction: 'Interested', intention: 'Speak' } })).rejects.toThrow('Evidence failed');
    expect((await world.appraisals()).appraisals).toEqual([]);
    expect((await world.relationshipPage()).relationships).toEqual([]);
    expect((await world.reflection(a.id)).reaction).toBeNull();
    expect((await world.memory(a.id)).some(item => item.content === 'Must roll back')).toBe(false);
    await sql`DROP TRIGGER reject_relationship_evidence`.execute(db);
    let checks = 0;
    await expect(world.applyAction(a.id, a.revision, { type: 'wait' }, () => ++checks === 1, undefined, { appraisals: [appraisal] })).rejects.toThrow('current');
    expect((await world.appraisals()).appraisals).toEqual([]);
    await world.saveSettings({ ...defaultSettings, relationships: { ...defaultSettings.relationships, maxAppraisalsPerReflection: 0 } });
    await expect(appraise(a, source.id)).rejects.toThrow('capacity');
    await world.applyAction(a.id, a.revision, { type: 'wait' }, () => true, undefined, { appraisals: [] });
  });

  it('clamps each accepted update without an invisible balance beyond either bound', async () => {
    const a = await world.saveAgent(input), b = await world.saveAgent({ ...input, name: 'Resident' });
    for (let index = 0; index < 12; index++) await appraise(a, (await speak(b, `Positive ${index}`)).id);
    expect((await world.relationshipPage()).relationships[0].score).toBe(10);
    await appraise(a, (await speak(b, 'One contrary experience')).id, 'dislike');
    expect((await world.relationshipPage()).relationships[0].score).toBe(9);
    for (let index = 0; index < 21; index++) await appraise(a, (await speak(b, `Negative ${index}`)).id, 'dislike');
    expect((await world.relationshipPage()).relationships[0].score).toBe(-10);
    await appraise(a, (await speak(b, 'A welcome surprise')).id);
    expect((await world.relationshipPage()).relationships[0].score).toBe(-9);
    expect((await world.appraisals({ limit: 100 })).appraisals).toHaveLength(35);
  });

  it('creates bounded, evidence-linked summary versions while preserving new evidence and rejecting stale or foreign citations', async () => {
    const a = await world.saveAgent(input), b = await world.saveAgent({ ...input, name: 'Resident' });
    await world.saveSettings({ ...defaultSettings, relationships: { ...defaultSettings.relationships, summaryBatchSize: 2 } });
    await appraise(a, (await speak(b, 'First')).id); await appraise(a, (await speak(b, 'Second')).id);
    const source = (await world.summaryInput(a.id, b.id))!;
    await appraise(a, (await speak(b, 'Arrives while summary runs')).id, 'dislike');
    await expect(world.saveRelationshipSummary(a.id, a.revision, { ...proposal(source), appraisalIds: ['invented'] }, () => true)).rejects.toThrow('outside');
    const attempt = await world.startAttempt(await world.scheduleTurn(a, Date.now(), 'relationship-summary'), 1, a);
    await sql`CREATE TRIGGER reject_summary_evidence BEFORE UPDATE ON decisions WHEN NEW.outcome = 'applied' BEGIN SELECT RAISE(ABORT, 'Summary evidence failed'); END`.execute(db);
    await expect(world.saveRelationshipSummary(a.id, a.revision, proposal(source), () => true, attempt)).rejects.toThrow('Summary evidence failed');
    expect((await world.relationshipSummaries(a.id, b.id)).summaries).toEqual([]);
    await sql`DROP TRIGGER reject_summary_evidence`.execute(db);
    const first = await world.saveRelationshipSummary(a.id, a.revision, proposal(source), () => true, attempt);
    expect(first).toMatchObject({ version: 1, previousSummaryId: null, throughSequence: source.throughSequence });
    expect((await world.diagnostic(attempt)).details?.relationshipSummary).toEqual(first);
    await expect(world.saveRelationshipSummary(a.id, a.revision, proposal(source), () => true)).rejects.toThrow('superseded');
    const next = (await world.summaryInput(a.id, b.id))!;
    expect(next.previous).toEqual(first); expect(next.appraisals).toHaveLength(1);
    let checks = 0;
    await expect(world.saveRelationshipSummary(a.id, a.revision, proposal(next), () => ++checks === 1)).rejects.toThrow('current');
    const second = await world.saveRelationshipSummary(a.id, a.revision,
      { ...proposal(next), summary: 'Mixed evidence, with earlier interest and one recent disagreement.', appraisalIds: [first.appraisalIds[0], next.appraisals[0].id] }, () => true);
    expect(second).toMatchObject({ version: 2, previousSummaryId: first.id });
    expect(await world.summaryInput(a.id, b.id)).toBeNull();
    expect((await world.relationshipSummaries(a.id, b.id, undefined, 1)).hasMore).toBe(true);
    expect((await world.relationshipSummaries(a.id, b.id, 2)).summaries).toEqual([first]);
    expect(await world.summaryInput(b.id, a.id)).toBeNull();
  });

  it('selects only changed summary pairs due at their interval and exposes all pairs of one observer', async () => {
    const a = await world.saveAgent(input), b = await world.saveAgent({ ...input, name: 'B' }), c = await world.saveAgent({ ...input, name: 'C' });
    const first = (await appraise(a, (await speak(b)).id)).acceptedAppraisals[0];
    await appraise(a, (await speak(c)).id);
    const interval = defaultSettings.relationships.summaryIntervalMs;
    expect(await world.summaryCandidates(20, Date.parse(first.createdAt) + interval - 1)).toEqual([]);
    expect(await world.summaryCandidates(20, Infinity)).toHaveLength(2);
    expect(await world.summaryCandidates(1, Infinity)).toHaveLength(1);
    const summary = await world.saveRelationshipSummary(a.id, a.revision, proposal((await world.summaryInput(a.id, b.id))!), () => true);
    expect((await world.summaryCandidates(20, Infinity)).map(pair => pair.targetAgentId)).toEqual([c.id]);
    await appraise(a, (await speak(b)).id);
    expect((await world.summaryCandidates(20, Date.parse(summary.createdAt) + interval - 1)).some(pair => pair.targetAgentId === b.id)).toBe(false);
    expect((await world.summaryCandidates(20, Date.parse(summary.createdAt) + interval)).some(pair => pair.targetAgentId === b.id)).toBe(true);
  });

  it('bounds private prompt relationships to eight and prioritizes local residents and names in current observations', async () => {
    const a = await world.saveAgent({ ...input, contextMessageLimit: 1 }), targets: Agent[] = [];
    for (let index = 0; index < 10; index++) {
      const target = await world.saveAgent({ ...input, name: `Resident ${String.fromCharCode(65 + index)}` }); targets.push(target);
      await appraise(a, (await speak(target)).id);
      if (index !== 0) await world.applyAction(target.id, target.revision, { type: 'move', roomId: 'room-2' }, () => true);
    }
    await world.speak(a.roomId, 'I recall Resident C saying something interesting.');
    const context = await world.relevantRelationships(a.id);
    expect(context).toHaveLength(8);
    expect(context.slice(0, 2).map(item => item.targetAgentId)).toEqual([targets[0].id, targets[2].id]);
    expect(context.every(item => !('roomId' in item) && !('observerId' in item) && !('source' in item))).toBe(true);
    expect(await world.relevantRelationships(targets[0].id)).toEqual([]);
  });

  it('retains disclosed appraisal evidence after conversation clearing and resets relationship-dependent state only', async () => {
    const a = await world.saveAgent({ ...input, intention: 'Authored intention' }), b = await world.saveAgent({ ...input, name: 'B' });
    const source = await speak(b), accepted = (await appraise(a, source.id)).acceptedAppraisals[0];
    await world.saveReflection(a.id, a.revision, { reaction: 'Interested', intention: 'Ask about it', engagement: { roomId: a.roomId, rootMessageId: source.id, targetAgentId: b.id } }, () => true);
    const publicSpeech = await speak(a);
    await world.saveRelationshipSummary(a.id, a.revision, proposal((await world.summaryInput(a.id, b.id))!), () => true);
    const diagnostic = await world.scheduleTurn(a, Date.now());
    await world.clearHistory({ scope: 'all' });
    expect((await world.appraisal(accepted.id))?.source).toEqual(source);
    expect((await world.relationshipSummaries(a.id, b.id)).summaries).toHaveLength(1);
    expect(await world.resetRelationshipMemory()).toEqual({ appraisals: 1, relationships: 1, summaries: 1 });
    expect(await world.reflection(a.id)).toMatchObject({ reflectedAt: null, reaction: null, intention: null, engagement: null, lastSpeechAt: publicSpeech.createdAt });
    expect((await world.agent(a.id))?.intention).toBe('Authored intention');
    expect((await world.diagnostic(diagnostic)).id).toBe(diagnostic);
    expect(await world.appraisal(accepted.id)).toBeNull();
    expect((await world.relationshipPage()).relationships).toEqual([]);
  });

  it('upgrades version 4 preserving settings, profiles, observations, energy, diagnostics and reflections, and persists deduplication across restart', async () => {
    await db.destroy();
    const directory = mkdtempSync(join(tmpdir(), 'terrarium-relationships-')); directories.push(directory);
    const path = join(directory, 'restart.db'); db = createDb(path); await ensureTables(db); world = new World(db);
    const a = await world.saveAgent({ ...input, intention: 'Authored', timingOverrides: { reflectionIntervalMs: 90000 } });
    const b = await world.saveAgent({ ...input, name: 'B' }), source = await speak(b);
    await world.saveReflection(a.id, a.revision, { reaction: 'Private reaction', intention: 'Observe' }, () => true);
    await db.updateTable('agents').set({ energy: 42 }).where('id', '=', a.id).execute();
    const diagnostic = await world.scheduleTurn(a, Date.now());
    const { relationships, prompts: { appraisals, relationshipSummary, ...prompts }, ...settings } = defaultSettings;
    await db.updateTable('settings').set({ value: JSON.stringify({ ...settings, scheduling: { ...settings.scheduling, reflectionIntervalMs: 120000 }, prompts: { ...prompts, reflection: 'Custom reflection rule' } }) }).execute();
    for (const table of ['appraisals', 'relationships', 'relationship_summaries'] as const) await db.schema.dropTable(table).execute();
    await db.deleteFrom('schema_migrations').where('version', '=', 5).execute();
    await ensureTables(db); await ensureTables(db);
    expect((await world.settings()).value).toMatchObject({ scheduling: { reflectionIntervalMs: 120000 }, relationships, prompts: { reflection: 'Custom reflection rule', appraisals, relationshipSummary } });
    expect(await world.agent(a.id)).toMatchObject({ energy: 42, intention: 'Authored', timingOverrides: { reflectionIntervalMs: 90000 } });
    expect((await world.memory(a.id))[0]).toEqual(source);
    expect((await world.reflection(a.id)).reaction).toBe('Private reaction');
    const saved = (await appraise(a, source.id)).acceptedAppraisals[0];
    const configuration = await world.exportConfiguration();
    expect(configuration.version).toBe(5);
    expect(JSON.stringify(configuration)).not.toContain(saved.reason);
    await db.destroy(); db = createDb(path); await ensureTables(db); world = new World(db); await world.interruptUnfinished();
    expect((await appraise(a, source.id)).duplicateAppraisalIds).toEqual([saved.id]);
    expect((await world.relationshipPage()).relationships[0].score).toBe(1);
    expect((await world.diagnostic(diagnostic)).outcome).toBe('interrupted');
  });
});
