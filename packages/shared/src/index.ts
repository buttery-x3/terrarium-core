import { z } from 'zod';

export const roomIdSchema = z.string().min(1);
const timingFieldsSchema = z.object({
  reflectionIntervalMs: z.number().int().positive().max(2147483647),
  speechMinDelayMs: z.number().int().positive().max(2147483647),
  speechMaxDelayMs: z.number().int().positive().max(2147483647),
  speechCooldownMs: z.number().int().positive().max(2147483647),
  emoteMinIntervalMs: z.number().int().positive().max(2147483647),
  emoteMaxIntervalMs: z.number().int().positive().max(2147483647),
}).strict();
export const schedulingSchema = timingFieldsSchema.extend({ engagementEnabled: z.boolean() })
  .refine(value => value.speechMaxDelayMs >= value.speechMinDelayMs && value.emoteMaxIntervalMs >= value.emoteMinIntervalMs,
    'Maximum speech and emote intervals must be at least their minimums.');
export const timingOverridesSchema = timingFieldsSchema.partial();

export const agentTurnSchema = z.object({
  agentId: z.string().min(1),
  roomId: roomIdSchema,
  minIntervalMs: z.number().int().positive(),
  maxIntervalMs: z.number().int().positive(),
});

export type AgentTurnConfig = z.infer<typeof agentTurnSchema>;

export const messageTextSchema = z.string().trim().min(1).max(8000);
export const emoteTextSchema = z.string().trim().min(1).max(240);
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
  timingOverrides: timingOverridesSchema.optional(),
}).strict().refine(value => value.maxIntervalMs >= value.minIntervalMs, 'Maximum interval must be at least the minimum.');
export const deleteAgentSchema = z.object({ id: z.string().min(1) }).strict();
export const actionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('speak'), message: messageTextSchema, replyToId: z.string().min(1).nullable().optional() }).strict(),
  z.object({ type: z.literal('emote'), message: emoteTextSchema }).strict(),
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
            type: { type: 'string', enum: ['emote'] },
            message: { type: 'string', minLength: 1, maxLength: 240, pattern: '\\S' },
          },
          required: ['type', 'message'],
          additionalProperties: false,
        },
        {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['speak'] },
            message: { type: 'string', minLength: 1, maxLength: 8000, pattern: '\\S' },
            replyToId: { type: ['string', 'null'], minLength: 1 },
          },
          required: ['type', 'message', 'replyToId'],
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
export function actionJsonSchema(emotesEnabled: boolean) {
  return { ...actionResponseJsonSchema, properties: { ...actionResponseJsonSchema.properties,
    action: { anyOf: actionResponseJsonSchema.properties.action.anyOf.filter(option =>
      emotesEnabled || option.properties.type.enum[0] !== 'emote') },
  } };
}
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
  actionSelection: 'Choose one available action first. Formulate speech only if you choose speak and a speech opportunity is available. Moving, eating, changing subject and waiting silently are valid choices. An emote opportunity permits an externally observable behaviour but never requires one. You need not continue a conversation, maintain consensus or complete another person\'s project. Silence does not imply boredom; interpret repetition through your preferences.',
  energy: 'When energy is enabled and low, prioritise obtaining food. Choose a food-source destination yourself, move there, then eat on a later turn. After eating, reconsider your next action; you may stay. Zero energy imposes no additional action restriction.',
  reminders: 'Describe only actions the world supports as completed actions. Imaginary construction or saying you ate does not change the world. Private reactions and immediate intentions describe your current state; they are not public speech, completed actions or obligations. Waiting silently produces no public event.',
  observations: 'Your personal memory contains only events you observed when present, including your own visible contributions. It travels with you between rooms. Read each item\'s timestamp, room and type: remembered activity is not necessarily happening now or here. Arriving gives you no earlier room transcript. You may listen, ask questions or mention experiences from elsewhere without any required greeting or topic change.',
  emotes: 'An emote is one short externally observable behaviour, at most 240 characters. Write in third person, identifying yourself. Quiet, mundane behaviour is enough, such as folding your arms and watching the doorway. Do not include inner thoughts, hidden intentions, monologues or quoted dialogue. Emotes cannot move you, feed you, create items, build machines or grant capabilities. Do not combine an emote with another action.',
  reflection: 'Reflect privately on your witnessed observations and current circumstances. Briefly report your current reaction and immediate intention, or return unchanged when neither changed. Nothing to do is valid. Decide independently whether to request later speech, engage with one local exchange, move, eat, or remain inactive. Reflection does not require public speech or an emote. A delayed speech request stores an intention; its words will be generated later against fresh context.',
};
export const promptSettingsSchema = z.object({
  framing: z.string().trim().min(1).max(8000),
  profiles: z.string().trim().min(1).max(8000),
  actionSelection: z.string().trim().min(1).max(8000),
  energy: z.string().trim().min(1).max(8000),
  reminders: z.string().max(8000),
  observations: z.string().trim().min(1).max(8000),
  emotes: z.string().trim().min(1).max(8000),
  reflection: z.string().trim().min(1).max(8000),
}).strict();
export const settingsSchema = z.object({
  energy: z.object({
    enabled: z.boolean(), initial: z.number().finite().min(0), maximum: z.number().finite().positive(),
    depletionPerMinute: z.number().finite().min(0), lowThreshold: z.number().finite().min(0),
    replenishment: z.literal('fill'),
  }).strict().refine(value => value.initial <= value.maximum && value.lowThreshold <= value.maximum,
    'Initial energy and low threshold must not exceed maximum energy.'),
  prompts: promptSettingsSchema,
  scheduling: schedulingSchema,
  activity: z.object({ roomEventsEnabled: z.boolean(), emotesEnabled: z.boolean() }).strict(),
  diagnostics: z.object({ maxPayloadMiB: z.number().int().min(32).max(16384), retention: z.literal('manual') }).strict(),
}).strict();
export type Settings = z.infer<typeof settingsSchema>;
export const defaultSettings: Settings = {
  energy: { enabled: false, initial: 100, maximum: 100, depletionPerMinute: 5, lowThreshold: 25, replenishment: 'fill' },
  prompts: defaultPrompts,
  scheduling: { reflectionIntervalMs: 60000, speechMinDelayMs: 15000, speechMaxDelayMs: 150000,
    speechCooldownMs: 15000, emoteMinIntervalMs: 120000, emoteMaxIntervalMs: 300000, engagementEnabled: true },
  activity: { roomEventsEnabled: true, emotesEnabled: true },
  diagnostics: { maxPayloadMiB: 256, retention: 'manual' },
};
const version3SettingsSchema = settingsSchema.omit({ scheduling: true }).extend({
  prompts: promptSettingsSchema.omit({ reflection: true }),
});
const legacySettingsSchema = settingsSchema.omit({ activity: true, scheduling: true }).extend({
  prompts: promptSettingsSchema.omit({ observations: true, emotes: true, reflection: true }),
});
export function upgradeReflectionSettings(value: z.infer<typeof version3SettingsSchema>): Settings {
  const previousActionSelection = 'Choose one available action first. Formulate speech only if you choose speak. Moving, eating, changing subject and remaining quietly content are valid choices. When emotes are enabled, choose emote instead of wait for a quiet turn; otherwise wait silently. You need not continue a conversation, maintain consensus or complete another person\'s project. Silence does not imply boredom; interpret repetition through your preferences.';
  const previousReminders = 'Describe only actions the world supports as completed actions. Imaginary construction or saying you ate does not change the world. An optional brief intention is a self-report for this decision, not private reasoning or future memory.';
  return { ...value, scheduling: { ...defaultSettings.scheduling }, prompts: { ...value.prompts,
    actionSelection: value.prompts.actionSelection === previousActionSelection ? defaultPrompts.actionSelection : value.prompts.actionSelection,
    reminders: value.prompts.reminders === previousReminders ? defaultPrompts.reminders : value.prompts.reminders,
    reflection: defaultPrompts.reflection,
  } };
}
export function resolveScheduling(settings: Settings, agent: Pick<AgentInput, 'timingOverrides'>) {
  return schedulingSchema.parse({ ...settings.scheduling, ...agent.timingOverrides });
}
export function upgradeLegacySettings(value: z.infer<typeof legacySettingsSchema>): Settings {
  const previousActionSelection = 'Choose one action first. Formulate speech only if you choose speak. Moving, eating, waiting, changing subject and remaining quietly content are valid choices. You need not continue a conversation, maintain consensus or complete another person\'s project. Silence does not imply boredom; interpret repetition through your preferences.';
  return upgradeReflectionSettings({ ...value, activity: { ...defaultSettings.activity }, prompts: { ...value.prompts,
    actionSelection: value.prompts.actionSelection === previousActionSelection ? defaultPrompts.actionSelection : value.prompts.actionSelection,
    observations: defaultPrompts.observations, emotes: defaultPrompts.emotes,
  } });
}
const configurationFields = z.object({
  format: z.literal('terrarium-config'),
  rooms: z.array(roomInputSchema.extend({ id: roomIdSchema })),
  agents: z.array(agentInputSchema.and(z.object({ id: z.string().min(1) }))),
}).strict();
const importedSettingsSchema = z.union([settingsSchema, version3SettingsSchema.transform(upgradeReflectionSettings), legacySettingsSchema.transform(upgradeLegacySettings)]);
export const configurationSchema = z.discriminatedUnion('version', [
  configurationFields.extend({ version: z.literal(1), settings: importedSettingsSchema.optional() }),
  configurationFields.extend({ version: z.literal(2), settings: importedSettingsSchema }),
  configurationFields.extend({ version: z.literal(3), settings: z.union([settingsSchema, version3SettingsSchema.transform(upgradeReflectionSettings)]) }),
  configurationFields.extend({ version: z.literal(4), settings: settingsSchema }),
]).superRefine((value, context) => {
  if (value.version >= 2) {
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
export const conversationMessageSchema = z.object({
  id: z.string().min(1), roomId: roomIdSchema, agentId: z.string().min(1), speaker: z.string(),
  createdAt: z.string().datetime(), content: z.string().min(1),
  type: z.enum(['speak', 'emote', 'arrival', 'departure']),
  replyToId: z.string().min(1).optional(), conversationId: z.string().min(1).optional(),
}).strict().superRefine((value, context) => {
  if (value.type !== 'speak' && (value.replyToId !== undefined || value.conversationId !== undefined))
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Only speech participates in a conversation exchange.' });
  if (value.type === 'emote' && !emoteTextSchema.safeParse(value.content).success)
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['content'], message: 'Emotes must contain 1–240 characters.' });
  if (value.type === 'speak' && !messageTextSchema.safeParse(value.content).success)
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['content'], message: 'Speech must contain 1–8000 characters.' });
});
export type ConversationMessage = z.infer<typeof conversationMessageSchema>;
export type HistoryPage = { messages: ConversationMessage[]; hasMore: boolean };
export type ConversationExport = {
  exportedAt: string;
  rooms: { id: string; name: string; messages: ConversationMessage[] }[];
};
export type Result<T> = { ok: true; value: T } | { ok: false; error: string };
export type ReflectionState = {
  agentId: string; reflectedAt: string | null; reaction: string | null; intention: string | null;
  lastSpeechAt: string | null; lastEmoteAt: string | null;
  engagement: { roomId: string; rootMessageId: string; targetAgentId: string } | null;
};
export type SpeechPlanProposal = { delayMs: number; replyToId: string | null; targetAgentId: string | null };
export type DecisionOpportunity = {
  reflection: boolean; speech: boolean; emote: boolean; requestedAt: number;
  reason: 'cadence' | 'engagement' | 'scheduled-speech';
  speechPlan?: { dueAt: number; requestedAt: number; replyToId: string | null; targetAgentId: string | null };
};
export type AgentActivity = { agentId: string; state: 'scheduled' | 'running' | 'error'; dueAt?: number; error?: string; turnId?: string;
  nextReflectionAt?: number; nextSpeechAt?: number; nextEmoteAt?: number; operation?: string };
export type RunState = { state: 'stopped' | 'running' | 'paused'; agents: AgentActivity[]; concurrency: number; error?: string };
export type AuthState = { connected: boolean; pending: boolean; error?: string };
export type WorldState = { rooms: Room[]; agents: Agent[]; settings: Settings; settingsVersion: number };

export const diagnosticFilterSchema = z.object({
  agentId: z.string().optional(), roomId: z.string().optional(),
  action: z.enum(['speak', 'emote', 'move', 'wait', 'eat']).optional(),
  outcome: z.string().max(80).optional(), from: z.string().datetime().optional(), to: z.string().datetime().optional(),
  before: z.number().int().positive().optional(), limit: z.number().int().min(1).max(100).default(50),
}).strict();
export type DiagnosticFilter = z.input<typeof diagnosticFilterSchema>;
export type AttemptDetails = {
  payload?: Record<string, unknown>; output?: string; proposal?: unknown; selfReport?: string | null;
  requestId?: string; responseId?: string; settingsVersion?: number; agentRevision?: number;
  context?: unknown; energySeen?: number; energyBefore?: number; energyAfter?: number; passiveDecay?: number;
  sourceRoomId?: string; destinationRoomId?: string; moved?: boolean; messageId?: string;
  eventIds?: string[];
  operation?: string; opportunities?: DecisionOpportunity; requestedAt?: number; schedule?: unknown; rawRequestedDelay?: number;
  reflection?: ReflectionState;
  error?: string; notificationError?: string; truncated?: boolean; captureLimitBytes?: number;
};
export type DiagnosticRecord = {
  sequence: number; id: string; turnId: string; agentId: string; agentName: string; roomId: string;
  scheduledAt: string; dueAt: string; startedAt: string | null; endedAt: string | null;
  attempt: number; model: string; action: string | null; outcome: string; details?: AttemptDetails;
  operation?: string; requestedAt?: string;
};
export type DiagnosticPage = { records: DiagnosticRecord[]; hasMore: boolean; next?: number };
export type DiagnosticUsage = { bytes: number; reservedBytes: number; limitBytes: number; retention: 'manual' };
