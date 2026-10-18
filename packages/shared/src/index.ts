import { z } from 'zod';

export const roomIdSchema = z.string().min(1);

export const agentTurnSchema = z.object({
  agentId: z.string().min(1),
  roomId: roomIdSchema,
  minIntervalMs: z.number().int().positive(),
  maxIntervalMs: z.number().int().positive(),
});

export type AgentTurnConfig = z.infer<typeof agentTurnSchema>;

export const messageTextSchema = z.string().trim().min(1).max(8000);
export const messageInputSchema = z.object({ roomId: roomIdSchema, message: messageTextSchema }).strict();
export const roomInputSchema = z.object({
  id: roomIdSchema.optional(), name: messageTextSchema, description: z.string().max(8000).default(''),
}).strict();
export const agentInputSchema = z.object({
  id: z.string().min(1).optional(), name: messageTextSchema, instructions: messageTextSchema,
  roomId: roomIdSchema, provider: z.literal('chatgpt'), model: z.string().trim().min(1),
  enabled: z.boolean(), minIntervalMs: z.number().int().positive().max(2147483647),
  maxIntervalMs: z.number().int().positive().max(2147483647),
  contextMessageLimit: z.number().int().min(1).max(50),
}).strict().refine(value => value.maxIntervalMs >= value.minIntervalMs, 'Maximum interval must be at least the minimum.');
export const actionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('speak'), message: messageTextSchema }).strict(),
  z.object({ type: z.literal('move'), roomId: roomIdSchema }).strict(),
  z.object({ type: z.literal('wait') }).strict(),
]);
export const actionResponseSchema = z.object({ action: actionSchema }).strict();
export const actionResponseJsonSchema = {
  type: 'object',
  properties: {
    action: {
      anyOf: [
        {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['speak'] },
            message: { type: 'string', minLength: 1, maxLength: 8000, pattern: '\\S' },
          },
          required: ['type', 'message'],
          additionalProperties: false,
        },
        {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['move'] },
            roomId: { type: 'string', minLength: 1 },
          },
          required: ['type', 'roomId'],
          additionalProperties: false,
        },
        {
          type: 'object',
          properties: { type: { type: 'string', enum: ['wait'] } },
          required: ['type'],
          additionalProperties: false,
        },
      ],
    },
  },
  required: ['action'],
  additionalProperties: false,
};
export const cursorSchema = z.object({ createdAt: z.string().datetime(), id: z.string().min(1) }).strict();
export const historyInputSchema = z.object({
  roomId: roomIdSchema, before: cursorSchema.optional(), after: cursorSchema.optional(),
}).strict().refine(value => !(value.before && value.after), 'Choose before or after, not both.');
export const runCommandSchema = z.enum(['start', 'pause', 'stop']);

export type RoomInput = z.infer<typeof roomInputSchema>;
export type AgentInput = z.infer<typeof agentInputSchema>;
export type AgentAction = z.infer<typeof actionSchema>;
export type HistoryInput = z.infer<typeof historyInputSchema>;
export type HistoryCursor = z.infer<typeof cursorSchema>;
export type Room = { id: string; name: string; description: string };
export type Agent = Omit<AgentInput, 'id'> & { id: string; revision: number };
export type ConversationMessage = {
  id: string; roomId: string; agentId: string; speaker: string; createdAt: string; content: string;
};
export type HistoryPage = { messages: ConversationMessage[]; hasMore: boolean };
export type Result<T> = { ok: true; value: T } | { ok: false; error: string };
export type AgentActivity = { agentId: string; state: 'scheduled' | 'running' | 'error'; dueAt?: number; error?: string };
export type RunState = { state: 'stopped' | 'running' | 'paused'; agents: AgentActivity[]; concurrency: number; error?: string };
export type AuthState = { connected: boolean; pending: boolean; error?: string };
export type WorldState = { rooms: Room[]; agents: Agent[] };
