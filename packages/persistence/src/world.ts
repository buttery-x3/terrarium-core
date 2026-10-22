import { createHash, randomUUID } from 'node:crypto';
import { actionSchema, canEat, clearHistorySchema, configurationSchema, settingsSchema, diagnosticFilterSchema, resolveScheduling, timingOverridesSchema,
  appraisalProposalSchema, relationshipFilterSchema, relationshipSummaryProposalSchema, newsProposalSchema, newsHistoryFilterSchema, canonicalNewsUrl, mediaVoteChoiceSchema } from '@terrarium/shared';
import type { Kysely, Selectable } from 'kysely';
import { sql } from 'kysely';
import type {
  Agent,
  AgentAction,
  AgentInput,
  ConversationMessage,
  ConversationExport,
  Configuration,
  ConfigurationPreview,
  ClearHistoryInput,
  HistoryCleared,
  HistoryInput,
  HistoryPage,
  RoomInput,
  WorldState,
  Settings, AttemptDetails, DiagnosticFilter, DiagnosticRecord, DiagnosticPage, DiagnosticUsage, DiagnosticPruneResult,
  ReflectionState,
  AppraisalProposal, AppraisalRecord, RelationshipState, RelationshipSummary, RelationshipSummaryInput, RelationshipSummaryProposal,
  RelationshipContext, RelationshipFilter, RelationshipPage, AppraisalPage, RelationshipSummaryPage,
  NewsProposal, NewsItem, NewsState, NewsHistoryFilter, NewsHistoryPage,
  MediaProgramme, MediaBallotPublic, MediaBallot, MediaState, MediaDisplay, MediaVoteChoice, MediaVoteRecord, MediaVoteInput, MediaBallotPage,
} from '@terrarium/shared';
import type { DB } from './index.js';

export class DiagnosticError extends Error {}
export class ActionError extends Error {
  constructor(readonly category: 'stale' | 'world-validation' | 'persistence', message: string) { super(message); }
}

function configurationSettings(configuration: Configuration, state: WorldState): Settings {
  const settings = configuration.version >= 2 ? configuration.settings! : state.settings;
  return { ...settings, news: { ...settings.news, reasoningEffort: settings.news.reasoningEffort !== undefined
    ? settings.news.reasoningEffort : settings.news.model === state.settings.news.model ? state.settings.news.reasoningEffort ?? null : null } };
}

const agentRecord = (row: Selectable<DB['agents']>): Agent => ({
  id: row.id,
  name: row.name,
  instructions: row.instructions,
  roomId: row.room_id,
  provider: 'chatgpt',
  model: row.model,
  reasoningEffort: row.reasoning_effort,
  enabled: Boolean(row.enabled),
  minIntervalMs: row.min_interval_ms,
  maxIntervalMs: row.max_interval_ms,
  contextMessageLimit: row.context_message_limit,
  revision: row.revision,
  motivations: row.motivations,
  intention: row.intention,
  energy: row.energy,
  ...(row.timing_overrides !== '{}' ? { timingOverrides: timingOverridesSchema.parse(JSON.parse(row.timing_overrides)) } : {}),
});
const messageRecord = (
  row: Selectable<DB['messages']>,
): ConversationMessage => ({
  id: row.id,
  roomId: row.room_id,
  agentId: row.agent_id,
  speaker: row.speaker_name,
  createdAt: row.created_at,
  content: row.content,
  type: row.type,
  ...(row.reply_to_id ? { replyToId: row.reply_to_id } : {}),
  ...(row.conversation_id ? { conversationId: row.conversation_id } : {}),
});
export type ReflectionUpdate = { reaction?: string | null; intention?: string | null; engagement?: ReflectionState['engagement'] };
export type DecisionUpdate = {
  sourceIds?: readonly string[]; reflection?: { reaction: string | null; intention: string | null } | null;
  engagement?: ReflectionState['engagement']; targetAgentId?: string | null;
  engagementGuard?: NonNullable<ReflectionState['engagement']> & { replyToId: string; sourceAgentId: string };
  appraisals?: AppraisalProposal[];
};
const emptyReflection = (agentId: string): ReflectionState => ({ agentId, reflectedAt: null, reaction: null, intention: null,
  lastSpeechAt: null, lastEmoteAt: null, engagement: null });
const reflectionRecord = (row: Selectable<DB['reflections']>): ReflectionState => ({ agentId: row.agent_id,
  reflectedAt: row.reflected_at, reaction: row.reaction, intention: row.intention,
  lastSpeechAt: row.last_speech_at, lastEmoteAt: row.last_emote_at,
  engagement: row.engagement_room_id && row.engagement_root_message_id && row.engagement_target_agent_id ? {
    roomId: row.engagement_room_id, rootMessageId: row.engagement_root_message_id, targetAgentId: row.engagement_target_agent_id,
  } : null,
});
const appraisalRecord = (row: Selectable<DB['appraisals']>): AppraisalRecord => ({ id: row.id, sequence: row.sequence,
  observerId: row.observer_id, observerName: row.observer_name, targetAgentId: row.target_agent_id, targetName: row.target_name,
  source: JSON.parse(row.source), reaction: row.reaction, reason: row.reason, createdAt: row.created_at, scoreAfter: row.score_after });
const summaryRecord = (row: Selectable<DB['relationship_summaries']>): RelationshipSummary => ({ id: row.id,
  observerId: row.observer_id, targetAgentId: row.target_agent_id, version: row.version, summary: row.summary, createdAt: row.created_at,
  throughSequence: row.through_sequence, previousSummaryId: row.previous_summary_id, appraisalIds: JSON.parse(row.appraisal_ids) });
const newsRecord = (row: Selectable<DB['news_items']>): NewsItem => ({ id: row.id, sequence: row.sequence, headline: row.headline,
  description: row.description, category: row.category, publishedAt: row.published_at, retrievedAt: row.retrieved_at, sourceUrls: JSON.parse(row.source_urls) });
const mediaVoteRecord = (row: Selectable<DB['media_votes']>): MediaVoteRecord => ({ voterId: row.voter_id, voterName: row.voter_name,
  status: row.status, choice: row.choice, votedAt: row.voted_at, error: row.error });
const publicBallot = (ballot: MediaBallot): MediaBallotPublic => ({ id: ballot.id, roomId: ballot.roomId, proposerId: ballot.proposerId,
  proposerName: ballot.proposerName, title: ballot.title, description: ballot.description, openedAt: ballot.openedAt,
  remainingMs: ballot.remainingMs, electorateCount: ballot.electorateCount, requiredChangeVotes: ballot.requiredChangeVotes });

export class World {
  private energyClock: number | undefined;
  constructor(readonly db: Kysely<DB>) {}

  async rooms() {
    return (await this.db.selectFrom('rooms').selectAll().orderBy('id').execute())
      .map(({ is_food_source, ...room }) => ({ ...room, isFoodSource: Boolean(is_food_source) }));
  }
  async agents() {
    return (
      await this.db.selectFrom('agents').selectAll().orderBy('id').execute()
    ).map(agentRecord);
  }
  async agent(id: string) {
    const row = await this.db
      .selectFrom('agents')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    return row ? agentRecord(row) : undefined;
  }
  async state() {
    const settings = await this.settings();
    return { rooms: await this.rooms(), agents: await this.agents(), settings: settings.value, settingsVersion: settings.version };
  }

  async settings() {
    const row = await this.db.selectFrom('settings').selectAll().where('id', '=', 1).executeTakeFirstOrThrow();
    const value = settingsSchema.parse(JSON.parse(row.value));
    value.news.reasoningEffort ??= null;
    return { value, version: row.version };
  }

  async validateSettings(value: Settings) {
    const settings = settingsSchema.parse(value);
    const previous = (await this.settings()).value.news;
    settings.news.reasoningEffort = settings.news.reasoningEffort !== undefined ? settings.news.reasoningEffort
      : settings.news.model === previous.model ? previous.reasoningEffort ?? null : null;
    if (settings.news.enabled && !(await this.rooms()).some(room => room.id === settings.news.roomId))
      throw new Error('News requires an existing assigned room before it can be enabled.');
    if (settings.media.enabled && !(await this.rooms()).some(room => room.id === settings.media.roomId))
      throw new Error('Media requires an existing assigned room before it can be enabled.');
    for (const agent of await this.agents()) resolveScheduling(settings, agent);
    if (settings.energy.enabled && !(await this.rooms()).some(room => room.isFoodSource))
      throw new Error('Configuration requires at least one food-source room before energy can be enabled.');
    if ((await this.agents()).some(agent => agent.energy > settings.energy.maximum))
      throw new Error('Configuration maximum energy cannot be below an agent\'s current energy.');
    return settings;
  }

  async saveSettings(value: Settings) {
    return this.db.transaction().execute(async db => {
      const settings = await new World(db).validateSettings(value);
      await db.updateTable('settings').set(({ eb }) => ({ value: JSON.stringify(settings), version: eb('version', '+', 1) })).where('id', '=', 1).execute();
      if (!settings.scheduling.engagementEnabled) await new World(db).clearEngagements();
      return new World(db).settings();
    });
  }

  async syncEnergy(now = Date.now(), running = this.energyClock !== undefined) {
    const elapsed = this.energyClock === undefined ? 0 : Math.max(0, now - this.energyClock);
    this.energyClock = running ? now : undefined;
    if (!elapsed) return;
    await this.db.transaction().execute(async db => {
      const { energy } = (await new World(db).settings()).value;
      if (!energy.enabled) return;
      const depletion = elapsed / 60000 * energy.depletionPerMinute;
      await db.updateTable('agents').set(({ eb, fn }) => ({ energy: fn<number>('max', [eb('energy', '-', depletion), eb.val(0)]) }))
        .where('enabled', '=', 1).execute();
    });
  }

  async exportConfiguration(): Promise<Configuration> {
    return this.db.transaction().execute(async (db) => {
      const state = await new World(db).state();
      return configurationSchema.parse({
        format: 'terrarium-config',
        version: 9,
        settings: { ...state.settings, news: { ...state.settings.news, reasoningEffort: state.settings.news.reasoningEffort ?? null } },
        rooms: state.rooms,
        agents: state.agents.map(({ revision, energy, ...agent }) => agent),
      });
    });
  }

  async exportConversations(): Promise<ConversationExport> {
    return this.db.transaction().execute(async (db) => {
      const rooms = await db.selectFrom('rooms')
        .select(['id', 'name']).orderBy('id').execute();
      const rows = await db.selectFrom('messages').selectAll()
        .orderBy('room_id').orderBy('created_at').orderBy('id').execute();
      const messages = new Map<string, ConversationMessage[]>();
      for (const row of rows) {
        const roomMessages = messages.get(row.room_id) ?? [];
        roomMessages.push(messageRecord(row));
        messages.set(row.room_id, roomMessages);
      }
      return {
        exportedAt: new Date().toISOString(),
        rooms: rooms.map(room => ({ ...room, messages: messages.get(room.id) ?? [] })),
      };
    });
  }

  private configurationPreview(
    configuration: Configuration,
    state: WorldState,
  ): ConfigurationPreview {
    const roomIds = new Set(
      [...state.rooms, ...configuration.rooms].map((room) => room.id),
    );
    for (const agent of configuration.agents) {
      if (!roomIds.has(agent.roomId))
        throw new Error(
          `Configuration agent ${JSON.stringify(agent.name)} refers to an unknown room: ${JSON.stringify(agent.roomId)}.`,
        );
    }
    const rooms = new Set(state.rooms.map((room) => room.id));
    const agents = new Set(state.agents.map((agent) => agent.id));
    const defaults: string[] = [];
    if (configuration.version === 1) {
      defaults.push('Shared settings and existing newer profile/food fields are preserved.');
      for (const room of configuration.rooms)
        if (!rooms.has(room.id)) defaults.push(`Room ${room.id}: food source = false.`);
      for (const agent of configuration.agents)
        if (!agents.has(agent.id)) defaults.push(`Agent ${agent.id}: empty motivations/intention; initial energy ${state.settings.energy.initial}.`);
    }
    if (configuration.version === 2) defaults.push('Older settings include default observable-event and emote guidance when absent. Personal memories are not imported.');
    if (configuration.version < 4) defaults.push('Older settings use shared reflection, speech and emote timing defaults when absent. Private reflections are not imported.');
    if (configuration.version < 5) defaults.push('Older settings use default optional appraisal capacity and relationship-summary timing. Runtime appraisals and summaries are not imported.');
    if (configuration.version < 6) defaults.push('News is disabled by default for older settings. Existing room names, archives and runtime news history are preserved.');
    if (configuration.version < 7) defaults.push('Media is disabled by default for older settings. Runtime programmes and ballots are not imported.');
    if (configuration.version < 8) defaults.push('Existing explicit manual diagnostic retention is preserved; the rolling time setting defaults to 30 minutes.');
    if (configuration.version < 9) defaults.push('Missing reasoning effort preserves an existing choice for the same model; new or changed models use Model default.');
    const settings = configurationSettings(configuration, state);
    if (settings.diagnostics.retention !== 'manual') defaults.push('Rolling diagnostic retention automatically deletes eligible completed turn records, including existing records. Downloaded exports and world history are retained.');
    const mergedRooms = new Map(state.rooms.map(room => [room.id, room]));
    for (const room of configuration.rooms) mergedRooms.set(room.id, { ...room, isFoodSource: room.isFoodSource ?? mergedRooms.get(room.id)?.isFoodSource ?? false });
    if (settings.news.enabled && !mergedRooms.has(settings.news.roomId)) throw new Error('News requires an existing assigned room before it can be enabled.');
    if (settings.media.enabled && !mergedRooms.has(settings.media.roomId)) throw new Error('Media requires an existing assigned room before it can be enabled.');
    if (settings.energy.enabled && ![...mergedRooms.values()].some(room => room.isFoodSource))
      throw new Error('Configuration requires at least one food-source room while energy is enabled.');
    if (state.agents.some(agent => agent.energy > settings.energy.maximum))
      throw new Error('Configuration maximum energy cannot be below an agent\'s current energy.');
    const mergedAgents = new Map(state.agents.map(agent => [agent.id, agent]));
    for (const agent of configuration.agents) mergedAgents.set(agent.id, { ...mergedAgents.get(agent.id), ...agent } as Agent);
    for (const agent of mergedAgents.values()) resolveScheduling(settings, agent);
    return {
      token: createHash('sha256')
        .update(JSON.stringify({ configuration, state: { ...state, agents: state.agents.map(({ energy, ...agent }) => agent) } }))
        .digest('hex'),
      rooms: configuration.rooms.map((room) => ({
        id: room.id,
        name: room.name,
        operation: rooms.has(room.id) ? 'update' : 'add',
      })),
      agents: configuration.agents.map((agent) => ({
        id: agent.id,
        name: agent.name,
        operation: agents.has(agent.id) ? 'update' : 'add',
      })),
      defaults,
      settingsChanged: JSON.stringify(settings) !== JSON.stringify(state.settings),
    };
  }

  async previewConfiguration(
    input: Configuration,
  ): Promise<ConfigurationPreview> {
    const configuration = configurationSchema.parse(input);
    return this.db
      .transaction()
      .execute(async (db) =>
        this.configurationPreview(
          configuration,
          await new World(db).state(),
        ),
      );
  }

  async importConfiguration(
    input: Configuration,
    previewToken: string,
  ): Promise<ConfigurationPreview> {
    const configuration = configurationSchema.parse(input);
    return this.db.transaction().execute(async (db) => {
      const state = await new World(db).state();
      const preview = this.configurationPreview(configuration, state);
      if (preview.token !== previewToken)
        throw new Error(
          'Configuration changed since preview. Preview the file again before importing.',
        );
      // INVARIANT: the preview covers both the submitted file and the current saved configuration.
      for (const room of configuration.rooms) {
        const values = { id: room.id, name: room.name, description: room.description,
          is_food_source: Number(room.isFoodSource ?? state.rooms.find(saved => saved.id === room.id)?.isFoodSource ?? false) };
        await db
          .insertInto('rooms')
          .values(values)
          .onConflict((conflict) =>
            conflict
              .column('id')
              .doUpdateSet({
                name: room.name,
                description: room.description,
                is_food_source: values.is_food_source,
              }),
          )
          .execute();
      }
      const revisions = new Map(
        state.agents.map((agent) => [agent.id, agent.revision]),
      );
      for (const agent of configuration.agents) {
        const previous = state.agents.find(saved => saved.id === agent.id);
        const values = {
          id: agent.id,
          name: agent.name,
          instructions: agent.instructions,
          room_id: agent.roomId,
          provider: agent.provider,
          model: agent.model,
          reasoning_effort: agent.reasoningEffort !== undefined ? agent.reasoningEffort : previous?.model === agent.model ? previous.reasoningEffort ?? null : null,
          enabled: Number(agent.enabled),
          min_interval_ms: agent.minIntervalMs,
          max_interval_ms: agent.maxIntervalMs,
          context_message_limit: agent.contextMessageLimit,
          revision: (revisions.get(agent.id) ?? -1) + 1,
          motivations: agent.motivations ?? previous?.motivations ?? '',
          intention: agent.intention ?? previous?.intention ?? '',
          energy: previous?.energy ?? (configuration.version >= 2 ? configuration.settings! : state.settings).energy.initial,
          timing_overrides: JSON.stringify(agent.timingOverrides ?? previous?.timingOverrides ?? {}),
        };
        await db
          .insertInto('agents')
          .values(values)
          .onConflict((conflict) =>
            conflict.column('id').doUpdateSet(values),
          )
          .execute();
        await new World(db).trimMemory(agent.id, agent.contextMessageLimit);
        if (previous && (previous.roomId !== agent.roomId || !agent.enabled)) await new World(db).clearEngagements(agent.id);
      }
      if (configuration.version >= 2) await db.updateTable('settings').set(({ eb }) => ({
        value: JSON.stringify(configurationSettings(configuration, state)), version: eb('version', '+', 1),
      })).where('id', '=', 1).execute();
      if (configuration.settings && configuration.version >= 2 && !configuration.settings.scheduling.engagementEnabled)
        await new World(db).clearEngagements();
      return preview;
    });
  }

  async saveRoom(input: RoomInput) {
    return this.db.transaction().execute(async db => {
    const world = new World(db);
    const rooms = await world.rooms();
    const isFoodSource = input.isFoodSource ?? rooms.find(room => room.id === input.id)?.isFoodSource ?? false;
    if (!isFoodSource && (await world.settings()).value.energy.enabled && !rooms.some(room => room.id !== input.id && room.isFoodSource))
      throw new Error('Configuration cannot remove the last food-source room while energy is enabled.');
    const id = input.id ?? randomUUID();
    if (input.id) {
      const found = await db
        .updateTable('rooms')
        .set({ name: input.name, description: input.description, is_food_source: Number(isFoodSource) })
        .where('id', '=', id)
        .executeTakeFirst();
      if (!found.numUpdatedRows) throw new Error('Room does not exist.');
    } else {
      await db
        .insertInto('rooms')
        .values({ id, name: input.name, description: input.description, is_food_source: Number(isFoodSource) })
        .execute();
    }
    return { id, name: input.name, description: input.description, isFoodSource };
    });
  }

  async saveAgent(input: AgentInput) {
    await this.syncEnergy();
    return this.db.transaction().execute(async (db) => {
      const previous = input.id ? await new World(db).agent(input.id) : undefined;
      const timingOverrides = input.timingOverrides ?? previous?.timingOverrides;
      resolveScheduling((await new World(db).settings()).value, { timingOverrides });
      if (
        !(await db
          .selectFrom('rooms')
          .select('id')
          .where('id', '=', input.roomId)
          .executeTakeFirst())
      )
        throw new Error('Room does not exist.');
      const id = input.id ?? randomUUID();
      const values = {
        name: input.name,
        instructions: input.instructions,
        room_id: input.roomId,
        provider: input.provider,
        model: input.model,
        reasoning_effort: input.reasoningEffort !== undefined ? input.reasoningEffort : previous?.model === input.model ? previous.reasoningEffort ?? null : null,
        enabled: Number(input.enabled),
        min_interval_ms: input.minIntervalMs,
        max_interval_ms: input.maxIntervalMs,
        context_message_limit: input.contextMessageLimit,
        motivations: input.motivations ?? previous?.motivations ?? '',
        intention: input.intention ?? previous?.intention ?? '',
        timing_overrides: JSON.stringify(timingOverrides ?? {}),
      };
      if (input.id) {
        const updated = await db
          .updateTable('agents')
          .set(({ eb }) => ({ ...values, revision: eb('revision', '+', 1) }))
          .where('id', '=', id)
          .executeTakeFirst();
        if (!updated.numUpdatedRows) throw new Error('Agent does not exist.');
      } else {
        await db
          .insertInto('agents')
          .values({ ...values, id, revision: 0, energy: (await new World(db).settings()).value.energy.initial })
          .execute();
      }
      await new World(db).trimMemory(id, input.contextMessageLimit);
      if (previous && (previous.roomId !== input.roomId || !input.enabled)) await new World(db).clearEngagements(id);
      return agentRecord(
        await db
          .selectFrom('agents')
          .selectAll()
          .where('id', '=', id)
          .executeTakeFirstOrThrow(),
      );
    });
  }

  async deleteAgent(id: string) {
    return this.db.transaction().execute(async db => {
      const result = await db
        .deleteFrom('agents')
        .where('id', '=', id)
        .executeTakeFirstOrThrow();
      if (!result.numDeletedRows) throw new Error('Agent does not exist.');
      await db.deleteFrom('observations').where('agent_id', '=', id).execute();
      await new World(db).clearEngagements(id);
      await db.deleteFrom('reflections').where('agent_id', '=', id).execute();
      return { id };
    });
  }

  private async trimMemory(agentId: string, limit: number) {
    await this.db.deleteFrom('observations').where('agent_id', '=', agentId)
      .where('sequence', 'not in', this.db.selectFrom('observations').select('sequence')
        .where('agent_id', '=', agentId).orderBy('sequence', 'desc').limit(limit)).execute();
  }

  async memory(agentId: string): Promise<ConversationMessage[]> {
    return (await this.db.selectFrom('observations').innerJoin('messages', 'messages.id', 'observations.message_id')
      .selectAll('messages').where('observations.agent_id', '=', agentId)
      .orderBy('observations.sequence', 'asc').execute()).map(messageRecord);
  }

  async reflection(agentId: string): Promise<ReflectionState> {
    const row = await this.db.selectFrom('reflections').selectAll().where('agent_id', '=', agentId).executeTakeFirst();
    return row ? reflectionRecord(row) : emptyReflection(agentId);
  }

  async reflections(): Promise<ReflectionState[]> {
    const rows = new Map((await this.db.selectFrom('reflections').selectAll().execute()).map(row => [row.agent_id, reflectionRecord(row)]));
    return (await this.agents()).map(agent => rows.get(agent.id) ?? emptyReflection(agent.id));
  }

  async clearEngagements(agentId?: string) {
    let query = this.db.updateTable('reflections').set({ engagement_room_id: null, engagement_root_message_id: null, engagement_target_agent_id: null });
    if (agentId) query = query.where(eb => eb.or([eb('agent_id', '=', agentId), eb('engagement_target_agent_id', '=', agentId)]));
    await query.execute();
  }

  async mediaBallot(id: string): Promise<MediaBallot | null> {
    const row = await this.db.selectFrom('media_ballots').selectAll().where('id', '=', id).executeTakeFirst();
    if (!row) return null;
    const votes = (await this.db.selectFrom('media_votes').selectAll().where('ballot_id', '=', id).orderBy('voter_id').execute()).map(mediaVoteRecord);
    const counts = { change: 0, keep: 0, abstain: 0, pending: 0, invalid: 0, missing: 0, withdrawn: 0, cancelled: 0 };
    for (const vote of votes) {
      if (vote.status === 'cast') { if (vote.choice) counts[vote.choice]++; }
      else counts[vote.status]++;
    }
    return { id: row.id, sequence: row.sequence, roomId: row.room_id, programmeId: row.programme_id, current: JSON.parse(row.current_programme),
      proposerId: row.proposer_id, proposerName: row.proposer_name, title: row.title, description: row.description, openedAt: row.opened_at,
      closedAt: row.closed_at, status: row.status, remainingMs: row.remaining_ms, electorateCount: row.electorate_count,
      requiredChangeVotes: row.required_change_votes, votes, counts };
  }

  async mediaBallots(input: NewsHistoryFilter = {}): Promise<MediaBallotPage> {
    const filter = newsHistoryFilterSchema.parse(input);
    let query = this.db.selectFrom('media_ballots').select(['id', 'sequence']);
    if (filter.before) query = query.where('sequence', '<', filter.before);
    const rows = await query.orderBy('sequence', 'desc').limit(filter.limit + 1).execute();
    const ballots: MediaBallotPage['ballots'] = [];
    for (const row of rows.slice(0, filter.limit)) {
      const { votes, current, ...summary } = (await this.mediaBallot(row.id))!;
      ballots.push(summary);
    }
    return { ballots, hasMore: rows.length > filter.limit, next: ballots.at(-1)?.sequence };
  }

  async mediaState(): Promise<MediaState> {
    const state = await this.db.selectFrom('media_state').selectAll().where('id', '=', 1).executeTakeFirstOrThrow();
    const activeBallot = state.active_ballot_id ? await this.mediaBallot(state.active_ballot_id) : null;
    const lastBallot = state.last_ballot_id ? await this.mediaBallot(state.last_ballot_id) : null;
    return { current: state.current_programme ? JSON.parse(state.current_programme) : null, remainingMs: state.remaining_ms,
      cooldownRemainingMs: state.cooldown_remaining_ms, ballot: activeBallot ? publicBallot(activeBallot) : null, activeBallot, lastBallot };
  }

  async mediaDisplay(roomId: string): Promise<MediaDisplay | null> {
    const { media } = (await this.settings()).value;
    if (!media.enabled || media.roomId !== roomId) return null;
    const { current, remainingMs, cooldownRemainingMs, ballot } = await this.mediaState();
    return { current, remainingMs, cooldownRemainingMs, ballot };
  }

  private async finishMediaBallot(id: string, cancelled?: string): Promise<ConversationMessage[]> {
    let ballot = await this.mediaBallot(id);
    if (!ballot || ballot.status !== 'open') return [];
    if (cancelled) {
      await this.db.updateTable('media_votes').set({ status: 'cancelled', error: cancelled.slice(0, 1000) })
        .where('ballot_id', '=', id).where('status', '=', 'pending').execute();
      ballot = (await this.mediaBallot(id))!;
    }
    if (!cancelled && ballot.counts.pending) return [];
    const { media } = (await this.settings()).value;
    const status = cancelled ? 'cancelled' : ballot.counts.change >= ballot.requiredChangeVotes ? 'passed' : 'failed';
    await this.db.updateTable('media_ballots').set({ status, closed_at: new Date().toISOString(), remaining_ms: 0 }).where('id', '=', id).execute();
    await this.db.updateTable('media_state').set({ active_ballot_id: null, last_ballot_id: id, cooldown_remaining_ms: media.proposalCooldownMs }).where('id', '=', 1).execute();
    if (status === 'passed') {
      const programme: MediaProgramme = { id: randomUUID(), title: ballot.title, description: ballot.description,
        proposerId: ballot.proposerId, proposerName: ballot.proposerName, startedAt: new Date().toISOString() };
      await this.db.updateTable('media_state').set({ current_programme: JSON.stringify(programme), remaining_ms: media.programmeDurationMs }).where('id', '=', 1).execute();
    }
    const counts = ballot.counts;
    const result = `Vote ${status}: ${counts.change} change, ${counts.keep} keep, ${counts.abstain} abstain, ${counts.missing} missing, ${counts.invalid} invalid, ${counts.withdrawn} withdrawn, ${counts.cancelled} cancelled.`;
    const detail = status === 'passed' ? ` Now playing ${ballot.title}: ${ballot.description}` : cancelled ? ` ${cancelled}` : ' The current programme continues.';
    return [await this.insertMessage(this.db, ballot.roomId, 'world-media', 'Media display', result + detail, 'media')];
  }

  private async advanceMedia(now: number, running?: boolean): Promise<ConversationMessage[]> {
    const row = await this.db.selectFrom('media_state').selectAll().where('id', '=', 1).executeTakeFirstOrThrow();
    const { media } = (await this.settings()).value;
    const elapsed = row.clock_at === null ? 0 : Math.max(0, now - row.clock_at);
    const active = media.enabled && (running ?? row.clock_at !== null);
    const remaining = Math.max(0, row.remaining_ms - elapsed), events: ConversationMessage[] = [];
    await this.db.updateTable('media_state').set({ remaining_ms: row.current_programme ? remaining : 0,
      cooldown_remaining_ms: Math.max(0, row.cooldown_remaining_ms - elapsed), clock_at: active ? now : null }).where('id', '=', 1).execute();
    if (row.active_ballot_id) await this.db.updateTable('media_ballots').set(eb => ({ remaining_ms: eb.fn<number>('max', [eb('remaining_ms', '-', elapsed), eb.val(0)]) }))
      .where('id', '=', row.active_ballot_id).where('status', '=', 'open').execute();
    if (row.current_programme && remaining === 0) {
      await this.db.updateTable('media_state').set({ current_programme: null, remaining_ms: 0 }).where('id', '=', 1).execute();
      if (row.active_ballot_id) events.push(...await this.finishMediaBallot(row.active_ballot_id, 'The programme ended before the vote concluded.'));
      events.push(await this.insertMessage(this.db, media.roomId, 'world-media', 'Media display', 'Nothing is currently playing.', 'media'));
      return events;
    }
    if (row.active_ballot_id) {
      const ballot = await this.mediaBallot(row.active_ballot_id);
      if (ballot?.status === 'open') {
        const localIds = new Set((await this.db.selectFrom('agents').select('id').where('room_id', '=', ballot.roomId).where('enabled', '=', 1).execute()).map(agent => agent.id));
        for (const vote of ballot.votes) if (vote.status === 'pending' && !localIds.has(vote.voterId))
          await this.db.updateTable('media_votes').set({ status: 'withdrawn', error: 'The resident left or became unavailable before voting.' })
            .where('ballot_id', '=', ballot.id).where('voter_id', '=', vote.voterId).execute();
        if (!media.enabled || media.roomId !== ballot.roomId || !row.current_programme || JSON.parse(row.current_programme).id !== ballot.programmeId)
          events.push(...await this.finishMediaBallot(ballot.id, 'The room programme or capability changed.'));
        else {
          if (ballot.remainingMs <= 0) await this.db.updateTable('media_votes').set({ status: 'missing', error: 'The voting deadline passed without a response.' })
            .where('ballot_id', '=', ballot.id).where('status', '=', 'pending').execute();
          events.push(...await this.finishMediaBallot(ballot.id));
        }
      }
    }
    return events;
  }

  async syncMedia(now = Date.now(), running?: boolean): Promise<ConversationMessage[]> {
    return this.db.transaction().execute(db => new World(db).advanceMedia(now, running));
  }

  async cancelMediaBallots(reason: string): Promise<ConversationMessage[]> {
    return this.db.transaction().execute(async db => {
      const world = new World(db), events = await world.advanceMedia(Date.now(), false);
      const row = await db.selectFrom('media_state').selectAll().where('id', '=', 1).executeTakeFirstOrThrow();
      if (row.active_ballot_id) events.push(...await world.finishMediaBallot(row.active_ballot_id, reason));
      return events;
    });
  }

  private async proposeMedia(agent: Agent, action: Extract<AgentAction, { type: 'propose-media' }>): Promise<ConversationMessage[]> {
    const { media } = (await this.settings()).value;
    if (!media.enabled || media.roomId !== agent.roomId) throw new ActionError('world-validation', 'Programme proposals require the enabled media room.');
    const events = await this.advanceMedia(Date.now()), state = await this.mediaState();
    if (!state.current) {
      const programme: MediaProgramme = { id: randomUUID(), title: action.title, description: action.description,
        proposerId: agent.id, proposerName: agent.name, startedAt: new Date().toISOString() };
      await this.db.updateTable('media_state').set({ current_programme: JSON.stringify(programme), remaining_ms: media.programmeDurationMs }).where('id', '=', 1).execute();
      events.push(await this.insertMessage(this.db, agent.roomId, 'world-media', 'Media display', `${agent.name} starts ${action.title}: ${action.description}`, 'media'));
      return events;
    }
    if (state.activeBallot) throw new ActionError('world-validation', 'This room already has an active programme vote.');
    if (state.cooldownRemainingMs > 0) throw new ActionError('world-validation', 'Programme replacement proposals are cooling down.');
    const electorate = await this.db.selectFrom('agents').select(['id', 'name']).where('room_id', '=', agent.roomId).where('enabled', '=', 1).execute();
    const id = randomUUID();
    await this.db.insertInto('media_ballots').values({ id, room_id: agent.roomId, programme_id: state.current.id, current_programme: JSON.stringify(state.current),
      proposer_id: agent.id, proposer_name: agent.name, title: action.title, description: action.description, opened_at: new Date().toISOString(), closed_at: null,
      remaining_ms: media.ballotDurationMs, electorate_count: electorate.length, required_change_votes: Math.floor(electorate.length / 2) + 1, status: 'open' }).execute();
    await this.db.insertInto('media_votes').values(electorate.map(voter => ({ ballot_id: id, voter_id: voter.id, voter_name: voter.name,
      status: 'pending' as const, choice: null, voted_at: null, error: null }))).execute();
    await this.db.updateTable('media_state').set({ active_ballot_id: id }).where('id', '=', 1).execute();
    events.push(await this.insertMessage(this.db, agent.roomId, 'world-media', 'Media display', `${agent.name} proposes ${action.title}: ${action.description} A vote is open for the ${electorate.length} eligible residents.`, 'media'));
    return events;
  }

  async voteCandidates(limit = 20): Promise<{ voterId: string; ballotId: string; requestedAt: number }[]> {
    limit = newsHistoryFilterSchema.parse({ limit }).limit;
    const state = await this.mediaState();
    if (!state.activeBallot) return [];
    const candidates: { voterId: string; ballotId: string; requestedAt: number }[] = [];
    for (const vote of state.activeBallot.votes) if (vote.status === 'pending' && await this.voteInput(vote.voterId, state.activeBallot.id)) {
      candidates.push({ voterId: vote.voterId, ballotId: state.activeBallot.id, requestedAt: Date.parse(state.activeBallot.openedAt) });
      if (candidates.length === limit) break;
    }
    return candidates;
  }

  async voteInput(voterId: string, ballotId: string): Promise<MediaVoteInput | null> {
    const actor = await this.agent(voterId), ballot = await this.mediaBallot(ballotId), row = await this.db.selectFrom('media_state').selectAll().where('id', '=', 1).executeTakeFirstOrThrow();
    const { media } = (await this.settings()).value;
    const elapsed = row.clock_at === null ? 0 : Math.max(0, Date.now() - row.clock_at);
    if (!media.enabled || !actor?.enabled || !ballot || ballot.status !== 'open' || actor.roomId !== ballot.roomId || media.roomId !== ballot.roomId ||
      row.active_ballot_id !== ballot.id || !row.current_programme || JSON.parse(row.current_programme).id !== ballot.programmeId ||
      row.remaining_ms <= elapsed || ballot.remainingMs <= elapsed || !ballot.votes.some(vote => vote.voterId === voterId && vote.status === 'pending')) return null;
    return { voterId, ballot: publicBallot(ballot), current: JSON.parse(row.current_programme) };
  }

  private async writeMediaVote(voterId: string, revision: number, ballotId: string, update: { status: 'cast' | 'invalid' | 'missing'; choice: MediaVoteChoice | null; error: string | null },
    stillCurrent: () => boolean, attemptId?: string) {
    return this.db.transaction().execute(async db => {
      const world = new World(db), events = await world.advanceMedia(Date.now()), actor = await world.agent(voterId);
      const check = () => {
        if (!actor || !actor.enabled || actor.revision !== revision || !stillCurrent()) throw new ActionError('stale', 'This media vote is no longer current.');
      };
      check();
      if (!await world.voteInput(voterId, ballotId)) throw new ActionError('stale', 'This resident is no longer eligible, the vote already ended, or a response was already recorded.');
      if (attemptId) {
        const record = await db.selectFrom('decisions').selectAll().where('id', '=', attemptId).executeTakeFirstOrThrow();
        if (record.ended_at) throw new ActionError('stale', 'This vote attempt has already ended.');
      }
      await db.updateTable('media_votes').set({ status: update.status, choice: update.choice, error: update.error?.slice(0, 1000) ?? null, voted_at: new Date().toISOString() })
        .where('ballot_id', '=', ballotId).where('voter_id', '=', voterId).where('status', '=', 'pending').execute();
      events.push(...await world.finishMediaBallot(ballotId));
      const ballot = (await world.mediaBallot(ballotId))!;
      if (attemptId) await world.updateDiagnostic(attemptId, { mediaBallotId: ballotId, mediaVote: ballot.votes.find(vote => vote.voterId === voterId), eventIds: events.map(event => event.id) },
        update.status === 'cast' ? 'applied' : `vote-${update.status}`, 'media-vote');
      check();
      return { events, ballot };
    });
  }

  async saveMediaVote(voterId: string, revision: number, ballotId: string, choice: MediaVoteChoice, stillCurrent: () => boolean, attemptId?: string) {
    return this.writeMediaVote(voterId, revision, ballotId, { status: 'cast', choice: mediaVoteChoiceSchema.parse(choice), error: null }, stillCurrent, attemptId);
  }

  async recordMediaVoteFailure(voterId: string, revision: number, ballotId: string, status: 'invalid' | 'missing', error: string, stillCurrent: () => boolean, attemptId?: string) {
    if (!['invalid', 'missing'].includes(status)) throw new ActionError('world-validation', 'A failed media vote must be recorded as invalid or missing.');
    return this.writeMediaVote(voterId, revision, ballotId, { status, choice: null, error }, stillCurrent, attemptId);
  }

  async newsState(): Promise<NewsState> {
    const state = await this.db.selectFrom('news_state').selectAll().where('id', '=', 1).executeTakeFirstOrThrow();
    const current = state.current_item_id ? await this.db.selectFrom('news_items').selectAll().where('id', '=', state.current_item_id).executeTakeFirst() : undefined;
    return { current: current ? newsRecord(current) : null, lastAttemptAt: state.last_attempt_at, lastSuccessAt: state.last_success_at, error: state.error };
  }

  async newsHistory(input: NewsHistoryFilter = {}): Promise<NewsHistoryPage> {
    const filter = newsHistoryFilterSchema.parse(input);
    let query = this.db.selectFrom('news_items').selectAll();
    if (filter.before) query = query.where('sequence', '<', filter.before);
    const rows = await query.orderBy('sequence', 'desc').limit(filter.limit + 1).execute();
    const items = rows.slice(0, filter.limit).map(newsRecord);
    return { items, hasMore: rows.length > filter.limit, next: items.at(-1)?.sequence };
  }

  async newsDisplay(roomId: string): Promise<NewsItem | null> {
    const { news } = (await this.settings()).value;
    return news.enabled && news.roomId === roomId ? (await this.newsState()).current : null;
  }

  private async checkNewsCurrent(settingsVersion: number, stillCurrent: () => boolean) {
    const settings = await this.settings();
    if (!stillCurrent() || settings.version !== settingsVersion || !settings.value.news.enabled)
      throw new ActionError('stale', 'This news request is no longer current.');
    return settings.value.news;
  }

  async publishNews(input: NewsProposal, validatedSearchSources: string[], settingsVersion: number, stillCurrent: () => boolean, attemptId?: string) {
    const proposal = newsProposalSchema.parse(input);
    const sourceUrls = [...new Set(proposal.sourceUrls.map(canonicalNewsUrl))];
    const retrievedUrls = new Set(validatedSearchSources.map(canonicalNewsUrl));
    if (!sourceUrls.every(url => retrievedUrls.has(url))) throw new ActionError('world-validation', 'News attribution must use URLs returned by the completed web search.');
    const normalizedHeadline = proposal.headline.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    if (!normalizedHeadline) throw new ActionError('world-validation', 'A news headline must contain words or numbers.');
    const headlineKey = createHash('sha256').update(normalizedHeadline).digest('hex');
    return this.db.transaction().execute(async db => {
      const world = new World(db), news = await world.checkNewsCurrent(settingsVersion, stillCurrent);
      if (!news.topics.includes(proposal.category)) throw new ActionError('world-validation', 'News category must be one of the configured topics.');
      if (attemptId) {
        const record = await db.selectFrom('decisions').selectAll().where('id', '=', attemptId).executeTakeFirstOrThrow();
        if (record.ended_at) throw new ActionError('stale', 'This news attempt has already ended.');
      }
      if (await db.selectFrom('news_items').select('id').where('headline_key', '=', headlineKey).executeTakeFirst() ||
        await db.selectFrom('news_sources').select('canonical_url').where('canonical_url', 'in', sourceUrls).executeTakeFirst())
        throw new ActionError('world-validation', 'News selection repeats a known headline or source article; the current display was retained.');
      const retrievedAt = new Date().toISOString(), id = headlineKey;
      const row = await db.insertInto('news_items').values({ id, headline_key: headlineKey, headline: proposal.headline,
        description: proposal.description, category: proposal.category, published_at: proposal.publishedAt, retrieved_at: retrievedAt,
        source_urls: JSON.stringify(sourceUrls) }).returningAll().executeTakeFirstOrThrow();
      await db.insertInto('news_sources').values(sourceUrls.map(url => ({ canonical_url: url, news_item_id: id }))).execute();
      await db.updateTable('news_state').set({ current_item_id: id, last_attempt_at: retrievedAt, last_success_at: retrievedAt, error: null }).where('id', '=', 1).execute();
      const item = newsRecord(row);
      const content = `${item.headline}\n${item.description}\nCategory: ${item.category}\n${item.publishedAt ? `Published: ${item.publishedAt}\n` : ''}Retrieved: ${item.retrievedAt}\nSources: ${item.sourceUrls.join(' ')}`;
      const event = await this.insertMessage(db, news.roomId, 'world-news', 'News display', content, 'news');
      if (attemptId) await world.updateDiagnostic(attemptId, { news: item, eventIds: [event.id], sourceRoomId: news.roomId, destinationRoomId: news.roomId }, 'applied', 'news');
      await world.checkNewsCurrent(settingsVersion, stillCurrent);
      return { item, event, state: await world.newsState() };
    });
  }

  async recordNewsCheck(settingsVersion: number, stillCurrent: () => boolean, attemptId?: string): Promise<NewsState> {
    return this.db.transaction().execute(async db => {
      const world = new World(db);
      await world.checkNewsCurrent(settingsVersion, stillCurrent);
      if (attemptId) {
        const record = await db.selectFrom('decisions').selectAll().where('id', '=', attemptId).executeTakeFirstOrThrow();
        if (record.ended_at) throw new ActionError('stale', 'This news attempt has already ended.');
      }
      const now = new Date().toISOString();
      await db.updateTable('news_state').set({ last_attempt_at: now, last_success_at: now, error: null }).where('id', '=', 1).execute();
      if (attemptId) await world.updateDiagnostic(attemptId, { eventIds: [] }, 'applied-noop', 'news');
      await world.checkNewsCurrent(settingsVersion, stillCurrent);
      return world.newsState();
    });
  }

  async recordNewsFailure(error: string, settingsVersion: number, stillCurrent: () => boolean): Promise<NewsState> {
    return this.db.transaction().execute(async db => {
      const world = new World(db);
      await world.checkNewsCurrent(settingsVersion, stillCurrent);
      await db.updateTable('news_state').set({ last_attempt_at: new Date().toISOString(), error: error.slice(0, 1000) }).where('id', '=', 1).execute();
      await world.checkNewsCurrent(settingsVersion, stillCurrent);
      return world.newsState();
    });
  }

  private async latestRelationshipSummary(observerId: string, targetAgentId: string) {
    const row = await this.db.selectFrom('relationship_summaries').selectAll().where('observer_id', '=', observerId)
      .where('target_agent_id', '=', targetAgentId).orderBy('version', 'desc').limit(1).executeTakeFirst();
    return row ? summaryRecord(row) : null;
  }

  async relationshipPage(input: RelationshipFilter = {}): Promise<RelationshipPage> {
    const filter = relationshipFilterSchema.parse(input);
    let query = this.db.selectFrom('relationships').selectAll();
    if (filter.observerId) query = query.where('observer_id', '=', filter.observerId);
    if (filter.targetAgentId) query = query.where('target_agent_id', '=', filter.targetAgentId);
    if (filter.before) query = query.where('latest_appraisal_sequence', '<', filter.before);
    const rows = await query.orderBy('latest_appraisal_sequence', 'desc').limit(filter.limit + 1).execute();
    const relationships: RelationshipState[] = [];
    for (const row of rows.slice(0, filter.limit)) relationships.push({ observerId: row.observer_id, observerName: row.observer_name,
      targetAgentId: row.target_agent_id, targetName: row.target_name, score: row.score, updatedAt: row.updated_at,
      latestAppraisalSequence: row.latest_appraisal_sequence, summary: await this.latestRelationshipSummary(row.observer_id, row.target_agent_id) });
    return { relationships, hasMore: rows.length > filter.limit, next: relationships.at(-1)?.latestAppraisalSequence };
  }

  async appraisals(input: RelationshipFilter = {}): Promise<AppraisalPage> {
    const filter = relationshipFilterSchema.parse(input);
    let query = this.db.selectFrom('appraisals').selectAll();
    if (filter.observerId) query = query.where('observer_id', '=', filter.observerId);
    if (filter.targetAgentId) query = query.where('target_agent_id', '=', filter.targetAgentId);
    if (filter.before) query = query.where('sequence', '<', filter.before);
    const rows = await query.orderBy('sequence', 'desc').limit(filter.limit + 1).execute();
    const appraisals = rows.slice(0, filter.limit).map(appraisalRecord);
    return { appraisals, hasMore: rows.length > filter.limit, next: appraisals.at(-1)?.sequence };
  }

  async appraisal(id: string): Promise<AppraisalRecord | null> {
    const row = await this.db.selectFrom('appraisals').selectAll().where('id', '=', id).executeTakeFirst();
    return row ? appraisalRecord(row) : null;
  }

  async relationshipSummaries(observerId: string, targetAgentId: string, beforeVersion?: number, limit = 20): Promise<RelationshipSummaryPage> {
    const filter = relationshipFilterSchema.parse({ observerId, targetAgentId, before: beforeVersion, limit });
    let query = this.db.selectFrom('relationship_summaries').selectAll().where('observer_id', '=', observerId).where('target_agent_id', '=', targetAgentId);
    if (filter.before) query = query.where('version', '<', filter.before);
    const rows = await query.orderBy('version', 'desc').limit(filter.limit + 1).execute();
    const summaries = rows.slice(0, filter.limit).map(summaryRecord);
    return { summaries, hasMore: rows.length > filter.limit, next: summaries.at(-1)?.version };
  }

  async relevantRelationships(agentId: string): Promise<RelationshipContext[]> {
    const actor = await this.agent(agentId);
    if (!actor) return [];
    const localIds = (await this.db.selectFrom('agents').select('id').where('room_id', '=', actor.roomId).execute()).map(row => row.id);
    const memory = await this.memory(agentId), mentionedIds = memory.map(item => item.agentId), text = memory.map(item => item.content).join('\n').toLowerCase();
    const rows = await this.db.selectFrom('relationships').selectAll().where('observer_id', '=', agentId)
      .orderBy(sql<number>`case when target_agent_id in (${sql.join(localIds.length ? localIds : [''])}) then 0
        when target_agent_id in (${sql.join(mentionedIds.length ? mentionedIds : [''])}) or instr(${text}, lower(target_name)) > 0 then 1 else 2 end`)
      .orderBy('latest_appraisal_sequence', 'desc').limit(8).execute();
    const relationships: RelationshipContext[] = [];
    for (const row of rows) {
      const summary = await this.latestRelationshipSummary(agentId, row.target_agent_id);
      relationships.push({ targetAgentId: row.target_agent_id, targetName: row.target_name, score: row.score,
        summary: summary ? { id: summary.id, version: summary.version, summary: summary.summary, createdAt: summary.createdAt } : null });
    }
    return relationships;
  }

  async summaryCandidates(limit = 20, now = Date.now()): Promise<{ observerId: string; targetAgentId: string }[]> {
    limit = relationshipFilterSchema.parse({ limit }).limit;
    const interval = (await this.settings()).value.relationships.summaryIntervalMs;
    const result = await sql<{ observer_id: string; target_agent_id: string }>`
      with changed as (
        select r.observer_id, r.target_agent_id,
          coalesce((select max(s.created_at) from relationship_summaries s where s.observer_id = r.observer_id and s.target_agent_id = r.target_agent_id),
            (select min(a.created_at) from appraisals a where a.observer_id = r.observer_id and a.target_agent_id = r.target_agent_id)) as since
        from relationships r join agents observer on observer.id = r.observer_id and observer.enabled = 1
        where r.latest_appraisal_sequence > coalesce((select max(s.through_sequence) from relationship_summaries s where s.observer_id = r.observer_id and s.target_agent_id = r.target_agent_id), 0)
      ) select observer_id, target_agent_id from changed
        where since <= ${now === Infinity ? '9999-12-31T23:59:59.999Z' : new Date(now - interval).toISOString()}
        order by since, observer_id, target_agent_id limit ${limit}`.execute(this.db);
    return result.rows.map(row => ({ observerId: row.observer_id, targetAgentId: row.target_agent_id }));
  }

  async summaryInput(observerId: string, targetAgentId: string): Promise<RelationshipSummaryInput | null> {
    const relationship = await this.db.selectFrom('relationships').selectAll().where('observer_id', '=', observerId).where('target_agent_id', '=', targetAgentId).executeTakeFirst();
    if (!relationship) return null;
    const previous = await this.latestRelationshipSummary(observerId, targetAgentId);
    const limit = (await this.settings()).value.relationships.summaryBatchSize;
    const appraisals = (await this.db.selectFrom('appraisals').selectAll().where('observer_id', '=', observerId).where('target_agent_id', '=', targetAgentId)
      .where('sequence', '>', previous?.throughSequence ?? 0).orderBy('sequence', 'asc').limit(limit).execute()).map(appraisalRecord);
    if (!appraisals.length) return null;
    return { observerId, targetAgentId, targetName: relationship.target_name, score: relationship.score, previous, appraisals, throughSequence: appraisals.at(-1)!.sequence };
  }

  async saveRelationshipSummary(observerId: string, revision: number, input: RelationshipSummaryProposal, stillCurrent: () => boolean, attemptId?: string): Promise<RelationshipSummary> {
    const proposal = relationshipSummaryProposalSchema.parse(input);
    return this.db.transaction().execute(async db => {
      const world = new World(db), observer = await world.agent(observerId);
      const check = () => {
        if (!observer || !observer.enabled || observer.revision !== revision || !stillCurrent()) throw new ActionError('stale', 'This relationship summary is no longer current.');
      };
      check();
      if (attemptId) {
        const record = await db.selectFrom('decisions').selectAll().where('id', '=', attemptId).executeTakeFirstOrThrow();
        if (record.ended_at) throw new ActionError('stale', 'This attempt has already ended.');
      }
      const previous = await world.latestRelationshipSummary(observerId, proposal.targetAgentId);
      if ((previous?.version ?? 0) !== proposal.previousVersion) throw new ActionError('stale', 'This relationship summary has been superseded.');
      const limit = (await world.settings()).value.relationships.summaryBatchSize;
      const batch = await db.selectFrom('appraisals').selectAll().where('observer_id', '=', observerId).where('target_agent_id', '=', proposal.targetAgentId)
        .where('sequence', '>', previous?.throughSequence ?? 0).where('sequence', '<=', proposal.throughSequence).orderBy('sequence', 'asc').limit(limit + 1).execute();
      if (!batch.length || batch.length > limit || batch.at(-1)!.sequence !== proposal.throughSequence)
        throw new ActionError('world-validation', 'Relationship summary evidence must be the next bounded appraisal batch.');
      const allowedIds = new Set([...batch.map(item => item.id), ...previous?.appraisalIds ?? []]);
      if (new Set(proposal.appraisalIds).size !== proposal.appraisalIds.length || proposal.appraisalIds.some(id => !allowedIds.has(id)))
        throw new ActionError('world-validation', 'Relationship summary cites evidence outside its supplied appraisals.');
      const summary: RelationshipSummary = { id: randomUUID(), observerId, targetAgentId: proposal.targetAgentId, version: proposal.previousVersion + 1,
        summary: proposal.summary, createdAt: new Date().toISOString(), throughSequence: proposal.throughSequence, previousSummaryId: previous?.id ?? null, appraisalIds: proposal.appraisalIds };
      await db.insertInto('relationship_summaries').values({ id: summary.id, observer_id: observerId, target_agent_id: summary.targetAgentId,
        version: summary.version, summary: summary.summary, created_at: summary.createdAt, through_sequence: summary.throughSequence,
        previous_summary_id: summary.previousSummaryId, appraisal_ids: JSON.stringify(summary.appraisalIds) }).execute();
      if (attemptId) await world.updateDiagnostic(attemptId, { relationshipSummary: summary }, 'applied', 'relationship-summary');
      check();
      return summary;
    });
  }

  async resetRelationshipMemory() {
    return this.db.transaction().execute(async db => {
      const appraisals = await db.deleteFrom('appraisals').executeTakeFirstOrThrow();
      const relationships = await db.deleteFrom('relationships').executeTakeFirstOrThrow();
      const summaries = await db.deleteFrom('relationship_summaries').executeTakeFirstOrThrow();
      await db.updateTable('reflections').set({ reflected_at: null, reaction: null, intention: null,
        engagement_room_id: null, engagement_root_message_id: null, engagement_target_agent_id: null }).execute();
      return { appraisals: Number(appraisals.numDeletedRows), relationships: Number(relationships.numDeletedRows), summaries: Number(summaries.numDeletedRows) };
    });
  }

  private async validateAppraisals(observer: Agent, proposals: AppraisalProposal[], sourceIds?: readonly string[],
    optionalValidationErrors?: NonNullable<AttemptDetails['optionalValidationErrors']>) {
    const capacity = (await this.settings()).value.relationships.maxAppraisalsPerReflection;
    if (proposals.length > capacity) throw new ActionError('world-validation', 'This reflection exceeds its optional appraisal capacity.');
    const parsed = appraisalProposalSchema.array().parse(proposals);
    const validated: { proposal: AppraisalProposal; source: Selectable<DB['messages']> }[] = [];
    const witnessedIds = new Set(sourceIds ?? (await this.memory(observer.id)).map(item => item.id));
    for (const [index, proposal] of parsed.entries()) {
      const source = await this.db.selectFrom('messages').selectAll().where('id', '=', proposal.sourceId).executeTakeFirst();
      if (!source || !witnessedIds.has(source.id) || source.agent_id === observer.id || source.agent_id === 'config-ui' || !['speak', 'emote'].includes(source.type)) {
        const error = 'Appraisals require witnessed speech or authored emotes from another resident.';
        if (!optionalValidationErrors) throw new ActionError('world-validation', error);
        optionalValidationErrors.push({ field: 'appraisals', index, sourceId: proposal.sourceId, error });
        continue;
      }
      validated.push({ proposal, source });
    }
    return validated;
  }

  private async writeAppraisals(observer: Agent, appraisals: { proposal: AppraisalProposal; source: Selectable<DB['messages']> }[]) {
    const acceptedAppraisals: AppraisalRecord[] = [], duplicateAppraisalIds: string[] = [];
    for (const { proposal, source } of appraisals) {
      const duplicate = await this.db.selectFrom('appraisals').select('id').where('observer_id', '=', observer.id).where('source_id', '=', source.id).executeTakeFirst();
      if (duplicate) { duplicateAppraisalIds.push(duplicate.id); continue; }
      const previous = await this.db.selectFrom('relationships').select('score').where('observer_id', '=', observer.id).where('target_agent_id', '=', source.agent_id).executeTakeFirst();
      const score = Math.max(-10, Math.min(10, (previous?.score ?? 0) + (proposal.reaction === 'like' ? 1 : -1)));
      const createdAt = new Date().toISOString(), id = randomUUID();
      const row = await this.db.insertInto('appraisals').values({ id, observer_id: observer.id, observer_name: observer.name, target_agent_id: source.agent_id,
        target_name: source.speaker_name, source_id: source.id, source: JSON.stringify(messageRecord(source)), reaction: proposal.reaction,
        reason: proposal.reason, created_at: createdAt, score_after: score }).returningAll().executeTakeFirstOrThrow();
      const values = { observer_id: observer.id, observer_name: observer.name, target_agent_id: source.agent_id, target_name: source.speaker_name,
        score, updated_at: createdAt, latest_appraisal_sequence: row.sequence };
      await this.db.insertInto('relationships').values(values).onConflict(conflict => conflict.columns(['observer_id', 'target_agent_id']).doUpdateSet(values)).execute();
      acceptedAppraisals.push(appraisalRecord(row));
    }
    return { acceptedAppraisals, duplicateAppraisalIds };
  }

  async validateReply(agentId: string, replyToId: string, sourceIds?: readonly string[]): Promise<ConversationMessage> {
    const actor = await this.agent(agentId);
    const source = await this.db.selectFrom('messages').selectAll().where('id', '=', replyToId).executeTakeFirst();
    // INVARIANT: supplied source IDs come from the server-owned observation snapshot before the request.
    const witnessed = sourceIds ? sourceIds.includes(replyToId) : Boolean(await this.db.selectFrom('observations').select('sequence')
      .where('agent_id', '=', agentId).where('message_id', '=', replyToId).executeTakeFirst());
    const author = source ? await this.agent(source.agent_id) : undefined;
    if (!actor || !source || source.type !== 'speak' || !witnessed || source.room_id !== actor.roomId ||
      !author || !author.enabled || author.id === agentId || author.roomId !== actor.roomId)
      throw new ActionError('world-validation', 'A reply requires witnessed speech from another agent still in this room.');
    return { ...messageRecord(source), conversationId: source.conversation_id ?? source.id };
  }

  private async validateReflection(agentId: string, update: ReflectionUpdate, sourceIds?: readonly string[],
    optionalValidationErrors?: NonNullable<AttemptDetails['optionalValidationErrors']>) {
    for (const [key, limit] of [['reaction', 1000], ['intention', 240]] as const) {
      const value = update[key];
      if (value !== undefined && value !== null && (typeof value !== 'string' || value.length > limit))
        throw new ActionError('world-validation', `Private ${key} exceeds its allowed length.`);
    }
    if (optionalValidationErrors && update.engagement !== undefined && update.engagement !== null &&
      (typeof update.engagement !== 'object' || Array.isArray(update.engagement) ||
        Object.keys(update.engagement).some(key => !['roomId', 'rootMessageId', 'targetAgentId'].includes(key)) ||
        ['roomId', 'rootMessageId', 'targetAgentId'].some(key => typeof update.engagement![key as keyof NonNullable<ReflectionState['engagement']>] !== 'string' ||
          !update.engagement![key as keyof NonNullable<ReflectionState['engagement']>].length)))
      throw new ActionError('world-validation', 'Engagement requires room, root-message and target-agent IDs.');
    if (update.engagement) {
      const actor = await this.agent(agentId), target = await this.agent(update.engagement.targetAgentId);
      const sources = sourceIds ? await this.db.selectFrom('messages').selectAll().where('id', 'in', [...sourceIds]).execute().then(rows => rows.map(messageRecord)) : await this.memory(agentId);
      if (!(await this.settings()).value.scheduling.engagementEnabled || !actor || !target || !target.enabled || actor.id === target.id ||
        actor.roomId !== update.engagement.roomId || target.roomId !== actor.roomId ||
        !sources.some(source => source.type === 'speak' && source.roomId === actor.roomId && source.agentId === target.id &&
          (source.conversationId ?? source.id) === update.engagement!.rootMessageId)) {
        const error = 'Engagement requires a witnessed local exchange and a present interlocutor.';
        if (!optionalValidationErrors) throw new ActionError('world-validation', error);
        optionalValidationErrors.push({ field: 'engagement', sourceId: update.engagement.rootMessageId, error });
        return { ...update, engagement: undefined };
      }
    }
    return update;
  }

  private async writeReflection(agentId: string, update: ReflectionUpdate, publicAction?: { type: 'speak' | 'emote'; createdAt: string }) {
    const state = await this.reflection(agentId);
    if (update.reaction !== undefined || update.intention !== undefined) state.reflectedAt = new Date().toISOString();
    if (update.reaction !== undefined) state.reaction = update.reaction;
    if (update.intention !== undefined) state.intention = update.intention;
    if (update.engagement !== undefined) state.engagement = update.engagement;
    if (publicAction?.type === 'speak') state.lastSpeechAt = publicAction.createdAt;
    if (publicAction?.type === 'emote') state.lastEmoteAt = publicAction.createdAt;
    const values = { agent_id: agentId, reflected_at: state.reflectedAt, reaction: state.reaction, intention: state.intention,
      last_speech_at: state.lastSpeechAt, last_emote_at: state.lastEmoteAt, engagement_room_id: state.engagement?.roomId ?? null,
      engagement_root_message_id: state.engagement?.rootMessageId ?? null, engagement_target_agent_id: state.engagement?.targetAgentId ?? null };
    await this.db.insertInto('reflections').values(values).onConflict(conflict => conflict.column('agent_id').doUpdateSet(values)).execute();
    return state;
  }

  async saveReflection(agentId: string, revision: number, update: ReflectionUpdate, stillCurrent: () => boolean, attemptId?: string) {
    return this.db.transaction().execute(async db => {
      const world = new World(db), agent = await world.agent(agentId);
      const check = () => {
        if (!agent || !agent.enabled || agent.revision !== revision || !stillCurrent()) throw new ActionError('stale', 'This reflection is no longer current.');
      };
      check();
      if (attemptId) {
        const record = await db.selectFrom('decisions').selectAll().where('id', '=', attemptId).executeTakeFirstOrThrow();
        if (record.ended_at) throw new ActionError('stale', 'This attempt has already ended.');
      }
      const reflection = await world.writeReflection(agentId, await world.validateReflection(agentId, update));
      if (attemptId) await world.updateDiagnostic(attemptId, { reflection }, 'applied', 'reflect');
      check();
      return reflection;
    });
  }

  private async insertMessage(
    db: Kysely<DB>,
    roomId: string,
    agentId: string,
    speaker: string,
    content: string,
    type: ConversationMessage['type'] = 'speak',
    reply?: ConversationMessage,
  ) {
    if (
      !(await db
        .selectFrom('rooms')
        .select('id')
        .where('id', '=', roomId)
        .executeTakeFirst())
    )
      throw new Error('Room does not exist.');
    const last = await db
      .selectFrom('messages')
      .select('created_at')
      .orderBy('created_at', 'desc')
      .limit(1)
      .executeTakeFirst();
    const previousTime = last ? Date.parse(last.created_at) : 0;
    // INVARIANT: new timestamps advance so reconnect cursors cannot miss same-millisecond inserts.
    const createdAt = new Date(
      Math.max(
        Date.now(),
        Number.isFinite(previousTime) ? previousTime + 1 : 0,
      ),
    ).toISOString();
    const message: ConversationMessage = {
      id: randomUUID(),
      roomId,
      agentId,
      speaker,
      content,
      createdAt,
      type,
    };
    if (type === 'speak') message.conversationId = reply?.conversationId ?? reply?.id ?? message.id;
    if (reply) message.replyToId = reply.id;
    await db
      .insertInto('messages')
      .values({
        id: message.id,
        room_id: roomId,
        agent_id: agentId,
        speaker_name: speaker,
        content,
        created_at: createdAt,
        type,
        reply_to_id: message.replyToId ?? null,
        conversation_id: message.conversationId ?? null,
      })
      .execute();
    const observers = await db.selectFrom('agents').select(['id', 'context_message_limit']).where('room_id', '=', roomId).execute();
    for (const observer of observers) {
      await db.insertInto('observations').values({ agent_id: observer.id, message_id: message.id }).execute();
      await new World(db).trimMemory(observer.id, observer.context_message_limit);
    }
    return message;
  }

  async speak(roomId: string, content: string) {
    return this.db
      .transaction()
      .execute((db) =>
        this.insertMessage(db, roomId, 'config-ui', 'Human', content),
      );
  }

  async clearHistory(input: ClearHistoryInput): Promise<HistoryCleared> {
    const selection = clearHistorySchema.parse(input);
    return this.db.transaction().execute(async (db) => {
      let rooms = db.selectFrom('rooms').select('id');
      if (selection.scope === 'room')
        rooms = rooms.where('id', '=', selection.roomId);
      const roomIds = (await rooms.execute()).map((room) => room.id);
      if (selection.scope === 'room' && !roomIds.length)
        throw new Error('Room does not exist.');
      let observedMessages = db.selectFrom('messages').select('id');
      if (selection.scope === 'room') observedMessages = observedMessages.where('room_id', '=', selection.roomId);
      await db.deleteFrom('observations').where('message_id', 'in', observedMessages).execute();
      await db.updateTable('reflections').set({ engagement_room_id: null, engagement_root_message_id: null, engagement_target_agent_id: null })
        .where('engagement_room_id', 'in', roomIds).execute();
      let query = db.deleteFrom('messages');
      if (selection.scope === 'room')
        query = query.where('room_id', '=', selection.roomId);
      const result = await query.executeTakeFirstOrThrow();
      return { roomIds, deletedMessages: Number(result.numDeletedRows) };
    });
  }

  async history(input: HistoryInput, limit = 100): Promise<HistoryPage> {
    if (
      !(await this.db
        .selectFrom('rooms')
        .select('id')
        .where('id', '=', input.roomId)
        .executeTakeFirst())
    )
      throw new Error('Room does not exist.');
    let query = this.db
      .selectFrom('messages')
      .selectAll()
      .where('room_id', '=', input.roomId);
    const cursor = input.before ?? input.after;
    if (cursor) {
      const operator = input.after ? '>' : '<';
      query = query.where((eb) =>
        eb.or([
          eb('created_at', operator, cursor.createdAt),
          eb.and([
            eb('created_at', '=', cursor.createdAt),
            eb('id', operator, cursor.id),
          ]),
        ]),
      );
    }
    const direction = input.after ? 'asc' : 'desc';
    const rows = await query
      .orderBy('created_at', direction)
      .orderBy('id', direction)
      .limit(limit + 1)
      .execute();
    const messages = rows.slice(0, limit).map(messageRecord);
    return {
      messages: input.after ? messages : messages.reverse(),
      hasMore: rows.length > limit,
    };
  }

  async applyAction(
    agentId: string,
    revision: number,
    action: AgentAction,
    stillCurrent: () => boolean,
    attemptId?: string,
    decision?: DecisionUpdate,
  ) {
    action = actionSchema.parse(action);
    await this.syncEnergy();
    return this.db.transaction().execute(async (db) => {
      const row = await db
        .selectFrom('agents')
        .selectAll()
        .where('id', '=', agentId)
        .executeTakeFirst();
      if (!row) throw new ActionError('stale', 'This agent has been deleted.');
      const check = () => {
        if (!stillCurrent() || !row.enabled || row.revision !== revision)
          throw new ActionError('stale', 'This turn is no longer current.');
      };
      check();
      const world = new World(db);
      const settings = (await world.settings()).value;
      if (action.type === 'emote' && !settings.activity.emotesEnabled)
        throw new ActionError('world-validation', 'Emotes are disabled; use wait for a quiet turn.');
      if (decision?.engagementGuard) {
        const guard = decision.engagementGuard, saved = (await world.reflection(agentId)).engagement;
        const partner = await world.agent(guard.targetAgentId);
        if (!settings.scheduling.engagementEnabled || !saved || saved.roomId !== guard.roomId || saved.rootMessageId !== guard.rootMessageId ||
          saved.targetAgentId !== guard.targetAgentId || row.room_id !== guard.roomId || !partner || !partner.enabled ||
          partner.id === agentId || partner.roomId !== row.room_id)
          throw new ActionError('stale', 'This conversation engagement is no longer current.');
        const source = await world.validateReply(agentId, guard.replyToId, decision.sourceIds).catch(error => {
          if (error instanceof ActionError) throw new ActionError('stale', 'The triggering conversation contribution is no longer current.');
          throw error;
        });
        if (source.conversationId !== guard.rootMessageId || source.agentId !== guard.sourceAgentId)
          throw new ActionError('stale', 'The triggering contribution does not belong to this conversation engagement.');
      }
      if (decision?.targetAgentId) {
        const target = await world.agent(decision.targetAgentId);
        if (!target || !target.enabled || target.id === agentId || target.roomId !== row.room_id)
          throw new ActionError('stale', 'The intended interlocutor is no longer in this room.');
      }
      const reply = action.type === 'speak' && action.replyToId ? await world.validateReply(agentId, action.replyToId, decision?.sourceIds) : undefined;
      const optionalValidationErrors: NonNullable<AttemptDetails['optionalValidationErrors']> = [];
      const optionalRejects = action.type === 'move' ? optionalValidationErrors : undefined;
      const validatedAppraisals = decision?.appraisals !== undefined ? await world.validateAppraisals(agentRecord(row), decision.appraisals, decision.sourceIds, optionalRejects) : [];
      const reflectionUpdate = decision?.reflection || decision?.engagement !== undefined ? await world.validateReflection(agentId, {
        ...decision.reflection, ...(decision.engagement !== undefined ? { engagement: decision.engagement } : {}),
      }, decision.sourceIds, optionalRejects) : undefined;
      const appraisals = await world.writeAppraisals(agentRecord(row), validatedAppraisals);
      if (reflectionUpdate && (reflectionUpdate.reaction !== undefined || reflectionUpdate.intention !== undefined || reflectionUpdate.engagement !== undefined))
        await world.writeReflection(agentId, reflectionUpdate);
      let message: ConversationMessage | undefined;
      const events: ConversationMessage[] = [];
      if (action.type === 'propose-media') events.push(...await world.proposeMedia(agentRecord(row), action));
      if (action.type === 'speak' || action.type === 'emote')
        message = await this.insertMessage(
          db,
          row.room_id,
          row.id,
          row.name,
          action.message,
          action.type,
          reply,
        );
      if (action.type === 'move') {
        const destination = await db
          .selectFrom('rooms')
          .selectAll()
          .where('id', '=', action.roomId)
          .executeTakeFirst();
        if (!destination)
          throw new ActionError('world-validation', 'Destination room does not exist.');
        const observableMove = action.roomId !== row.room_id && settings.activity.roomEventsEnabled;
        if (observableMove) {
          const origin = await db.selectFrom('rooms').selectAll().where('id', '=', row.room_id).executeTakeFirstOrThrow();
          events.push(await this.insertMessage(db, row.room_id, row.id, row.name, `${row.name} leaves ${origin.name}.`, 'departure'));
        }
        await db
          .updateTable('agents')
          .set({ room_id: action.roomId, revision: row.revision + 1 })
          .where('id', '=', row.id)
          .execute();
        if (action.roomId !== row.room_id) await world.clearEngagements(row.id);
        if (observableMove)
          events.push(await this.insertMessage(db, action.roomId, row.id, row.name, `${row.name} enters ${destination.name}.`, 'arrival'));
        if (action.roomId !== row.room_id) events.push(...await world.advanceMedia(Date.now()));
      }
      let energyAfter = row.energy;
      if (action.type === 'eat') {
        const energy = (await new World(db).settings()).value.energy;
        const room = await db.selectFrom('rooms').selectAll().where('id', '=', row.room_id).executeTakeFirst();
        if (!energy.enabled) throw new ActionError('world-validation', 'Energy is disabled; eating is unavailable.');
        if (!room?.is_food_source) throw new ActionError('world-validation', 'Eating requires a food-source room.');
        if (!canEat(energy, row.energy, Boolean(room.is_food_source))) throw new ActionError('world-validation',
          row.energy >= energy.maximum ? 'Energy is already at maximum; eating is unavailable.' : 'Eating requires energy at or below the configured low-energy threshold.');
        energyAfter = energy.maximum;
        await db.updateTable('agents').set({ energy: energyAfter }).where('id', '=', row.id).execute();
      }
      const moved = action.type === 'move' && action.roomId !== row.room_id;
      const reflection = message ? await world.writeReflection(agentId, {}, { type: action.type as 'speak' | 'emote', createdAt: message.createdAt }) : await world.reflection(agentId);
      if (attemptId) {
        const record = await db.selectFrom('decisions').selectAll().where('id', '=', attemptId).executeTakeFirstOrThrow();
        if (record.ended_at) throw new ActionError('stale', 'This attempt has already ended.');
        const details: AttemptDetails = JSON.parse(record.details);
        await new World(db).updateDiagnostic(attemptId, {
          sourceRoomId: row.room_id, destinationRoomId: action.type === 'move' ? action.roomId : row.room_id,
          moved, ...(message ? { messageId: message.id } : {}), eventIds: events.map(event => event.id), energyBefore: row.energy, energyAfter,
          passiveDecay: Math.max(0, (details.energySeen ?? row.energy) - row.energy),
          reflection,
          ...appraisals,
          ...(optionalValidationErrors.length ? { optionalValidationErrors } : {}),
          ...(action.type === 'move' && action.reason ? { moveReason: action.reason } : {}),
          ...(action.type === 'propose-media' ? { media: await world.mediaState() } : {}),
        }, action.type === 'move' && !moved ? 'applied-noop' : 'applied', action.type);
      }
      check();
      return { message, events, moved, energyBefore: row.energy, energyAfter, reflection, ...appraisals, optionalValidationErrors };
    });
  }

  async diagnosticUsage(): Promise<DiagnosticUsage> {
    const totals = await this.db.selectFrom('decisions').select(({ fn }) => [
      fn.sum<number>('bytes').as('bytes'), fn.sum<number>('reserved_bytes').as('reserved'),
    ]).executeTakeFirstOrThrow();
    const policy = (await this.settings()).value.diagnostics;
    const protectedUsage = await sql<{ bytes: number }>`select coalesce(sum(bytes), 0) as bytes from decisions
      where turn_id in (select turn_id from decisions where ended_at is null or execution_pending <> 0)`.execute(this.db);
    const state = await this.db.selectFrom('diagnostic_retention').select('generation').where('id', '=', 1).executeTakeFirstOrThrow();
    return { bytes: Number(totals.bytes ?? 0), reservedBytes: Number(totals.reserved ?? 0),
      limitBytes: policy.maxPayloadMiB * 1024 * 1024, retention: policy.retention, maxAgeMinutes: policy.maxAgeMinutes,
      protectedBytes: Number(protectedUsage.rows[0].bytes), pruneGeneration: state.generation };
  }

  private async pruneDiagnosticBatch(now: number): Promise<DiagnosticPruneResult> {
    const policy = (await this.settings()).value.diagnostics;
    const result = { deletedTurns: 0, deletedRecords: 0, freedBytes: 0, hasMore: false };
    if (policy.retention === 'manual') return result;
    const usage = await this.db.selectFrom('decisions').select(({ fn }) => fn.sum<number>('bytes').as('bytes')).executeTakeFirstOrThrow();
    let bytes = Number(usage.bytes ?? 0);
    const limit = policy.maxPayloadMiB * 1024 * 1024;
    if (policy.retention === 'rolling-size' && bytes <= limit) return result;
    const cutoff = new Date(now - policy.maxAgeMinutes * 60000).toISOString();
    // INVARIANT: a terminal attempt remains protected until its underlying handler settles.
    const groups = await sql<{ turn_id: string; bytes: number; records: number }>`select turn_id, sum(bytes) as bytes, count(*) as records
      from decisions group by turn_id
      having sum(case when attempt = 0 then 1 else 0 end) > 0
        and sum(case when ended_at is null or execution_pending <> 0 then 1 else 0 end) = 0
        ${policy.retention === 'rolling-time' ? sql`and max(ended_at) <= ${cutoff}` : sql``}
      order by max(ended_at), min(sequence) limit 101`.execute(this.db);
    for (const group of groups.rows.slice(0, 100)) {
      if (policy.retention === 'rolling-size' && bytes <= limit) break;
      await this.db.deleteFrom('decisions').where('turn_id', '=', group.turn_id).execute();
      result.deletedTurns++; result.deletedRecords += Number(group.records); result.freedBytes += Number(group.bytes);
      bytes -= Number(group.bytes);
    }
    result.hasMore = groups.rows.length > 100 && (policy.retention === 'rolling-time' || bytes > limit);
    if (result.deletedTurns) await this.db.updateTable('diagnostic_retention').set(eb => ({ generation: eb.eb('generation', '+', 1) })).where('id', '=', 1).execute();
    return result;
  }

  async pruneDiagnostics(now = Date.now()): Promise<DiagnosticPruneResult> {
    try { return await this.db.transaction().execute(db => new World(db).pruneDiagnosticBatch(now)); }
    catch (error) { throw new DiagnosticError(`Diagnostic retention could not be saved: ${error instanceof Error ? error.message : 'write failed'}`); }
  }

  async scheduleTurn(agent: Agent, dueAt: number, operation = 'action', requestedAt = Date.now()) {
    try {
      return await this.db.transaction().execute(async db => {
        const world = new World(db);
        await world.pruneDiagnosticBatch(Date.now());
        const id = randomUUID();
        const usage = await world.diagnosticUsage();
        if (usage.retention === 'manual' && usage.bytes + usage.reservedBytes + 4096 > usage.limitBytes) throw new Error('Diagnostic capacity reached. Export/clear diagnostics or increase the budget while stopped.');
        await db.insertInto('decisions').values({
          id, turn_id: id, agent_id: agent.id, agent_name: agent.name, room_id: agent.roomId,
          scheduled_at: new Date().toISOString(), due_at: new Date(dueAt).toISOString(), started_at: null, ended_at: null,
          attempt: 0, model: agent.model, action: null, outcome: 'scheduled', details: '{}', bytes: 1024, reserved_bytes: 0,
          operation, requested_at: new Date(requestedAt).toISOString(),
        }).execute();
        return id;
      });
    } catch (error) { throw new DiagnosticError(`Diagnostics could not schedule a turn: ${error instanceof Error ? error.message : 'write failed'}`); }
  }

  async startAttempt(turnId: string, number: number, agent: Agent) {
    try {
      return await this.db.transaction().execute(async db => {
        const world = new World(db);
        await world.pruneDiagnosticBatch(Date.now());
        const usage = await world.diagnosticUsage();
        const reserved = usage.retention === 'manual' ? 8 * 1024 * 1024 : 0;
        if (usage.retention === 'manual' && usage.bytes + usage.reservedBytes + reserved > usage.limitBytes)
          throw new Error('Diagnostic capacity reached. Export/clear diagnostics or increase the budget while stopped.');
        const turn = await db.selectFrom('decisions').selectAll().where('id', '=', turnId).executeTakeFirstOrThrow();
        const id = randomUUID(), started = new Date().toISOString();
        await db.insertInto('decisions').values({ ...turn, sequence: undefined, id, room_id: agent.roomId,
          started_at: started, ended_at: null, attempt: number, outcome: 'running', reserved_bytes: reserved, execution_pending: 1 }).execute();
        await db.updateTable('decisions').set({ started_at: turn.started_at ?? started, outcome: 'running' }).where('id', '=', turnId).execute();
        return id;
      });
    } catch (error) { throw new DiagnosticError(`Diagnostics could not start an attempt: ${error instanceof Error ? error.message : 'write failed'}`); }
  }

  async updateDiagnostic(id: string, additions: AttemptDetails, outcome?: string, action?: string) {
    try {
      const row = await this.db.selectFrom('decisions').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
      // INVARIANT: late completion cannot replace a terminal cancellation or an applied action.
      if (row.ended_at && !(row.outcome.startsWith('applied') && outcome === 'applied-notification-failure')) return;
      const details = JSON.stringify({ ...JSON.parse(row.details), ...additions });
      const bytes = Buffer.byteLength(details) + 1024;
      if ((await this.settings()).value.diagnostics.retention === 'manual' && row.reserved_bytes && bytes > row.reserved_bytes)
        throw new Error('Attempt exceeded its reserved diagnostic capacity; request was not submitted/applied.');
      await this.db.updateTable('decisions').set({ details, bytes,
        ...(action ? { action } : {}),
        ...(outcome ? { outcome, ended_at: new Date().toISOString(), reserved_bytes: 0 } : {}),
      }).where('id', '=', id).where('outcome', '=', row.outcome)
        .where('ended_at', row.ended_at === null ? 'is' : '=', row.ended_at).execute();
    } catch (error) { throw new DiagnosticError(`Diagnostics could not be saved: ${error instanceof Error ? error.message : 'write failed'}`); }
  }

  async endTurn(turnId: string, outcome: string) {
    try {
      await this.db.updateTable('decisions').set({ outcome, ended_at: new Date().toISOString() })
        .where('id', '=', turnId).where('ended_at', 'is', null).execute();
      await this.pruneDiagnostics();
    } catch { throw new DiagnosticError('Diagnostics could not finish the turn.'); }
  }

  async settleAttempt(id: string) {
    try {
      await this.db.updateTable('decisions').set({ execution_pending: 0 }).where('id', '=', id).execute();
      await this.pruneDiagnostics();
    } catch (error) { throw new DiagnosticError(`Diagnostics could not settle an attempt: ${error instanceof Error ? error.message : 'write failed'}`); }
  }

  async interruptUnfinished() {
    await this.db.updateTable('decisions').set({ outcome: 'interrupted', ended_at: new Date().toISOString(), reserved_bytes: 0 })
      .where('ended_at', 'is', null).execute();
    await this.db.updateTable('decisions').set({ execution_pending: 0 }).where('execution_pending', '<>', 0).execute();
    await this.clearEngagements();
    await this.db.updateTable('media_state').set({ clock_at: null }).where('id', '=', 1).execute();
    await this.cancelMediaBallots('The server restarted before the vote concluded.');
  }

  async diagnostics(input: DiagnosticFilter = {}, details = false): Promise<DiagnosticPage> {
    const filter = diagnosticFilterSchema.parse(input);
    let query = this.db.selectFrom('decisions');
    if (filter.agentId) query = query.where('agent_id', '=', filter.agentId);
    if (filter.roomId) query = query.where('room_id', '=', filter.roomId);
    if (filter.action) query = query.where('action', '=', filter.action);
    if (filter.outcome) query = query.where('outcome', '=', filter.outcome);
    if (filter.from) query = query.where('scheduled_at', '>=', filter.from);
    if (filter.to) query = query.where('scheduled_at', '<=', filter.to);
    if (filter.before) query = query.where('sequence', '<', filter.before);
    const rows = await query.select(details ? [
      'sequence', 'id', 'turn_id', 'agent_id', 'agent_name', 'room_id', 'scheduled_at', 'due_at', 'started_at', 'ended_at', 'attempt', 'model', 'action', 'outcome', 'details', 'operation', 'requested_at',
    ] : ['sequence', 'id', 'turn_id', 'agent_id', 'agent_name', 'room_id', 'scheduled_at', 'due_at', 'started_at', 'ended_at', 'attempt', 'model', 'action', 'outcome', 'operation', 'requested_at'])
      .orderBy('sequence', 'desc').limit(filter.limit + 1).execute();
    const records = rows.slice(0, filter.limit).map(row => this.diagnosticRecord(row));
    return { records, hasMore: rows.length > filter.limit, next: records.at(-1)?.sequence };
  }

  private diagnosticRecord(row: Omit<Selectable<DB['decisions']>, 'bytes' | 'reserved_bytes' | 'details' | 'execution_pending'> & { details?: string }): DiagnosticRecord {
    return { sequence: row.sequence, id: row.id, turnId: row.turn_id, agentId: row.agent_id, agentName: row.agent_name,
      roomId: row.room_id, scheduledAt: row.scheduled_at, dueAt: row.due_at, startedAt: row.started_at, endedAt: row.ended_at,
      attempt: row.attempt, model: row.model, action: row.action, outcome: row.outcome,
      operation: row.operation, ...(row.requested_at ? { requestedAt: row.requested_at } : {}),
      ...(row.details ? { details: JSON.parse(row.details) } : {}) };
  }

  async diagnostic(id: string) {
    const row = await this.db.selectFrom('decisions').selectAll().where('id', '=', id).executeTakeFirst();
    if (!row) throw new Error('Diagnostics: this record is no longer retained. Refresh the list.');
    return this.diagnosticRecord(row);
  }

  async clearDiagnostics() {
    return this.db.transaction().execute(async db => {
      const result = await db.deleteFrom('decisions').executeTakeFirstOrThrow();
      await db.updateTable('diagnostic_retention').set(eb => ({ generation: eb.eb('generation', '+', 1) })).where('id', '=', 1).execute();
      return Number(result.numDeletedRows);
    });
  }
}
