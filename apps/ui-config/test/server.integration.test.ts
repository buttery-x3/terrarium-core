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
