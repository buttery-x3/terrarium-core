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
  isFoodSource: z.boolean().optional(),
}).strict();
export const agentInputSchema = z.object({
  id: z.string().min(1).optional(), name: messageTextSchema, instructions: messageTextSchema,
  roomId: roomIdSchema, provider: z.literal('chatgpt'), model: z.string().trim().min(1),
  enabled: z.boolean(), minIntervalMs: z.number().int().positive().max(2147483647),
  maxIntervalMs: z.number().int().positive().max(2147483647),
  contextMessageLimit: z.number().int().min(1).max(50),
  motivations: z.string().max(8000).optional(),
  intention: z.string().max(1000).optional(),
}).strict().refine(value => value.maxIntervalMs >= value.minIntervalMs, 'Maximum interval must be at least the minimum.');
export const deleteAgentSchema = z.object({ id: z.string().min(1) }).strict();
export const actionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('speak'), message: messageTextSchema }).strict(),
  z.object({ type: z.literal('move'), roomId: roomIdSchema }).strict(),
  z.object({ type: z.literal('wait') }).strict(),
  z.object({ type: z.literal('eat') }).strict(),
]);
export const actionResponseSchema = z.object({ action: actionSchema, intention: z.string().max(240).nullable().optional() }).strict();
export const actionResponseJsonSchema = {
  type: 'object',
  properties: {
    intention: { type: ['string', 'null'], maxLength: 240 },
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
        {
          type: 'object',
          properties: { type: { type: 'string', enum: ['eat'] } },
          required: ['type'],
          additionalProperties: false,
        },
      ],
    },
  },
  required: ['action', 'intention'],
  additionalProperties: false,
};
export const cursorSchema = z.object({ createdAt: z.string().datetime(), id: z.string().min(1) }).strict();
export const historyInputSchema = z.object({
  roomId: roomIdSchema, before: cursorSchema.optional(), after: cursorSchema.optional(),
}).strict().refine(value => !(value.before && value.after), 'Choose before or after, not both.');
export const runCommandSchema = z.enum(['start', 'pause', 'stop']);
export const clearHistorySchema = z.discriminatedUnion('scope', [
  z.object({ scope: z.literal('room'), roomId: roomIdSchema }).strict(),
  z.object({ scope: z.literal('all') }).strict(),
]);
export const configurationFileLimitBytes = 512 * 1024;
export const defaultPrompts = {
  framing: 'You inhabit a simulated terrarium. Choose how to spend this turn according to your own preferences and current circumstances.',
  profiles: 'Personality describes your manner and temperament. Motivations describe what you seek or avoid, including company, solitude, interests and tolerance for repetition. Current intention is an optional immediate aim, not memory or an obligation.',
  actionSelection: 'Choose one action first. Formulate speech only if you choose speak. Moving, eating, waiting, changing subject and remaining quietly content are valid choices. You need not continue a conversation, maintain consensus or complete another person\'s project. Silence does not imply boredom; interpret repetition through your preferences.',
  energy: 'When energy is enabled and low, prioritise obtaining food. Choose a food-source destination yourself, move there, then eat on a later turn. After eating, reconsider your next action; you may stay. Zero energy imposes no additional action restriction.',
  reminders: 'Describe only actions the world supports as completed actions. Imaginary construction or saying you ate does not change the world. An optional brief intention is a self-report for this decision, not private reasoning or future memory.',
};
export const promptSettingsSchema = z.object({
  framing: z.string().trim().min(1).max(8000),
  profiles: z.string().trim().min(1).max(8000),
  actionSelection: z.string().trim().min(1).max(8000),
  energy: z.string().trim().min(1).max(8000),
  reminders: z.string().max(8000),
}).strict();
export const settingsSchema = z.object({
  energy: z.object({
    enabled: z.boolean(), initial: z.number().finite().min(0), maximum: z.number().finite().positive(),
    depletionPerMinute: z.number().finite().min(0), lowThreshold: z.number().finite().min(0),
    replenishment: z.literal('fill'),
  }).strict().refine(value => value.initial <= value.maximum && value.lowThreshold <= value.maximum,
    'Initial energy and low threshold must not exceed maximum energy.'),
  prompts: promptSettingsSchema,
  diagnostics: z.object({ maxPayloadMiB: z.number().int().min(32).max(16384), retention: z.literal('manual') }).strict(),
}).strict();
export type Settings = z.infer<typeof settingsSchema>;
export const defaultSettings: Settings = {
  energy: { enabled: false, initial: 100, maximum: 100, depletionPerMinute: 5, lowThreshold: 25, replenishment: 'fill' },
  prompts: defaultPrompts,
  diagnostics: { maxPayloadMiB: 256, retention: 'manual' },
};
export const configurationSchema = z.object({
  format: z.literal('terrarium-config'),
  version: z.union([z.literal(1), z.literal(2)]),
  settings: settingsSchema.optional(),
  rooms: z.array(roomInputSchema.extend({ id: roomIdSchema })),
  agents: z.array(agentInputSchema.and(z.object({ id: z.string().min(1) }))),
}).strict().superRefine((value, context) => {
  if (value.version === 2) {
    if (!value.settings) context.addIssue({ code: z.ZodIssueCode.custom, path: ['settings'], message: 'Version 2 requires complete shared settings.' });
    value.rooms.forEach((room, index) => {
      if (room.isFoodSource === undefined) context.addIssue({ code: z.ZodIssueCode.custom, path: ['rooms', index, 'isFoodSource'], message: 'Version 2 requires a food-source flag.' });
    });
    value.agents.forEach((agent, index) => {
      for (const key of ['motivations', 'intention'] as const)
        if (agent[key] === undefined) context.addIssue({ code: z.ZodIssueCode.custom, path: ['agents', index, key], message: 'Version 2 requires this profile section; empty text is valid.' });
    });
  }
  for (const kind of ['rooms', 'agents'] as const) {
    const ids = new Set<string>();
    value[kind].forEach((item, index) => {
      if (ids.has(item.id)) context.addIssue({ code: z.ZodIssueCode.custom, path: [kind, index, 'id'], message: 'Duplicate ID in configuration.' });
      ids.add(item.id);
    });
  }
  if (new TextEncoder().encode(JSON.stringify(value, null, 2) + '\n').byteLength > configurationFileLimitBytes)
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Configuration must fit in a 512 KiB JSON file.' });
});
export const configurationImportSchema = z.object({
  configuration: configurationSchema,
  previewToken: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export type Configuration = z.infer<typeof configurationSchema>;
export type ConfigurationPreview = {
  token: string;
  rooms: { id: string; name: string; operation: 'add' | 'update' }[];
  agents: { id: string; name: string; operation: 'add' | 'update' }[];
  defaults: string[];
  settingsChanged: boolean;
};
export type RoomInput = z.infer<typeof roomInputSchema>;
export type AgentInput = z.infer<typeof agentInputSchema>;
export type AgentAction = z.infer<typeof actionSchema>;
export type HistoryInput = z.infer<typeof historyInputSchema>;
export type ClearHistoryInput = z.infer<typeof clearHistorySchema>;
export type HistoryCleared = { roomIds: string[]; deletedMessages: number };
export type HistoryCursor = z.infer<typeof cursorSchema>;
export type Room = { id: string; name: string; description: string; isFoodSource: boolean };
export type Agent = Omit<AgentInput, 'id'> & { id: string; revision: number; energy: number; motivations: string; intention: string };
export type ConversationMessage = {
  id: string; roomId: string; agentId: string; speaker: string; createdAt: string; content: string;
};
export type HistoryPage = { messages: ConversationMessage[]; hasMore: boolean };
export type ConversationExport = {
  exportedAt: string;
  rooms: { id: string; name: string; messages: ConversationMessage[] }[];
};
export type Result<T> = { ok: true; value: T } | { ok: false; error: string };
export type AgentActivity = { agentId: string; state: 'scheduled' | 'running' | 'error'; dueAt?: number; error?: string; turnId?: string };
export type RunState = { state: 'stopped' | 'running' | 'paused'; agents: AgentActivity[]; concurrency: number; error?: string };
export type AuthState = { connected: boolean; pending: boolean; error?: string };
export type WorldState = { rooms: Room[]; agents: Agent[]; settings: Settings; settingsVersion: number };

export const diagnosticFilterSchema = z.object({
  agentId: z.string().optional(), roomId: z.string().optional(),
  action: z.enum(['speak', 'move', 'wait', 'eat']).optional(),
  outcome: z.string().max(80).optional(), from: z.string().datetime().optional(), to: z.string().datetime().optional(),
  before: z.number().int().positive().optional(), limit: z.number().int().min(1).max(100).default(50),
}).strict();
export type DiagnosticFilter = z.input<typeof diagnosticFilterSchema>;
export type AttemptDetails = {
  payload?: Record<string, unknown>; output?: string; proposal?: unknown; selfReport?: string | null;
  requestId?: string; responseId?: string; settingsVersion?: number; agentRevision?: number;
  context?: unknown; energySeen?: number; energyBefore?: number; energyAfter?: number; passiveDecay?: number;
  sourceRoomId?: string; destinationRoomId?: string; moved?: boolean; messageId?: string;
  error?: string; notificationError?: string; truncated?: boolean; captureLimitBytes?: number;
};
export type DiagnosticRecord = {
  sequence: number; id: string; turnId: string; agentId: string; agentName: string; roomId: string;
  scheduledAt: string; dueAt: string; startedAt: string | null; endedAt: string | null;
  attempt: number; model: string; action: string | null; outcome: string; details?: AttemptDetails;
};
export type DiagnosticPage = { records: DiagnosticRecord[]; hasMore: boolean; next?: number };
export type DiagnosticUsage = { bytes: number; reservedBytes: number; limitBytes: number; retention: 'manual' };
