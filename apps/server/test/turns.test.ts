import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb, ensureTables, World } from '@terrarium/persistence';
import type { AgentInput } from '@terrarium/shared';
import { Scheduler } from '../src/scheduler.js';
import { assembleContext, performTurn } from '../src/turns.js';

let db: ReturnType<typeof createDb>, world: World;
const schedulers: Scheduler[] = [];
const input: AgentInput = {
  name: 'Observer',
  instructions: 'Observe the room.',
  roomId: 'room-1',
  provider: 'chatgpt',
  model: 'fake',
  enabled: true,
  minIntervalMs: 1000,
  maxIntervalMs: 1000,
  contextMessageLimit: 50,
};
const deferred = () => {
  let resolve!: (value?: any) => void;
  const promise = new Promise<any>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const makeScheduler = (
  handler: ConstructorParameters<typeof Scheduler>[1],
  options = { concurrency: 4, timeoutMs: 5000, retries: 2, backoffMs: 1 },
) => {
  const scheduler = new Scheduler(world, handler, () => {}, options);
  schedulers.push(scheduler);
  return scheduler;
};
beforeEach(async () => {
  db = createDb(':memory:');
  await ensureTables(db);
  world = new World(db);
});
afterEach(async () => {
  schedulers.splice(0).forEach((scheduler) => scheduler.close());
  await new Promise((resolve) => setTimeout(resolve, 10));
  await db.destroy();
  vi.restoreAllMocks();
});

describe('agent turns and scheduling', () => {
  it('keeps stop authoritative when a pending state read fails', async () => {
    await world.saveAgent(input);
    const scheduler = makeScheduler(async () => {});
    await scheduler.start();
    let reject!: (error: Error) => void;
    const pending = new Promise<never>((_, fail) => {
      reject = fail;
    });
    vi.spyOn(world, 'agents').mockReturnValueOnce(pending);
    const tick = scheduler.tick();
    scheduler.stop();
    reject(new Error('Read failed'));
    await tick;
    expect(scheduler.snapshot().state).toBe('stopped');
  });
  it('accepts waiting without creating dialogue or moving the agent', async () => {
    const agent = await world.saveAgent(input),
      notify = vi.fn();
    await performTurn(
      world,
      agent,
      { name: 'fake', complete: async () => ({ content: '{"type":"wait"}' }) },
      new AbortController().signal,
      () => true,
      notify,
      async () => {
        notify();
      },
    );
    expect(notify).not.toHaveBeenCalled();
    expect(await world.agent(agent.id)).toEqual(agent);
    expect(
      (await world.history({ roomId: agent.roomId })).messages,
    ).toHaveLength(0);
  });
  it('exposes failed state reads and schedules the agent again after resume', async () => {
    await world.saveAgent(input);
    const handler = vi.fn(async () => {}),
      scheduler = makeScheduler(handler);
    await scheduler.start();
    vi.spyOn(world, 'agent').mockRejectedValueOnce(
      new Error('Database unavailable'),
    );
    await scheduler.tick();
    await vi.waitFor(() => expect(scheduler.snapshot().state).toBe('paused'));
    expect(scheduler.snapshot().error).toContain('saved agent state');
    await scheduler.start();
    await scheduler.tick();
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(2));
  });
  it('recovers from provider rejection on the next bounded attempt', async () => {
    await world.saveAgent(input);
    const handler = vi
      .fn()
      .mockRejectedValueOnce(new Error('Temporary failure'))
      .mockResolvedValue(undefined);
    const scheduler = makeScheduler(handler);
    await scheduler.start();
    await scheduler.tick();
    await vi.waitFor(() =>
      expect(scheduler.snapshot().agents[0].state).toBe('scheduled'),
    );
    expect(handler).toHaveBeenCalledTimes(2);
    expect(scheduler.snapshot().agents[0].error).toBeUndefined();
  });
  it('bounds a population of 16 to four calls without overlapping an agent', async () => {
    for (let index = 0; index < 16; index++)
      await world.saveAgent({
        ...input,
        name: `Agent ${index}`,
        minIntervalMs: 1,
        maxIntervalMs: 1,
      });
    const running = new Map<string, ReturnType<typeof deferred>>(),
      visited = new Set<string>();
    let peak = 0;
    const scheduler = makeScheduler(async (agent) => {
      expect(running.has(agent.id)).toBe(false);
      const turn = deferred();
      running.set(agent.id, turn);
      visited.add(agent.id);
      peak = Math.max(peak, running.size);
      await turn.promise;
      running.delete(agent.id);
    });
    await scheduler.start();
    for (let batch = 0; batch < 4; batch++) {
      await scheduler.tick();
      await scheduler.tick();
      expect(running.size).toBe(4);
      [...running.values()].forEach((turn) => turn.resolve());
      await vi.waitFor(() =>
        expect(
          scheduler
            .snapshot()
            .agents.filter((agent) => agent.state === 'running'),
        ).toHaveLength(0),
      );
    }
    expect(visited.size).toBe(16);
    expect(peak).toBe(4);
  });
  it('lets pause finish an active turn, and discards a stopped turn even if its provider ignores abort', async () => {
    const agent = await world.saveAgent(input);
    let result = deferred();
    const provider = { name: 'fake', complete: () => result.promise };
    const scheduler = makeScheduler((value, signal, current, applied) =>
      performTurn(
        world,
        value,
        provider,
        signal,
        current,
        () => {},
        async () => {},
        applied,
      ),
    );
    await scheduler.start();
    await scheduler.tick();
    scheduler.pause();
    result.resolve({
      content: '{"type":"speak","message":"finished while paused"}',
    });
    await vi.waitFor(async () =>
      expect(
        (await world.history({ roomId: agent.roomId })).messages,
      ).toHaveLength(1),
    );
    await vi.waitFor(() =>
      expect(scheduler.snapshot().agents[0].state).toBe('scheduled'),
    );
    scheduler.stop();
    result = deferred();
    await scheduler.start();
    await scheduler.tick();
    scheduler.stop();
    result.resolve({ content: '{"type":"speak","message":"must not appear"}' });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(
      (await world.history({ roomId: agent.roomId })).messages,
    ).toHaveLength(1);
  });
  it.each(['edit', 'disable', 'move'])(
    'rejects late output following an agent %s',
    async (change) => {
      const agent = await world.saveAgent(input),
        result = deferred();
      const complete = vi.fn(() => result.promise);
      const scheduler = makeScheduler((value, signal, current, applied) =>
        performTurn(
          world,
          value,
          { name: 'fake', complete },
          signal,
          current,
          () => {},
          async () => {},
          applied,
        ),
      );
      await scheduler.start();
      await scheduler.tick();
      await vi.waitFor(() => expect(complete).toHaveBeenCalledOnce());
      await world.saveAgent({
        ...input,
        id: agent.id,
        ...(change === 'edit'
          ? { instructions: 'New instructions' }
          : change === 'disable'
            ? { enabled: false }
            : { roomId: 'room-2' }),
      });
      await scheduler.changed();
      result.resolve({ content: '{"type":"speak","message":"stale"}' });
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect((await world.history({ roomId: 'room-1' })).messages).toHaveLength(
        0,
      );
      expect((await world.history({ roomId: 'room-2' })).messages).toHaveLength(
        0,
      );
    },
  );
  it('retries timeouts twice and keeps the failed agent scheduled', async () => {
    await world.saveAgent(input);
    const handler = vi.fn(async () => new Promise<void>(() => {}));
    const scheduler = makeScheduler(handler, {
      concurrency: 4,
      timeoutMs: 10,
      retries: 2,
      backoffMs: 1,
    });
    await scheduler.start();
    await scheduler.tick();
    await vi.waitFor(() =>
      expect(scheduler.snapshot().agents[0].state).toBe('error'),
    );
    expect(handler).toHaveBeenCalledTimes(3);
    expect(scheduler.snapshot().agents[0].dueAt).toBeGreaterThan(Date.now());
    expect((await world.history({ roomId: 'room-1' })).messages).toHaveLength(
      0,
    );
  });
  it('does not retry a saved action when notification fails', async () => {
    await world.saveAgent(input);
    const complete = vi.fn(async () => ({
      content: '{"type":"speak","message":"saved once"}',
    }));
    const scheduler = makeScheduler((agent, signal, current, applied) =>
      performTurn(
        world,
        agent,
        { name: 'fake', complete },
        signal,
        current,
        () => {
          throw new Error('Notification failed');
        },
        async () => {},
        applied,
      ),
    );
    await scheduler.start();
    await scheduler.tick();
    await vi.waitFor(() =>
      expect(scheduler.snapshot().agents[0].state).toBe('error'),
    );
    expect(complete).toHaveBeenCalledOnce();
    expect((await world.history({ roomId: 'room-1' })).messages).toHaveLength(
      1,
    );
  });
  it('assembles only the latest 50 current-room messages, including before arrival, and validates actions', async () => {
    for (let index = 0; index < 55; index++)
      await world.speak('room-2', `message ${index}`);
    await world.speak('room-1', 'Other room secret');
    const agent = await world.saveAgent({ ...input, roomId: 'room-2' });
    const context = await assembleContext(world, agent),
      observed = JSON.parse(context[1].content);
    expect(observed).toHaveLength(50);
    expect(observed[0]).toMatchObject({
      speaker: 'Human',
      content: 'message 5',
    });
    expect(context[1].content).not.toContain('Other room secret');
    for (const content of [
      'not JSON',
      '{"type":"move","roomId":"missing"}',
      '{"type":"speak","message":""}',
    ]) {
      await expect(
        performTurn(
          world,
          agent,
          { name: 'fake', complete: async () => ({ content }) },
          new AbortController().signal,
          () => true,
          () => {},
          async () => {},
        ),
      ).rejects.toThrow();
    }
    await performTurn(
      world,
      agent,
      {
        name: 'fake',
        complete: async () => ({
          content: '{"type":"move","roomId":"room-1"}',
        }),
      },
      new AbortController().signal,
      () => true,
      () => {},
      async () => {},
    );
    const moved = await world.agent(agent.id);
    expect(moved!.roomId).toBe('room-1');
    expect(
      JSON.parse((await assembleContext(world, moved!))[1].content),
    ).toHaveLength(1);
  });
});
