import { afterEach, describe, expect, it, vi } from 'vitest';
import { io, type Socket } from 'socket.io-client';
import { createApplication } from '../../server/src/app.js';
import {
  createDb,
  ensureTables,
} from '../../../packages/persistence/src/index.js';

const sockets: Socket[] = [];
let application: Awaited<ReturnType<typeof createApplication>>,
  db: ReturnType<typeof createDb>;
async function setup() {
  db = createDb(':memory:');
  await ensureTables(db);
  application = await createApplication({
    db,
    origins: ['http://localhost:4173'],
    quiet: true,
    provider: {
      name: 'fake',
      complete: async () => ({ content: '{"action":{"type":"wait"}}' }),
    },
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
  it('exports, previews and imports configuration, publishing saved changes while remaining stopped', async () => {
    const url = await setup(),
      config = connect(url),
      terrain = connect(url, 'terrain');
    await Promise.all([ready(config), ready(terrain)]);
    const exported = await request(config, 'config:export', {});
    expect(exported.ok).toBe(true);
    expect(exported.value).toMatchObject({
      format: 'terrarium-config',
      version: 1,
      agents: [],
    });
    const configuration = {
      ...exported.value,
      rooms: [
        {
          id: 'import-room',
          name: 'Imported room',
          description: 'Saved from JSON.',
        },
      ],
      agents: [
        {
          id: 'import-agent',
          name: 'Imported agent',
          instructions: 'Observe.',
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
      { ...original, version: 2 },
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
