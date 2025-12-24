import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { Server } from 'socket.io';
import pino from 'pino';

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });

const fastify = Fastify({ logger });
await fastify.register(cors, { origin: true });

fastify.get('/health', async () => ({ status: 'ok' }));

const io = new Server(fastify.server, {
  cors: {
    origin: true,
  },
});

const configNamespace = io.of('/config');
const terrainNamespace = io.of('/terrain');

configNamespace.on('connection', (socket) => {
  logger.info({ id: socket.id }, 'config client connected');
});

terrainNamespace.on('connection', (socket) => {
  logger.info({ id: socket.id }, 'terrain client connected');
});

// Simple, non-blocking scheduler that never awaits LM work inside the loop.
type RoomId = string;

type AgentTurn = {
  agentId: string;
  roomId: RoomId;
  dueAt: number;
  minIntervalMs: number;
  maxIntervalMs: number;
};

const turnQueue: AgentTurn[] = [];
const loopIntervalMs = 500;

const scheduleNextTurn = (turn: AgentTurn) => {
  const jitter =
    turn.minIntervalMs + Math.random() * (turn.maxIntervalMs - turn.minIntervalMs);
  turnQueue.push({ ...turn, dueAt: Date.now() + jitter });
};

const handleTurn = async (turn: AgentTurn) => {
  // TODO: call provider adapter; for now just echo.
  logger.debug({ agentId: turn.agentId, roomId: turn.roomId }, 'turn resolved');
  terrainNamespace.to(turn.roomId).emit('agent:update', {
    agentId: turn.agentId,
    roomId: turn.roomId,
    at: Date.now(),
    message: 'placeholder response',
  });
  scheduleNextTurn(turn);
};

setInterval(() => {
  const now = Date.now();
  const ready: AgentTurn[] = [];

  for (let i = turnQueue.length - 1; i >= 0; i -= 1) {
    if (turnQueue[i].dueAt <= now) {
      ready.push(turnQueue[i]);
      turnQueue.splice(i, 1);
    }
  }

  ready.forEach((turn) => {
    void handleTurn(turn); // fire-and-forget to avoid loop jitter
  });
}, loopIntervalMs);

const start = async () => {
  const port = Number(process.env.PORT ?? 3000);
  await fastify.listen({ port, host: '0.0.0.0' });
  logger.info({ port }, 'server listening');
};

void start();
