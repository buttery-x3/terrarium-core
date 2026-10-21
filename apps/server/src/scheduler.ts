import { setTimeout as delay } from 'node:timers/promises';
import { resolveScheduling, type Agent, type AgentActivity, type ConversationMessage, type DecisionOpportunity, type RunState, type Settings } from '@terrarium/shared';
import { ActionError, DiagnosticError, type World } from '@terrarium/persistence';
import { TurnError } from './turns.js';
import type { DecisionResult } from './reflection.js';

type TurnHandler = (agent: Agent, signal: AbortSignal, stillCurrent: () => boolean,
  onApplied: () => void, attemptId?: string, opportunity?: DecisionOpportunity) => Promise<DecisionResult | void>;
type SummaryHandler = (agent: Agent, targetAgentId: string, signal: AbortSignal, stillCurrent: () => boolean,
  onApplied: () => void, attemptId?: string) => Promise<void>;
type NewsHandler = (signal: AbortSignal, stillCurrent: () => boolean, onApplied: () => void, dueAt: number, requestedAt: number) => Promise<void>;
export type MediaHandlers = {
  vote: (agent: Agent, ballotId: string, signal: AbortSignal, stillCurrent: () => boolean, onApplied: () => void, attemptId?: string) => Promise<void>;
  changed: (events: ConversationMessage[]) => Promise<void>;
};
type ActiveTurn = { controller: AbortController; revision: number; epoch: number; turnId: string; opportunity: DecisionOpportunity;
  summaryTargetId?: string; ballotId?: string; applied?: boolean };
type ActiveNews = { controller: AbortController; epoch: number; dueAt: number; requestedAt: number };
type SummaryJob = { observerId: string; targetAgentId: string; dueAt: number; requestedAt: number; intervalMs: number };
const newsFlightKey = Symbol('system-news');
type Schedule = {
  revision: number; reflectionAt: number; emoteAt: number; emoteCheckedAt: number;
  speechPlan?: NonNullable<DecisionOpportunity['speechPlan']>; engagementAt?: number;
  engagementTrigger?: DecisionOpportunity['engagementTrigger'];
  engagement?: { roomId: string; rootMessageId: string; targetAgentId: string } | null;
  lastDecisionAt: number; lastSpeechAt: number; timing: Settings['scheduling'];
};

export class Scheduler {
  private state: RunState['state'] = 'stopped';
  private epoch = 0;
  private active = new Map<string, ActiveTurn>();
  private activity = new Map<string, AgentActivity>();
  private schedules = new Map<string, Schedule>();
  private summaries = new Map<string, SummaryJob>();
  private votes = new Map<string, { voterId: string; ballotId: string; requestedAt: number }>();
  private flights = new Map<string | symbol, Promise<unknown>>();
  private newsActive?: ActiveNews;
  private newsDueAt?: number;
  private newsRequestedAt?: number;
  private newsIntervalMs = 600000;
  private newsEnabled = false;
  private newsError?: string;
  private ticking = false;
  private timer?: ReturnType<typeof setInterval>;
  private retentionTimer?: ReturnType<typeof setInterval>;
  private retentionContinuation?: ReturnType<typeof setTimeout>;
  private retentionWork?: Promise<void>;
  private error?: string;
  private pausedAt?: number;
  private pending = new Set<Promise<void>>();

  constructor(private world: World, private handler: TurnHandler, private publish: (state: RunState) => void,
    private options = { concurrency: 4, timeoutMs: 60000, retries: 2, backoffMs: 1000 },
    private summaryHandler?: SummaryHandler,
    private newsHandler?: NewsHandler,
    private media?: MediaHandlers) {}

  snapshot(): RunState {
    return { state: this.state, agents: [...this.activity.values()].map(activity => {
      const schedule = this.schedules.get(activity.agentId);
      return { ...activity, ...(schedule ? {
        nextReflectionAt: schedule.reflectionAt,
        nextSpeechAt: schedule.engagementAt === undefined ? schedule.speechPlan?.dueAt : Math.min(schedule.speechPlan?.dueAt ?? Infinity, schedule.engagementAt),
        nextEmoteAt: Number.isFinite(schedule.emoteAt) ? schedule.emoteAt : undefined,
        nextRelationshipSummaryAt: this.nextSummary(activity.agentId)?.dueAt,
        nextVoteAt: this.votes.get(activity.agentId)?.requestedAt,
      } : {}) };
    }), concurrency: this.options.concurrency, ...(this.error ? { error: this.error } : {}),
      ...(this.newsDueAt !== undefined ? { nextNewsAt: this.newsDueAt } : {}), ...(this.newsError ? { newsError: this.newsError } : {}) };
  }
  private emit() { this.publish(this.snapshot()); }
  private now() { return this.pausedAt ?? Date.now(); }
  private emoteDelay(timing: Settings['scheduling']) {
    return timing.emoteMinIntervalMs + Math.random() * (timing.emoteMaxIntervalMs - timing.emoteMinIntervalMs);
  }
  private due(schedule: Schedule) {
    return Math.min(schedule.reflectionAt, schedule.emoteAt, schedule.speechPlan?.dueAt ?? Infinity, schedule.engagementAt ?? Infinity);
  }
  private occupiedSlots() {
    return new Set([...this.active.keys(), ...this.flights.keys(), ...(this.newsActive ? [newsFlightKey] : [])]).size;
  }
  private nextSummary(observerId: string) {
    return [...this.summaries.values()].filter(job => job.observerId === observerId).sort((a, b) => a.dueAt - b.dueAt)[0];
  }
  private async discoverSummaries() {
    if (!this.summaryHandler) return;
    const [candidates, settings] = await Promise.all([this.world.summaryCandidates(20, Infinity), this.world.settings()]);
    if (this.state === 'stopped') return;
    for (const candidate of candidates) {
      const key = JSON.stringify([candidate.observerId, candidate.targetAgentId]);
      if (this.summaries.has(key) || !this.schedules.has(candidate.observerId)) continue;
      if (this.summaries.size >= 20) break;
      this.summaries.set(key, { ...candidate, dueAt: this.now() + settings.value.relationships.summaryIntervalMs,
        requestedAt: Date.now(), intervalMs: settings.value.relationships.summaryIntervalMs });
      this.refreshActivity(candidate.observerId);
    }
  }
  private async advanceMedia(now = Date.now(), running?: boolean) {
    const events = await this.world.syncMedia(now, running);
    if (events.length) await this.media?.changed(events);
  }
  private async discoverVotes() {
    if (!this.media) return;
    const candidates = await this.world.voteCandidates(20);
    if (this.state === 'stopped') return;
    this.votes = new Map(candidates.filter(candidate => this.schedules.has(candidate.voterId)).map(candidate => [candidate.voterId, candidate]));
    for (const [id, active] of this.active) if (active.ballotId && !active.applied && this.votes.get(id)?.ballotId !== active.ballotId &&
      !await this.world.voteInput(id, active.ballotId)) active.controller.abort();
    for (const id of this.schedules.keys()) this.refreshActivity(id, this.activity.get(id)?.error);
  }
  private refreshActivity(id: string, error?: string) {
    const schedule = this.schedules.get(id);
    if (!schedule || this.active.has(id)) return;
    this.activity.set(id, { agentId: id, state: error ? 'error' : 'scheduled',
      dueAt: Math.min(this.due(schedule), this.nextSummary(id)?.dueAt ?? Infinity, this.votes.get(id)?.requestedAt ?? Infinity), ...(error ? { error } : {}) });
  }
  watch() {
    this.timer ??= setInterval(() => { void this.tick(); }, 500);
    this.retentionTimer ??= setInterval(() => { void this.maintainDiagnostics().catch(() => {}); }, 30000);
    void this.maintainDiagnostics().catch(() => {});
  }
  async maintainDiagnostics() {
    if (this.retentionWork) return this.retentionWork;
    this.retentionWork = this.world.pruneDiagnostics().then(result => {
      if (result.deletedRecords) this.emit();
      if (result.hasMore && this.retentionTimer && !this.retentionContinuation) this.retentionContinuation = setTimeout(() => {
        this.retentionContinuation = undefined; void this.maintainDiagnostics().catch(() => {});
      }, 100);
    })
      .catch(error => { this.fail(error); throw error; }).finally(() => { this.retentionWork = undefined; });
    return this.retentionWork;
  }
  async close() {
    if (this.timer) clearInterval(this.timer);
    if (this.retentionTimer) clearInterval(this.retentionTimer);
    if (this.retentionContinuation) clearTimeout(this.retentionContinuation);
    this.retentionContinuation = undefined;
    this.timer = undefined; this.retentionTimer = undefined;
    await this.retentionWork?.catch(() => {});
    await this.stop();
  }

  async start() {
    if (this.state === 'running') return;
    const epoch = this.epoch;
    await this.world.validateSettings((await this.world.settings()).value);
    if (this.epoch !== epoch || this.snapshot().state === 'running') return;
    if (this.pausedAt !== undefined) {
      const elapsed = Date.now() - this.pausedAt;
      for (const schedule of this.schedules.values()) {
        schedule.reflectionAt += elapsed; schedule.emoteAt += elapsed; schedule.emoteCheckedAt += elapsed;
        schedule.lastDecisionAt += elapsed; schedule.lastSpeechAt += elapsed;
        if (schedule.engagementAt !== undefined) schedule.engagementAt += elapsed;
        if (schedule.speechPlan) schedule.speechPlan.dueAt += elapsed;
      }
      for (const job of this.summaries.values()) job.dueAt += elapsed;
      if (this.newsDueAt !== undefined) this.newsDueAt += elapsed;
    }
    this.pausedAt = undefined; this.error = undefined; this.state = 'running';
    await this.world.syncEnergy(Date.now(), true);
    await this.advanceMedia(Date.now(), true);
    try { await this.changed(); } catch (error) { this.fail(error); throw error; }
    this.emit();
  }
  pause() {
    if (this.state !== 'running') return;
    this.pausedAt = Date.now(); this.state = 'paused';
    void this.world.syncEnergy(Date.now(), false).catch(error => this.fail(error));
    void this.advanceMedia(Date.now(), false).catch(error => this.fail(error));
    this.emit();
  }
  async stop() {
    this.state = 'stopped'; this.pausedAt = undefined; this.epoch += 1; this.error = undefined;
    for (const active of this.active.values()) active.controller.abort();
    this.newsActive?.controller.abort(); this.newsDueAt = undefined; this.newsRequestedAt = undefined; this.newsError = undefined;
    this.schedules.clear(); this.summaries.clear(); this.votes.clear(); this.activity.clear(); this.emit();
    await Promise.allSettled([this.world.syncEnergy(Date.now(), false).catch(error => this.fail(error)),
      this.advanceMedia(Date.now(), false).catch(error => this.fail(error)), ...this.pending]);
    const mediaEvents = await this.world.cancelMediaBallots('stopped');
    if (mediaEvents.length) await this.media?.changed(mediaEvents);
    await this.world.clearEngagements();
  }
  hasActiveWork() { return this.active.size > 0 || Boolean(this.newsActive) || this.pending.size > 0 || this.flights.size > 0; }

  async changed() {
    try {
      const [agents, settings, reflections] = await Promise.all([this.world.agents(), this.world.settings(), this.world.reflections()]);
      this.newsEnabled = Boolean(this.newsHandler && settings.value.news.enabled);
      this.newsIntervalMs = settings.value.news.intervalMs;
      if (!this.newsEnabled) {
        this.newsActive?.controller.abort(); this.newsDueAt = undefined; this.newsError = undefined;
      } else if (this.state !== 'stopped' && this.newsDueAt === undefined && !this.newsActive) {
        const epoch = this.epoch, display = await this.world.newsDisplay(settings.value.news.roomId);
        if (this.epoch === epoch && this.snapshot().state !== 'stopped') {
          this.newsDueAt = this.now() + (display ? this.newsIntervalMs : 0); this.newsRequestedAt = Date.now();
        }
      }
      const enabled = new Map(agents.filter(agent => agent.enabled).map(agent => [agent.id, agent]));
      for (const [id, active] of this.active) if (enabled.get(id)?.revision !== active.revision) active.controller.abort();
      for (const id of this.schedules.keys()) if (!enabled.has(id)) { this.schedules.delete(id); this.activity.delete(id); }
      for (const [key, job] of this.summaries) if (!enabled.has(job.observerId)) this.summaries.delete(key);
      if (this.state !== 'stopped') for (const agent of enabled.values()) {
        let schedule = this.schedules.get(agent.id);
        if (!schedule || schedule.revision !== agent.revision) {
          const timing = resolveScheduling(settings.value, agent), now = this.now();
          const reflection = reflections.find(item => item.agentId === agent.id);
          schedule = { revision: agent.revision, reflectionAt: now, emoteAt: now + this.emoteDelay(timing),
            emoteCheckedAt: now, timing, lastDecisionAt: -Infinity,
            lastSpeechAt: reflection?.lastSpeechAt ? Date.parse(reflection.lastSpeechAt) : -Infinity, engagement: null };
          this.schedules.set(agent.id, schedule);
        }
        if (!settings.value.activity.emotesEnabled) schedule.emoteAt = Infinity;
        const engagement = schedule.engagement, savedEngagement = reflections.find(item => item.agentId === agent.id)?.engagement;
        if (engagement && (!settings.value.scheduling.engagementEnabled || agent.roomId !== engagement.roomId ||
          !agents.some(other => other.id === engagement.targetAgentId && other.enabled && other.roomId === agent.roomId) ||
          savedEngagement?.roomId !== engagement.roomId || savedEngagement?.rootMessageId !== engagement.rootMessageId ||
          savedEngagement?.targetAgentId !== engagement.targetAgentId)) {
          schedule.engagement = null; schedule.engagementAt = undefined; schedule.engagementTrigger = undefined;
        }
        if (schedule.engagementTrigger && !agents.some(other => other.id === schedule!.engagementTrigger!.sourceAgentId && other.enabled && other.roomId === agent.roomId)) {
          schedule.engagementAt = undefined; schedule.engagementTrigger = undefined;
        }
        const active = this.active.get(agent.id), trigger = active?.opportunity.engagementTrigger;
        if (trigger && !active?.applied && (!schedule.engagement || schedule.engagement.rootMessageId !== trigger.rootMessageId ||
          schedule.engagement.targetAgentId !== trigger.targetAgentId ||
          !agents.some(other => other.id === trigger.sourceAgentId && other.enabled && other.roomId === agent.roomId))) active!.controller.abort();
        if (schedule.speechPlan?.targetAgentId && !agents.some(other => other.id === schedule!.speechPlan!.targetAgentId && other.enabled && other.roomId === agent.roomId))
          schedule.speechPlan = undefined;
        this.refreshActivity(agent.id, this.activity.get(agent.id)?.error);
      }
      this.emit();
    } catch (error) { this.fail(error); throw error; }
  }

  observe(message: ConversationMessage) {
    if (this.state === 'stopped') return;
    for (const [id, schedule] of this.schedules) {
      const engagement = schedule.engagement;
      if (message.type === 'departure' && message.agentId === engagement?.targetAgentId && message.roomId === engagement.roomId) {
        schedule.engagement = null; schedule.engagementAt = undefined; schedule.engagementTrigger = undefined;
      }
      if (message.type === 'departure') {
        if (message.agentId === schedule.engagementTrigger?.sourceAgentId) { schedule.engagementAt = undefined; schedule.engagementTrigger = undefined; }
        const active = this.active.get(id), trigger = active?.opportunity.engagementTrigger;
        if (trigger && !active?.applied && (message.agentId === trigger.targetAgentId || message.agentId === trigger.sourceAgentId)) active!.controller.abort();
        this.refreshActivity(id);
      }
      if (message.type === 'departure' && message.agentId === schedule.speechPlan?.targetAgentId) {
        schedule.speechPlan = undefined; this.refreshActivity(id);
      }
      if (message.type !== 'speak' || message.agentId === id || !engagement || !schedule.timing.engagementEnabled ||
        engagement.roomId !== message.roomId || engagement.rootMessageId !== (message.conversationId ?? message.id)) continue;
      const dueAt = Math.max(this.now(), schedule.lastDecisionAt + schedule.timing.speechCooldownMs, schedule.lastSpeechAt + schedule.timing.speechCooldownMs);
      schedule.engagementAt = Math.min(schedule.engagementAt ?? Infinity, dueAt);
      schedule.engagementTrigger = { rootMessageId: engagement.rootMessageId, targetAgentId: engagement.targetAgentId,
        replyToId: message.id, sourceAgentId: message.agentId, requestedAt: Date.now() };
      this.refreshActivity(id);
    }
    this.emit();
  }

  private fail(error: unknown) {
    if (error instanceof DiagnosticError) {
      if (this.state !== 'stopped') { this.state = 'paused'; this.pausedAt ??= Date.now(); }
      this.error = error.message + ' The run cannot continue without durable diagnostics. Choose Stop, resolve the problem, then Start.';
      for (const active of this.active.values()) active.controller.abort();
      this.newsActive?.controller.abort();
    } else if (this.state !== 'stopped') {
      this.state = 'paused'; this.pausedAt ??= Date.now();
      this.error = 'Could not read saved agent state. Check the database, then resume.';
    }
    void this.world.syncEnergy(Date.now(), false).catch(() => {});
    void this.advanceMedia(Date.now(), false).catch(() => {});
    this.emit();
  }

  async tick() {
    if (this.ticking || this.state !== 'running') return;
    this.ticking = true;
    const epoch = this.epoch;
    try {
      await this.world.syncEnergy(); await this.advanceMedia(); await this.changed(); await this.discoverSummaries(); await this.discoverVotes();
      const agents = await this.world.agents();
      if (this.state !== 'running' || this.epoch !== epoch) return;
      agents.sort((a, b) => (this.activity.get(a.id)?.dueAt ?? Infinity) - (this.activity.get(b.id)?.dueAt ?? Infinity));
      if ((this.newsDueAt ?? Infinity) <= (agents[0] ? this.activity.get(agents[0].id)?.dueAt ?? Infinity : Infinity)) this.startNews();
      for (const agent of agents) {
        // INVARIANT: a timed-out handler retains its slot until it actually settles.
        if (this.occupiedSlots() >= this.options.concurrency) break;
        const schedule = this.schedules.get(agent.id), now = Date.now(), summary = this.nextSummary(agent.id), vote = this.votes.get(agent.id);
        const dueAt = Math.min(schedule ? this.due(schedule) : Infinity, summary?.dueAt ?? Infinity, vote?.requestedAt ?? Infinity);
        if (!agent.enabled || !schedule || this.active.has(agent.id) || this.flights.has(agent.id) || dueAt > now) continue;
        const voting = vote?.requestedAt === dueAt, summarizing = !voting && summary?.dueAt === dueAt,
          engagement = Boolean(schedule.engagementTrigger && (schedule.engagementAt ?? Infinity) <= now),
          plannedSpeech = (schedule.speechPlan?.dueAt ?? Infinity) <= now;
        const opportunity: DecisionOpportunity = voting || summarizing ? { reflection: false, speech: false, emote: false,
          requestedAt: voting ? vote.requestedAt : summary!.requestedAt, reason: 'cadence' } : {
          reflection: schedule.reflectionAt <= now,
          speech: plannedSpeech || engagement, emote: schedule.emoteAt <= now,
          requestedAt: schedule.speechPlan?.dueAt === dueAt ? schedule.speechPlan.requestedAt : engagement ? schedule.engagementTrigger!.requestedAt : dueAt,
          reason: engagement ? 'engagement' : plannedSpeech ? 'scheduled-speech' : 'cadence',
          ...(plannedSpeech ? { speechPlan: { ...schedule.speechPlan! } } : {}),
          ...(engagement ? { engagementTrigger: { ...schedule.engagementTrigger! } } : {}),
          ...(schedule.speechPlan && schedule.speechPlan.dueAt > now ? {
            pendingSpeechPlan: { ...schedule.speechPlan, remainingMs: schedule.speechPlan.dueAt - now },
          } : {}),
        };
        const operation = voting ? 'media-vote' : summarizing ? 'relationship-summary' : opportunity.reflection ? 'reflection' : opportunity.speech ? 'speech' : 'emote';
        const active: ActiveTurn = { controller: new AbortController(), revision: agent.revision, epoch: this.epoch,
          turnId: await this.world.scheduleTurn(agent, dueAt, operation, opportunity.requestedAt), opportunity,
          ...(summarizing ? { summaryTargetId: summary!.targetAgentId } : {}), ...(voting ? { ballotId: vote!.ballotId } : {}) };
        if (this.state !== 'running' || this.epoch !== epoch) { await this.world.endTurn(active.turnId, 'cancelled-before-start'); break; }
        if (opportunity.reflection) schedule.reflectionAt = now + schedule.timing.reflectionIntervalMs;
        if (opportunity.engagementTrigger) { schedule.engagementAt = undefined; schedule.engagementTrigger = undefined; }
        if (opportunity.speechPlan) schedule.speechPlan = undefined;
        if (opportunity.emote) { schedule.emoteCheckedAt = now; schedule.emoteAt = now + this.emoteDelay(schedule.timing); }
        this.active.set(agent.id, active);
        this.activity.set(agent.id, { agentId: agent.id, state: 'running', operation, turnId: active.turnId }); this.emit();
        const task = this.run(agent, active);
        this.pending.add(task); void task.finally(() => this.pending.delete(task));
      }
      this.startNews();
    } catch (error) { this.fail(error); }
    finally { this.ticking = false; }
  }

  private startNews() {
    if (!this.newsHandler || !this.newsEnabled || this.state !== 'running' || this.newsActive || this.flights.has(newsFlightKey) ||
      this.newsDueAt === undefined || this.newsDueAt > Date.now() || this.occupiedSlots() >= this.options.concurrency) return;
    const active: ActiveNews = { controller: new AbortController(), epoch: this.epoch,
      dueAt: this.newsDueAt, requestedAt: this.newsRequestedAt ?? this.newsDueAt };
    this.newsActive = active; this.newsDueAt = undefined; this.newsError = undefined; this.emit();
    const task = this.runNews(active);
    this.pending.add(task); void task.finally(() => this.pending.delete(task));
  }

  private async runNews(active: ActiveNews) {
    const controller = new AbortController(), signal = AbortSignal.any([active.controller.signal, controller.signal]);
    const current = () => this.epoch === active.epoch && !signal.aborted && this.state !== 'stopped' && this.newsEnabled;
    const timeout = setTimeout(() => controller.abort(new Error('The model request timed out.')), this.options.timeoutMs);
    let cancel: (() => void) | undefined;
    try {
      const aborted = new Promise<never>((_, reject) => {
        cancel = () => reject(signal.reason ?? new Error('News request cancelled.'));
        signal.addEventListener('abort', cancel, { once: true }); if (signal.aborted) cancel();
      });
      const handler = this.newsHandler!(signal, current, () => {}, active.dueAt, active.requestedAt);
      this.flights.set(newsFlightKey, handler);
      const settledHandler = handler.catch(error => { if (error instanceof DiagnosticError) this.fail(error); throw error; })
        .finally(() => { if (this.flights.get(newsFlightKey) === handler) this.flights.delete(newsFlightKey); });
      await Promise.race([settledHandler, aborted]);
    } catch (error) {
      if (error instanceof DiagnosticError) this.fail(error);
      if (this.epoch === active.epoch && this.state !== 'stopped' && this.newsEnabled)
        this.newsError = error instanceof Error ? error.message : 'The news request failed.';
    } finally {
      clearTimeout(timeout); if (cancel) signal.removeEventListener('abort', cancel);
      if (this.newsActive === active) this.newsActive = undefined;
      if (this.epoch === active.epoch && this.state !== 'stopped' && this.newsEnabled) {
        this.newsDueAt = this.now() + this.newsIntervalMs; this.newsRequestedAt = Date.now();
      }
      this.emit();
    }
  }

  private async run(agent: Agent, active: ActiveTurn) {
    let failure: string | undefined, outcome = 'cancelled';
    let requestedEmote = false;
    const current = () => this.epoch === active.epoch && !active.controller.signal.aborted && this.state !== 'stopped';
    try {
      for (let attempt = 0; attempt <= this.options.retries; attempt++) {
        let applied = false, settled = false, handlerStarted = false;
        active.controller.signal.throwIfAborted();
        const attemptId = await this.world.startAttempt(active.turnId, attempt + 1, agent);
        const attemptController = new AbortController();
        const signal = AbortSignal.any([active.controller.signal, attemptController.signal]);
        const timeout = setTimeout(() => attemptController.abort(new Error('The model request timed out.')), this.options.timeoutMs);
        let cancel: (() => void) | undefined;
        try {
          const aborted = new Promise<never>((_, reject) => {
            cancel = () => reject(signal.reason ?? new Error('Turn cancelled.'));
            signal.addEventListener('abort', cancel, { once: true }); if (signal.aborted) cancel();
          });
          const onApplied = () => { applied = true; active.applied = true; };
          const handler = active.ballotId
            ? this.media!.vote(agent, active.ballotId, signal, () => current() && !signal.aborted, onApplied, attemptId)
            : active.summaryTargetId
              ? this.summaryHandler!(agent, active.summaryTargetId, signal, () => current() && !signal.aborted, onApplied, attemptId)
              : this.handler(agent, signal, () => current() && !signal.aborted, onApplied, attemptId, active.opportunity);
          this.flights.set(agent.id, handler);
          handlerStarted = true;
          const settledHandler = handler.finally(async () => {
            try { await this.world.settleAttempt(attemptId); }
            catch (error) { this.fail(error); throw error; }
            finally { settled = true; if (this.flights.get(agent.id) === handler) this.flights.delete(agent.id); }
          });
          const result = await Promise.race([settledHandler, aborted]);
          requestedEmote = Boolean(result?.reflectionProcessed && result.requestEmote);
          if (result && current()) await this.acceptResult(agent, active, result);
          failure = undefined; outcome = 'completed';
          await this.world.updateDiagnostic(attemptId, {}, outcome); break;
        } catch (error) {
          const reason = error instanceof Error ? error.message : 'The turn failed.';
          outcome = !current() ? 'cancelled' : attemptController.signal.aborted ? 'timeout' : error instanceof TurnError ? error.category : 'provider';
          if (error instanceof DiagnosticError) { this.fail(error); outcome = 'diagnostic-failure'; }
          if (active.ballotId && !applied && current() && outcome === 'timeout') {
            try {
              const saved = await this.world.recordMediaVoteFailure(agent.id, agent.revision, active.ballotId, 'missing', reason, current, attemptId);
              await this.media!.changed(saved.events);
            } catch (failure) { if (!(failure instanceof ActionError && failure.category === 'stale')) throw failure; }
          }
          await this.world.updateDiagnostic(attemptId, { error: reason }, applied ? 'applied-notification-failure' : outcome);
          if (!current() || error instanceof DiagnosticError) break;
          failure = 'Attempt ' + (attempt + 1) + '/' + (this.options.retries + 1) + ' failed: ' + reason;
          if (applied || outcome === 'stale' || active.ballotId) break;
          if (attempt < this.options.retries) await delay(this.options.backoffMs * 2 ** attempt, undefined, { signal: active.controller.signal });
          if (!settled) break;
        } finally {
          clearTimeout(timeout); if (cancel) signal.removeEventListener('abort', cancel);
          if (!handlerStarted) await this.world.settleAttempt(attemptId);
        }
      }
    } catch (error) {
      if (error instanceof DiagnosticError) { outcome = 'diagnostic-failure'; this.fail(error); }
      if (current()) failure ??= 'The turn failed.';
    } finally {
      if (this.active.get(agent.id) === active) this.active.delete(agent.id);
      try {
        await this.world.endTurn(active.turnId, outcome);
        if (active.ballotId) this.votes.delete(agent.id);
        if (active.summaryTargetId && this.epoch === active.epoch) {
          const key = JSON.stringify([agent.id, active.summaryTargetId]), job = this.summaries.get(key);
          if (job && failure) job.dueAt = this.now() + job.intervalMs;
          else this.summaries.delete(key);
        }
        const schedule = this.schedules.get(agent.id), latest = await this.world.agent(agent.id);
        if (schedule && latest?.enabled && this.state !== 'stopped' && this.epoch === active.epoch && schedule.revision === active.revision) {
          const now = this.now();
          if (!active.summaryTargetId && !active.ballotId) {
            schedule.lastDecisionAt = now;
            if (schedule.engagementAt !== undefined)
              schedule.engagementAt = Math.max(schedule.engagementAt, now + schedule.timing.speechCooldownMs, schedule.lastSpeechAt + schedule.timing.speechCooldownMs);
          }
          if (active.opportunity.reflection) schedule.reflectionAt = now + schedule.timing.reflectionIntervalMs;
          if (active.opportunity.emote) {
            schedule.emoteCheckedAt = now;
            schedule.emoteAt = now + (requestedEmote ? schedule.timing.emoteMinIntervalMs : this.emoteDelay(schedule.timing));
          }
          if (latest.revision !== agent.revision && schedule.revision === agent.revision) {
            schedule.revision = latest.revision; schedule.speechPlan = undefined; schedule.engagement = null; schedule.engagementAt = undefined; schedule.engagementTrigger = undefined;
          }
          this.refreshActivity(agent.id, failure);
        } else if (schedule && latest?.enabled && this.state !== 'stopped') this.refreshActivity(agent.id);
        else this.activity.delete(agent.id);
      } catch (error) { this.fail(error); }
      this.emit();
    }
  }

  private async acceptResult(agent: Agent, active: ActiveTurn, result: DecisionResult) {
    const schedule = this.schedules.get(agent.id);
    if (!schedule || schedule.revision !== active.revision) return;
    const now = this.now();
    if (result.action?.type === 'speak') {
      schedule.lastSpeechAt = now;
      if (schedule.speechPlan) schedule.speechPlan.dueAt = Math.max(schedule.speechPlan.dueAt, now + schedule.timing.speechCooldownMs);
    }
    if (!result.reflectionProcessed) return;
    if (result.speechPlan) {
      const delayMs = Math.max(schedule.timing.speechMinDelayMs, Math.min(schedule.timing.speechMaxDelayMs, result.speechPlan.delayMs));
      schedule.speechPlan = { dueAt: Math.max(now + delayMs, schedule.lastSpeechAt + schedule.timing.speechCooldownMs),
        requestedAt: Date.now(), replyToId: result.speechPlan.replyToId, targetAgentId: result.speechPlan.targetAgentId };
    } else schedule.speechPlan = undefined;
    const previous = schedule.engagement;
    schedule.engagement = result.engagement ? { ...result.engagement, roomId: agent.roomId } : null;
    if (!schedule.engagement || previous?.rootMessageId !== schedule.engagement.rootMessageId || previous?.targetAgentId !== schedule.engagement.targetAgentId) {
      schedule.engagementAt = undefined; schedule.engagementTrigger = undefined;
    }
    if (result.requestEmote && Number.isFinite(schedule.emoteAt))
      schedule.emoteAt = Math.min(schedule.emoteAt, Math.max(now, schedule.emoteCheckedAt + schedule.timing.emoteMinIntervalMs));
  }
}
