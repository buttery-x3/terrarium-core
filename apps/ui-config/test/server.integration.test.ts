import { afterEach, describe, expect, it, vi } from 'vitest';
import { io, type Socket } from 'socket.io-client';
import { createApplication } from '../../server/src/app.js';
import { assembleContext } from '../../server/src/turns.js';
import type { LmCompletionRequest, LmProvider } from '@terrarium/lm-providers';
import {
  createDb,
  ensureTables,
} from '../../../packages/persistence/src/index.js';

const sockets: Socket[] = [];
let application: Awaited<ReturnType<typeof createApplication>>,
  db: ReturnType<typeof createDb>;
async function setup(provider: LmProvider = {
  name: 'fake',
  complete: async () => ({ content: '{"action":{"type":"wait"}}' }),
}) {
  db = createDb(':memory:');
  await ensureTables(db);
  application = await createApplication({
    db,
    origins: ['http://localhost:4173'],
    quiet: true,
    provider,
  });
  await application.app.listen({ port: 0, host: '127.0.0.1' });
  const address = application.app.server.address();
  if (!address || typeof address === 'string') throw new Error('No listener');
  return `http://127.0.0.1:${address.port}`;
}
function connect(
  url: string,
  namespace = 'config',
  origin: string | undefined = 'http://localhost:4173',
) {
  const socket = io(`${url}/${namespace}`, {
    transports: ['websocket'],
    forceNew: true,
    reconnection: false,
    extraHeaders: origin ? { Origin: origin } : {},
  });
  sockets.push(socket);
  return socket;
}
const ready = (socket: Socket) =>
  new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', reject);
  });
const request = (
  socket: Socket,
  name: string,
  payload: unknown,
): Promise<any> => socket.timeout(1000).emitWithAck(name, payload);
afterEach(async () => {
  sockets.splice(0).forEach((socket) => socket.close());
  await application?.app.close();
  await db?.destroy();
  vi.restoreAllMocks();
});

describe('web conversation contract', () => {
  it('previews saved settings without a model request and enforces stopped settings edits', async () => {
    const complete = vi.fn(async () => ({ content: '{"action":{"type":"wait"}}' }));
    const url = await setup({ name: 'fake', complete }), socket = connect(url);
    await ready(socket);
    const agent = await application.world.saveAgent({ name: 'Preview', instructions: 'Personality', motivations: 'Solitude', intention: '', roomId: 'room-1',
      provider: 'chatgpt', model: 'fake', enabled: false, minIntervalMs: 1000, maxIntervalMs: 1000, contextMessageLimit: 50 });
    const settings = (await application.world.settings()).value;
    settings.prompts.framing = 'VISIBLE EDITED FRAMING';
    expect((await request(socket, 'settings:save', settings)).ok).toBe(true);
    const preview = await request(socket, 'prompt:preview', { agentId: agent.id });
    expect(preview.value.payload.instructions).toContain('VISIBLE EDITED FRAMING');
    expect(complete).not.toHaveBeenCalled();
    expect((await application.world.diagnostics()).records).toHaveLength(0);
    await application.scheduler.start();
    expect((await request(socket, 'settings:save', settings)).error).toContain('Choose Stop');
    application.scheduler.pause();
    expect((await request(socket, 'settings:save', settings)).error).toContain('Choose Stop');
    application.scheduler.stop();
    expect((await request(socket, 'settings:save', { ...settings, prompts: {} })).ok).toBe(false);
  });
  it('pages and exports diagnostic snapshots and requires explicit stopped clearing', async () => {
    const url = await setup(), socket = connect(url);
    await ready(socket);
    const agent = await application.world.saveAgent({ name: 'Diagnosed', instructions: 'Observe', roomId: 'room-1', provider: 'chatgpt', model: 'fake',
      enabled: false, minIntervalMs: 1000, maxIntervalMs: 1000, contextMessageLimit: 50 });
    const id = await application.world.startAttempt(await application.world.scheduleTurn(agent, Date.now()), 1, agent);
    await application.world.updateDiagnostic(id, { payload: { input: 'SAVED SNAPSHOT' } }, 'provider');
    const page = await request(socket, 'diagnostics:list', { limit: 1 });
    expect(page.value.records[0]).not.toHaveProperty('details');
    expect(page.value.hasMore).toBe(true);
    expect((await request(socket, 'diagnostics:get', { id })).value.details.payload.input).toBe('SAVED SNAPSHOT');
    expect((await request(socket, 'diagnostics:export', { outcome: 'provider' })).value.records[0].details.payload.input).toBe('SAVED SNAPSHOT');
    expect((await request(socket, 'diagnostics:usage', {})).value.bytes).toBeGreaterThan(0);
    expect((await request(socket, 'diagnostics:clear', {})).ok).toBe(false);
    await application.scheduler.start();
    expect((await request(socket, 'diagnostics:clear', { confirm: true })).error).toContain('Choose Stop');
    application.scheduler.stop();
    expect((await request(socket, 'diagnostics:clear', { confirm: true })).ok).toBe(true);
    expect((await application.world.diagnostics()).records).toHaveLength(0);
  });
  it('exports readable Markdown with protected labels, multiline messages and empty rooms while running', async () => {
    const url = await setup(), config = connect(url);
    await ready(config);
    await application.world.saveRoom({ id: 'room-1', name: 'Reading *room* [one] <&>\nnext', description: 'Not in conversation export' });
    const agent = await application.world.saveAgent({
      name: 'A **speaker** [name]', instructions: 'Private agent settings', roomId: 'room-1', provider: 'chatgpt', model: 'gpt-6-luna',
      enabled: true, minIntervalMs: 1000, maxIntervalMs: 1000, contextMessageLimit: 50,
    });
    const content = 'Hello, 世界 🌱\r\n\r\n# A heading inside a message\n```ts\nconst value = "<example>";\n```\nLast line.';
    const accepted = await application.world.applyAction(agent.id, agent.revision, { type: 'speak', message: content }, () => true);
    await application.world.deleteAgent(agent.id);
    await application.world.speak('room-2', 'Another room');
    await application.scheduler.start();
    const state = await application.world.state();
    const updated = vi.fn(), message = vi.fn();
    config.on('world:state', updated);
    config.on('conversation:message', message);
    const result = await request(config, 'history:export', {});
    expect(result.ok).toBe(true);
    expect(result.value).toMatch(/^# Terrarium conversations\n\nExported: \d{4}-\d{2}-\d{2}T/);
    expect(result.value).toContain('## Reading \\*room\\* \\[one\\] &lt;&amp;&gt; next\n');
    expect(result.value).toContain(`**A \\*\\*speaker\\*\\* \\[name\\]** — ${accepted.message!.createdAt}`);
    expect(result.value).toContain(content.replace(/\r\n?/g, '\n').split('\n').map(line => `> ${line}`).join('\n'));
    expect(result.value).toContain('## room-2\n\n**Human**');
    expect(result.value).toContain('## room-5\n\n_No messages._\n');
    expect(result.value).not.toContain('Private agent settings');
    expect(result.value).not.toContain('Not in conversation export');
    expect(updated).not.toHaveBeenCalled();
    expect(message).not.toHaveBeenCalled();
    expect(await application.world.state()).toEqual(state);
    expect(application.scheduler.snapshot().state).toBe('running');
    application.scheduler.pause();
    expect((await request(config, 'history:export', {})).ok).toBe(true);
    application.scheduler.stop();
    expect((await request(config, 'history:export', {})).ok).toBe(true);
  });
  it('exports beyond one page and one MiB over the existing socket connection without truncation', async () => {
    const url = await setup(), config = connect(url);
    await ready(config);
    for (let index = 0; index < 160; index++)
      await application.world.speak('room-1', `Message ${index}: ${'x'.repeat(7900)}`);
    const result = await config.timeout(10000).emitWithAck('history:export', {});
    expect(result.ok).toBe(true);
    expect(Buffer.byteLength(result.value, 'utf8')).toBeGreaterThan(1024 * 1024);
    expect(result.value.match(/^> Message \d+:/gm)).toHaveLength(160);
    expect(result.value.indexOf('> Message 0:')).toBeLessThan(result.value.indexOf('> Message 159:'));
    expect(result.value).toContain(`> Message 159: ${'x'.repeat(7900)}`);
    expect(result.value).toContain('## room-5\n\n_No messages._');
  });
  it('rejects export filters and reports read failures without returning a partial file', async () => {
    const url = await setup(), config = connect(url);
    await ready(config);
    for (const input of [null, { roomId: 'room-1' }, { limit: 100 }])
      expect((await request(config, 'history:export', input)).ok).toBe(false);
    vi.spyOn(application.world, 'exportConversations').mockRejectedValueOnce(new Error('Database unavailable'));
    const result = await request(config, 'history:export', {});
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
    expect(result).not.toHaveProperty('value');
    expect((await request(config, 'history:export', {})).ok).toBe(true);
  });
  it.each(['running', 'paused', 'stopped'])('deletes an agent while %s, cancels its turn and preserves messages', async (state) => {
    let complete!: (value: { content: string }) => void;
    const provider = {
      name: 'fake',
      complete: vi.fn((_request: LmCompletionRequest) => new Promise<{ content: string }>((resolve) => { complete = resolve; })),
    };
    const url = await setup(provider), config = connect(url), other = connect(url);
    await Promise.all([ready(config), ready(other)]);
    const input = {
      name: 'Delete me', instructions: 'Speak.', roomId: 'room-1', provider: 'chatgpt' as const, model: 'gpt-6-luna',
      enabled: true, minIntervalMs: 1000, maxIntervalMs: 1000, contextMessageLimit: 50,
    };
    const agent = await application.world.saveAgent(input);
    const kept = await application.world.saveAgent({ ...input, name: 'Keep me', enabled: false });
    await application.world.applyAction(agent.id, agent.revision, { type: 'speak', message: 'Saved before deletion' }, () => true);
    const history = await application.world.history({ roomId: 'room-1' });
    if (state !== 'stopped') {
      await application.scheduler.start();
      await application.scheduler.tick();
      await vi.waitFor(() => expect(provider.complete).toHaveBeenCalledOnce());
      if (state === 'paused') application.scheduler.pause();
    }
    const updated = vi.fn(), notified = vi.fn();
    other.on('world:state', updated);
    config.on('conversation:message', notified);
    expect(await request(config, 'agents:delete', { id: agent.id })).toEqual({ ok: true, value: { id: agent.id } });
    await vi.waitFor(() => expect(updated).toHaveBeenCalledOnce());
    expect(updated.mock.calls[0][0].agents).toEqual([kept]);
    expect(updated.mock.calls[0][0].rooms).toHaveLength(5);
    expect(application.scheduler.snapshot().state).toBe(state);
    expect(application.scheduler.snapshot().agents.some(item => item.agentId === agent.id)).toBe(false);
    if (state !== 'stopped') {
      expect(provider.complete.mock.calls[0][0].signal?.aborted).toBe(true);
      complete({ content: '{"action":{"type":"speak","message":"Late reply"}}' });
      await new Promise(resolve => setTimeout(resolve, 30));
      await application.scheduler.tick();
      expect(provider.complete).toHaveBeenCalledOnce();
    }
    expect(notified).not.toHaveBeenCalled();
    expect(await application.world.history({ roomId: 'room-1' })).toEqual(history);
    expect(await application.world.agent(agent.id)).toBeUndefined();
    const exported = (await request(config, 'config:export', {})).value;
    expect(exported.agents.map((item: { id: string }) => item.id)).toEqual([kept.id]);
  });
  it('rejects malformed, missing and failed agent deletions without broadcasting changed state', async () => {
    const url = await setup(), config = connect(url);
    await ready(config);
    const agent = await application.world.saveAgent({
      name: 'Keep', instructions: 'Observe.', roomId: 'room-1', provider: 'chatgpt', model: 'gpt-6-luna',
      enabled: false, minIntervalMs: 1000, maxIntervalMs: 1000, contextMessageLimit: 50,
    });
    const updated = vi.fn();
    config.on('world:state', updated);
    for (const payload of [null, {}, { id: '' }, { id: 'missing' }, { id: agent.id, deleteMessages: true }])
      expect((await request(config, 'agents:delete', payload)).ok).toBe(false);
    vi.spyOn(application.world, 'deleteAgent').mockRejectedValueOnce(new Error('Database unavailable'));
    expect((await request(config, 'agents:delete', { id: agent.id })).ok).toBe(false);
    expect(updated).not.toHaveBeenCalled();
    expect(await application.world.agent(agent.id)).toEqual(agent);
    expect((await request(config, 'agents:delete', { id: agent.id })).ok).toBe(true);
    expect(await request(config, 'agents:delete', { id: agent.id })).toMatchObject({ ok: false, error: 'Agent does not exist.' });
  });
  it('broadcasts room and all-room clearing to both views and removes agent context', async () => {
    const url = await setup(), config = connect(url), other = connect(url), terrain = connect(url, 'terrain');
    await Promise.all([ready(config), ready(other), ready(terrain)]);
    const agent = await application.world.saveAgent({
      name: 'Observer', instructions: 'Observe.', roomId: 'room-1', provider: 'chatgpt', model: 'gpt-6-luna',
      enabled: false, minIntervalMs: 1000, maxIntervalMs: 1000, contextMessageLimit: 50,
    });
    const original = await application.world.state();
    await application.world.speak('room-1', 'Clear context');
    await application.world.speak('room-2', 'Keep context');
    const observed = [vi.fn(), vi.fn(), vi.fn()];
    [config, other, terrain].forEach((socket, index) => socket.on('conversation:cleared', observed[index]));
    const result = await request(config, 'history:clear', { scope: 'room', roomId: 'room-1' });
    expect(result).toEqual({ ok: true, value: { roomIds: ['room-1'], deletedMessages: 1 } });
    await vi.waitFor(() => observed.forEach((listener) => expect(listener).toHaveBeenCalledWith(result.value)));
    expect((await assembleContext(application.world, agent))[1].content).toBe('[]');
    expect((await request(other, 'history:get', { roomId: 'room-2' })).value.messages).toHaveLength(1);
    const cleared = await request(config, 'history:clear', { scope: 'all' });
    expect(cleared.ok).toBe(true);
    expect(cleared.value.roomIds).toHaveLength(5);
    expect(cleared.value.deletedMessages).toBe(1);
    expect(await application.world.state()).toEqual(original);
    other.close();
    const reconnected = connect(url);
    await ready(reconnected);
    expect((await request(reconnected, 'history:get', { roomId: 'room-2' })).value.messages).toEqual([]);
  });
  it.each(['running', 'paused'])('rejects conversation clearing while %s', async (state) => {
    const url = await setup(), config = connect(url);
    await ready(config);
    await application.world.speak('room-1', 'Keep while active');
    await application.scheduler.start();
    if (state === 'paused') application.scheduler.pause();
    expect(await request(config, 'history:clear', { scope: 'all' })).toMatchObject({ ok: false, error: expect.stringContaining('Choose Stop') });
    expect((await application.world.history({ roomId: 'room-1' })).messages).toHaveLength(1);
  });
  it('rejects invalid clear selections without deleting or notifying', async () => {
    const url = await setup(), config = connect(url);
    await ready(config);
    const message = await application.world.speak('room-1', 'Keep');
    const cleared = vi.fn();
    config.on('conversation:cleared', cleared);
    for (const input of [null, {}, { scope: 'room' }, { scope: 'room', roomId: 'missing' }, { scope: 'all', roomId: 'room-1' }])
      expect((await request(config, 'history:clear', input)).ok).toBe(false);
    expect(cleared).not.toHaveBeenCalled();
    expect((await application.world.history({ roomId: 'room-1' })).messages).toEqual([message]);
  });
  it('blocks starting and messages during clearing and releases the guard after failure', async () => {
    const url = await setup(), config = connect(url), other = connect(url);
    await Promise.all([ready(config), ready(other)]);
    const notified = vi.fn();
    config.on('conversation:cleared', notified);
    let fail!: (error: Error) => void;
    const pending = new Promise<never>((_, reject) => { fail = reject; });
    const clear = vi.spyOn(application.world, 'clearHistory').mockReturnValueOnce(pending);
    const clearing = request(config, 'history:clear', { scope: 'all' });
    await vi.waitFor(() => expect(clear).toHaveBeenCalledOnce());
    for (const [event, payload] of [
      ['run:control', 'start'],
      ['config:message', { roomId: 'room-1', message: 'Blocked' }],
      ['history:clear', { scope: 'all' }],
    ]) expect((await request(other, event, payload)).error).toContain('clearing is in progress');
    fail(new Error('Injected clear failure'));
    expect((await clearing).ok).toBe(false);
    expect(notified).not.toHaveBeenCalled();
    expect((await request(other, 'config:message', { roomId: 'room-1', message: 'Allowed' })).ok).toBe(true);
    expect((await request(other, 'history:clear', { scope: 'all' })).ok).toBe(true);
    expect((await request(other, 'run:control', 'start')).ok).toBe(true);
  });
  it('discards a late agent reply after Stop and clearing', async () => {
    let complete!: (value: { content: string }) => void;
    const provider = { name: 'fake', complete: vi.fn(() => new Promise<{ content: string }>((resolve) => { complete = resolve; })) };
    const url = await setup(provider), config = connect(url);
    await ready(config);
    await application.world.saveAgent({
      name: 'Late', instructions: 'Speak.', roomId: 'room-1', provider: 'chatgpt', model: 'gpt-6-luna',
      enabled: true, minIntervalMs: 1000, maxIntervalMs: 1000, contextMessageLimit: 50,
    });
    await application.world.speak('room-1', 'Old context');
    await request(config, 'run:control', 'start');
    await application.scheduler.tick();
    await vi.waitFor(() => expect(provider.complete).toHaveBeenCalledOnce());
    await request(config, 'run:control', 'stop');
    expect((await request(config, 'history:clear', { scope: 'all' })).ok).toBe(true);
    const seen = vi.fn();
    config.on('conversation:message', seen);
    complete({ content: '{"action":{"type":"speak","message":"Stale reply"}}' });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect((await request(config, 'history:get', { roomId: 'room-1' })).value.messages).toEqual([]);
    expect(seen).not.toHaveBeenCalled();
  });
  it('exports, previews and imports configuration, publishing saved changes while remaining stopped', async () => {
    const url = await setup(),
      config = connect(url),
      terrain = connect(url, 'terrain');
    await Promise.all([ready(config), ready(terrain)]);
    const exported = await request(config, 'config:export', {});
    expect(exported.ok).toBe(true);
    expect(exported.value).toMatchObject({
      format: 'terrarium-config',
      version: 2,
      agents: [],
    });
    const configuration = {
      ...exported.value,
      rooms: [
        {
          id: 'import-room',
          name: 'Imported room',
          description: 'Saved from JSON.',
          isFoodSource: false,
        },
      ],
      agents: [
        {
          id: 'import-agent',
          name: 'Imported agent',
          instructions: 'Observe.',
          motivations: '', intention: '',
          roomId: 'import-room',
          provider: 'chatgpt',
          model: 'gpt-6-luna',
          enabled: true,
          minIntervalMs: 1000,
          maxIntervalMs: 2000,
          contextMessageLimit: 10,
        },
      ],
    };
    const preview = await request(config, 'config:preview', configuration);
    expect(preview.ok).toBe(true);
    expect(preview.value.rooms[0].operation).toBe('add');
    expect(await application.world.agent('import-agent')).toBeUndefined();
    const worldChanged = vi.fn(),
      roomsChanged = vi.fn();
    config.on('world:state', worldChanged);
    terrain.on('rooms:list', roomsChanged);
    const imported = await request(config, 'config:import', {
      configuration,
      previewToken: preview.value.token,
    });
    expect(imported.ok).toBe(true);
    await vi.waitFor(() => expect(roomsChanged).toHaveBeenCalledOnce());
    expect(worldChanged).toHaveBeenCalledOnce();
    expect(roomsChanged.mock.calls[0][0]).toContain('import-room');
    expect(application.scheduler.snapshot().state).toBe('stopped');
    expect(await application.world.agent('import-agent')).toMatchObject({
      enabled: true,
    });
    expect(
      (await request(config, 'config:export', {})).value.agents,
    ).toEqual(configuration.agents);
  });
  it.each(['running', 'paused'])(
    'rejects configuration imports while %s',
    async (state) => {
      const url = await setup(),
        config = connect(url);
      await ready(config);
      const configuration = (await request(config, 'config:export', {}))
        .value;
      const preview = (
        await request(config, 'config:preview', configuration)
      ).value;
      await application.scheduler.start();
      if (state === 'paused') application.scheduler.pause();
      const result = await request(config, 'config:import', {
        configuration,
        previewToken: preview.token,
      });
      expect(result).toMatchObject({
        ok: false,
        error: expect.stringContaining('Choose Stop'),
      });
      expect(application.scheduler.snapshot().state).toBe(state);
    },
  );
  it('reports invalid files and unknown rooms without publishing changed state', async () => {
    const url = await setup(),
      config = connect(url);
    await ready(config);
    const original = (await request(config, 'config:export', {})).value;
    const worldChanged = vi.fn();
    config.on('world:state', worldChanged);
    for (const configuration of [
      null,
      { ...original, version: 3 },
      { ...original, rooms: [{ name: 'Missing ID' }] },
    ]) {
      expect(
        (await request(config, 'config:preview', configuration)).ok,
      ).toBe(false);
      expect(
        (
          await request(config, 'config:import', {
            configuration,
            previewToken: '0'.repeat(64),
          })
        ).ok,
      ).toBe(false);
    }
    const missingRoom = {
      ...original,
      agents: [
        {
          id: 'a',
          name: 'A',
          instructions: 'Wait.',
          motivations: '', intention: '',
          roomId: 'missing',
          provider: 'chatgpt',
          model: 'gpt-6-luna',
          enabled: false,
          minIntervalMs: 1000,
          maxIntervalMs: 1000,
          contextMessageLimit: 50,
        },
      ],
    };
    expect(
      (await request(config, 'config:preview', missingRoom)).error,
    ).toContain('unknown room');
    expect(worldChanged).not.toHaveBeenCalled();
    expect((await request(config, 'config:export', {})).value).toEqual(
      original,
    );
  });
  it('blocks start and competing writes during import, then releases the guard after failure', async () => {
    const url = await setup(),
      config = connect(url),
      other = connect(url);
    await Promise.all([ready(config), ready(other)]);
    const configuration = (await request(config, 'config:export', {}))
      .value;
    const preview = (await request(config, 'config:preview', configuration))
      .value;
    let fail!: (error: Error) => void;
    const pending = new Promise<never>((_, reject) => {
      fail = reject;
    });
    const importer = vi
      .spyOn(application.world, 'importConfiguration')
      .mockReturnValueOnce(pending);
    const importing = request(config, 'config:import', {
      configuration,
      previewToken: preview.token,
    });
    await vi.waitFor(() => expect(importer).toHaveBeenCalledOnce());
    for (const [event, payload] of [
      ['run:control', 'start'],
      ['rooms:save', { name: 'Blocked room', description: '' }],
      ['agents:delete', { id: 'blocked-agent' }],
      ['config:import', { configuration, previewToken: preview.token }],
    ] as const)
      expect((await request(other, event, payload)).error).toContain(
        'import is in progress',
      );
    expect(application.scheduler.snapshot().state).toBe('stopped');
    fail(new Error('Injected import failure'));
    expect((await importing).ok).toBe(false);
    expect((await request(other, 'run:control', 'start')).ok).toBe(true);
  });
  it('rejects malformed input and failed saves, then broadcasts one saved record to both views', async () => {
    const url = await setup(),
      config = connect(url),
      terrain = connect(url, 'terrain');
    await Promise.all([ready(config), ready(terrain)]);
    const seenConfig = vi.fn(),
      seenTerrain = vi.fn();
    config.on('conversation:message', seenConfig);
    terrain.on('conversation:message', seenTerrain);
    for (const payload of [
      null,
      {},
      { roomId: 'room-1', message: ' ' },
      { roomId: 'missing', message: 'hello' },
      { roomId: 'room-1', message: 'x'.repeat(8001) },
    ])
      expect((await request(config, 'config:message', payload)).ok).toBe(false);
    const failure = vi
      .spyOn(application.world, 'speak')
      .mockRejectedValueOnce(new Error('Database unavailable'));
    expect(
      (
        await request(config, 'config:message', {
          roomId: 'room-1',
          message: 'failed save',
        })
      ).ok,
    ).toBe(false);
    failure.mockRestore();
    expect(seenConfig).not.toHaveBeenCalled();
    expect(seenTerrain).not.toHaveBeenCalled();
    const result = await request(config, 'config:message', {
      roomId: 'room-1',
      message: 'saved message',
    });
    expect(result.ok).toBe(true);
    await vi.waitFor(() => expect(seenTerrain).toHaveBeenCalledOnce());
    expect(seenConfig).toHaveBeenCalledOnce();
    expect(seenTerrain.mock.calls[0][0]).toEqual(result.value);
    expect(
      (await request(config, 'history:get', { roomId: 'room-1' })).value
        .messages,
    ).toEqual([result.value]);
  });
  it('recovers more than a page of messages missed while disconnected', async () => {
    const url = await setup(),
      config = connect(url);
    await ready(config);
    const first = (
      await request(config, 'config:message', {
        roomId: 'room-1',
        message: 'before disconnect',
      })
    ).value;
    config.close();
    for (let index = 0; index < 205; index++)
      await application.world.speak('room-1', `offline ${index}`);
    const reconnected = connect(url);
    await ready(reconnected);
    let after = { id: first.id, createdAt: first.createdAt };
    const recovered: any[] = [];
    for (;;) {
      const result = await request(reconnected, 'history:get', {
        roomId: 'room-1',
        after,
      });
      expect(result.ok).toBe(true);
      recovered.push(...result.value.messages);
      if (!result.value.hasMore) break;
      const last = recovered[recovered.length - 1];
      after = { id: last.id, createdAt: last.createdAt };
    }
    expect(recovered).toHaveLength(205);
    expect(new Set(recovered.map((item) => item.id)).size).toBe(205);
  });
  it.each(['https://untrusted.example', undefined])(
    'rejects an unapproved or missing socket origin: %s',
    async (origin) => {
      const url = await setup();
      const socket = connect(url, 'config', origin ?? '');
      await expect(ready(socket)).rejects.toThrow();
      expect(socket.connected).toBe(false);
    },
  );
});
