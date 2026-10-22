import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { defaultSettings, type Agent, type AppraisalProposal } from '@terrarium/shared';
import { createDb, ensureTables, World, type DecisionUpdate } from '../src/index.js';

let db: ReturnType<typeof createDb>, world: World, observer: Agent, partner: Agent;
const input = { name: 'Observer', instructions: 'Be curious.', roomId: 'room-1', provider: 'chatgpt' as const,
  model: 'fake', enabled: true, minIntervalMs: 60000, maxIntervalMs: 150000, contextMessageLimit: 50 };
beforeEach(async () => {
  db = createDb(':memory:'); await ensureTables(db); world = new World(db);
  observer = await world.saveAgent(input); partner = await world.saveAgent({ ...input, name: 'Partner' });
});
afterEach(async () => { await db.destroy(); });
async function speech(agent = partner, message = 'A specific contribution') {
  return (await world.applyAction(agent.id, agent.revision, { type: 'speak', message }, () => true)).message!;
}
const appraisal = (sourceId: string): AppraisalProposal => ({ sourceId, reaction: 'like', reason: 'A useful contribution.' });
const attempt = () => world.scheduleTurn(observer, Date.now(), 'reflection').then(turn => world.startAttempt(turn, 1, observer));
const move = (decision: DecisionUpdate, id?: string, current = () => true, roomId = 'room-2') =>
  world.applyAction(observer.id, observer.revision, { type: 'move', roomId, reason: 'PRIVATE_MOVE_REASON: seek a quieter room.' }, current, id, decision);

describe('movement with optional private updates', () => {
  it.each([0, 1])('rejects a mistyped source at index %i while committing valid evidence and a private move reason', async invalidIndex => {
    const source = await speech(), typo = `${source.id.slice(0, -1)}!`, id = await attempt();
    const proposals = [appraisal(source.id)]; proposals.splice(invalidIndex, 0, appraisal(typo));
    const result = await move({ sourceIds: [source.id], appraisals: proposals, reflection: { reaction: 'Interested', intention: 'Find quiet' } }, id);
    expect(result.moved).toBe(true); expect(result.acceptedAppraisals).toHaveLength(1);
    expect(result.acceptedAppraisals[0]).toMatchObject({ source, observerId: observer.id, targetAgentId: partner.id, scoreAfter: 1 });
    expect(result.optionalValidationErrors).toEqual([{ field: 'appraisals', index: invalidIndex, sourceId: typo, error: expect.stringContaining('witnessed') }]);
    expect((await world.agent(observer.id))?.roomId).toBe('room-2');
    expect((await world.reflection(observer.id)).reaction).toBe('Interested');
    expect((await world.relationshipPage({ observerId: observer.id })).relationships[0].score).toBe(1);
    expect(await world.diagnostic(id)).toMatchObject({ outcome: 'applied', action: 'move', details: {
      sourceRoomId: 'room-1', destinationRoomId: 'room-2', moved: true, moveReason: 'PRIVATE_MOVE_REASON: seek a quieter room.',
      optionalValidationErrors: result.optionalValidationErrors, acceptedAppraisals: result.acceptedAppraisals,
    } });
    expect(result.events.map(event => event.type)).toEqual(['departure', 'arrival']);
    expect(JSON.stringify(result.events)).not.toContain('PRIVATE_MOVE_REASON');
    expect(JSON.stringify(await world.memory(observer.id))).not.toContain('PRIVATE_MOVE_REASON');
    expect(JSON.stringify(await world.state())).not.toContain('PRIVATE_MOVE_REASON');
  });
  it('uses the supplied snapshot, accepts evicted witnessed evidence and rejects unseen, own, human and non-authored events', async () => {
    observer = await world.saveAgent({ ...input, id: observer.id, contextMessageLimit: 1 });
    const source = await speech(), human = await world.speak('room-1', 'Human text'), own = await speech(observer);
    const remote = await world.saveAgent({ ...input, name: 'Remote', roomId: 'room-3' }), unseen = await speech(remote);
    const events = (await world.applyAction(partner.id, partner.revision, { type: 'move', roomId: 'room-2' }, () => true)).events;
    const snapshot = [source.id, human.id, own.id, events[0].id];
    await world.saveSettings({ ...defaultSettings, relationships: { ...defaultSettings.relationships, maxAppraisalsPerReflection: 5 } });
    const result = await move({ sourceIds: snapshot, appraisals: [source.id, human.id, own.id, unseen.id, events[0].id].map(appraisal) });
    expect(result.acceptedAppraisals.map(item => item.source.id)).toEqual([source.id]);
    expect(result.optionalValidationErrors.map(item => item.index)).toEqual([1, 2, 3, 4]);
    expect(result.moved).toBe(true);
  });
  it.each(['missing-root', 'remote-target', 'disabled-target', 'self-target', 'disabled-feature'] as const)
    ('rejects new engagement with %s without blocking the move or valid appraisal', async change => {
      const source = await speech(), id = await attempt();
      const engagement = { roomId: observer.roomId, rootMessageId: source.id, targetAgentId: partner.id };
      if (change === 'missing-root') engagement.rootMessageId = 'invented-root';
      if (change === 'remote-target') await world.applyAction(partner.id, partner.revision, { type: 'move', roomId: 'room-3' }, () => true);
      if (change === 'disabled-target') await world.saveAgent({ ...input, id: partner.id, enabled: false });
      if (change === 'self-target') engagement.targetAgentId = observer.id;
      if (change === 'disabled-feature') await world.saveSettings({ ...defaultSettings, scheduling: { ...defaultSettings.scheduling, engagementEnabled: false } });
      const result = await move({ sourceIds: [source.id], appraisals: [appraisal(source.id)], engagement }, id);
      expect(result.moved).toBe(true); expect(result.acceptedAppraisals).toHaveLength(1);
      expect(result.reflection.engagement).toBeNull();
      expect(result.optionalValidationErrors).toEqual([{ field: 'engagement', sourceId: engagement.rootMessageId, error: expect.stringContaining('present interlocutor') }]);
      expect((await world.diagnostic(id)).details?.optionalValidationErrors).toEqual(result.optionalValidationErrors);
    });
  it('keeps valid new engagement and private reflection atomic with a same-room move, then clears it on real departure', async () => {
    const source = await speech(), engagement = { roomId: observer.roomId, rootMessageId: source.id, targetAgentId: partner.id };
    const id = await attempt();
    const stayed = await move({ sourceIds: [source.id], engagement, appraisals: [appraisal(source.id)], reflection: { reaction: 'Interested', intention: 'Stay for now' } }, id, undefined, observer.roomId);
    expect(stayed).toMatchObject({ moved: false, optionalValidationErrors: [], reflection: { engagement, reaction: 'Interested' } });
    expect((await world.diagnostic(id)).outcome).toBe('applied-noop');
    observer = (await world.agent(observer.id))!;
    const left = await move({ sourceIds: [source.id], engagement });
    expect(left).toMatchObject({ moved: true, optionalValidationErrors: [], reflection: { engagement: null } });
  });
  it('keeps malformed optional input and capacity overflow fatal before committing movement or private updates', async () => {
    const source = await speech(), good = appraisal(source.id), id = await attempt();
    const invalid: DecisionUpdate[] = [
      { appraisals: [good, { ...good, reason: '' }] },
      { appraisals: [good, { ...good, targetAgentId: partner.id } as AppraisalProposal] },
      { appraisals: [good, good, good] },
      { appraisals: [good], engagement: { roomId: observer.roomId, targetAgentId: partner.id } as NonNullable<DecisionUpdate['engagement']> },
      { appraisals: [good], engagement: false as unknown as DecisionUpdate['engagement'] },
    ];
    for (const decision of invalid) {
      await expect(move({ ...decision, sourceIds: [source.id], reflection: { reaction: 'Must roll back', intention: null } }, id)).rejects.toThrow();
      expect((await world.agent(observer.id))?.roomId).toBe('room-1');
      expect((await world.appraisals()).appraisals).toEqual([]);
      expect((await world.reflection(observer.id)).reaction).toBeNull();
      expect((await world.diagnostic(id)).outcome).toBe('running');
    }
  });
  it.each(['destination', 'late-current', 'active-engagement'] as const)('keeps %s failure fatal despite optional reference rejects', async failure => {
    const source = await speech(), id = await attempt(), engagement = { roomId: observer.roomId, rootMessageId: source.id, targetAgentId: partner.id };
    const decision: DecisionUpdate = { sourceIds: [source.id], appraisals: [appraisal(source.id), appraisal('typo')],
      reflection: { reaction: 'Uncommitted reaction', intention: null }, engagement: { ...engagement, rootMessageId: 'typo' } };
    if (failure === 'active-engagement') decision.engagementGuard = { ...engagement, replyToId: source.id, sourceAgentId: partner.id };
    let checks = 0;
    await expect(move(decision, id, failure === 'late-current' ? () => ++checks === 1 : () => true, failure === 'destination' ? 'missing' : 'room-2')).rejects.toThrow(failure === 'destination' ? 'Destination' : 'current');
    expect((await world.agent(observer.id))?.roomId).toBe('room-1');
    expect((await world.appraisals()).appraisals).toEqual([]);
    expect((await world.relationshipPage()).relationships).toEqual([]);
    expect((await world.reflection(observer.id)).reaction).toBeNull();
    expect((await world.diagnostic(id))).toMatchObject({ outcome: 'running', details: {} });
    expect((await world.history({ roomId: 'room-2' })).messages).toEqual([]);
  });
  it.each(['appraisal-storage', 'diagnostics'] as const)('rolls back the full move and optional writes on %s failure', async failure => {
    const first = await speech(), second = await speech(partner, 'A second contribution'), id = await attempt();
    if (failure === 'appraisal-storage') await sql`create trigger reject_second_appraisal before insert on appraisals when new.source_id = ${sql.lit(second.id)} begin select raise(abort, 'Storage failed'); end`.execute(db);
    else await sql`create trigger reject_move_diagnostics before update on decisions when new.outcome = 'applied' begin select raise(abort, 'Diagnostics failed'); end`.execute(db);
    await expect(move({ sourceIds: [first.id, second.id], appraisals: [appraisal(first.id), appraisal(second.id)],
      engagement: { roomId: observer.roomId, rootMessageId: 'typo', targetAgentId: partner.id }, reflection: { reaction: 'Uncommitted', intention: null } }, id)).rejects.toThrow('failed');
    expect((await world.agent(observer.id))?.roomId).toBe('room-1');
    expect((await world.appraisals()).appraisals).toEqual([]);
    expect((await world.relationshipPage()).relationships).toEqual([]);
    expect((await world.reflection(observer.id)).reaction).toBeNull();
    expect((await world.diagnostic(id))).toMatchObject({ outcome: 'running', details: {} });
    expect((await world.history({ roomId: 'room-2' })).messages).toEqual([]);
  });
  it('continues rejecting the same invalid optional reference and engagement for non-move actions', async () => {
    const source = await speech();
    for (const decision of [{ appraisals: [appraisal('typo')] }, { engagement: { roomId: observer.roomId, rootMessageId: 'typo', targetAgentId: partner.id } }])
      await expect(world.applyAction(observer.id, observer.revision, { type: 'wait' }, () => true, undefined, { sourceIds: [source.id], ...decision })).rejects.toMatchObject({ category: 'world-validation' });
    expect((await world.agent(observer.id))?.roomId).toBe('room-1');
  });
});
