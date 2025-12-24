import { z } from 'zod';

export const roomIdSchema = z.string().min(1);

export const agentTurnSchema = z.object({
  agentId: z.string().min(1),
  roomId: roomIdSchema,
  minIntervalMs: z.number().int().positive(),
  maxIntervalMs: z.number().int().positive(),
});

export type AgentTurnConfig = z.infer<typeof agentTurnSchema>;
