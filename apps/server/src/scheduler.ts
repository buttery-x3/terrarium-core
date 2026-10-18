import { setTimeout as delay } from 'node:timers/promises';
import type { Agent, AgentActivity, RunState } from '@terrarium/shared';
import { DiagnosticError, type World } from '@terrarium/persistence';
import { TurnError } from './turns.js';

type TurnHandler = (
  agent: Agent,
  signal: AbortSignal,
  stillCurrent: () => boolean,
  onApplied: () => void,
  attemptId?: string,
) => Promise<void>;
type ActiveTurn = {
  controller: AbortController;
  revision: number;
  epoch: number;
  turnId: string;
};

export class Scheduler {
  private state: RunState['state'] = 'stopped';
  private epoch = 0;
  private active = new Map<string, ActiveTurn>();
  private activity = new Map<string, AgentActivity>();
  private ticking = false;
  private timer?: ReturnType<typeof setInterval>;
  private error?: string;
  private pending = new Set<Promise<void>>();

  constructor(
    private world: World,
    private handler: TurnHandler,
    private publish: (state: RunState) => void,
    private options = {
      concurrency: 4,
      timeoutMs: 60000,
      retries: 2,
      backoffMs: 1000,
    },
  ) {}

  snapshot(): RunState {
    return {
      state: this.state,
      agents: [...this.activity.values()],
      concurrency: this.options.concurrency,
      ...(this.error ? { error: this.error } : {}),
    };
  }
  private emit() {
    this.publish(this.snapshot());
  }
  watch() {
    this.timer ??= setInterval(() => {
      void this.tick();
    }, 500);
  }
  close() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    return this.stop();
  }

  async start() {
    if (this.state === 'running') return;
    await this.world.validateSettings((await this.world.settings()).value);
    this.error = undefined;
    this.state = 'running';
    await this.world.syncEnergy(Date.now(), true);
    try {
      await this.changed();
    } catch (error) {
      if (error instanceof DiagnosticError) this.diagnosticFailure(error.message);
      else this.failedStateRead();
      throw error;
    }
    this.emit();
  }
  pause() {
    if (this.state === 'running') {
      this.state = 'paused';
      void this.world.syncEnergy(Date.now(), false).catch(() => this.diagnosticFailure('Could not checkpoint energy.'));
      this.emit();
    }
  }
  stop() {
    this.state = 'stopped';
    this.epoch += 1;
    this.error = undefined;
    for (const active of this.active.values()) active.controller.abort();
    const finishing: Promise<unknown>[] = [this.world.syncEnergy(Date.now(), false).catch(() => this.diagnosticFailure('Could not checkpoint energy.'))];
    for (const activity of this.activity.values()) if (activity.turnId && !this.active.has(activity.agentId))
      finishing.push(this.world.endTurn(activity.turnId, 'cancelled-before-start').catch(error => this.diagnosticFailure(error.message)));
    this.activity.clear();
    this.emit();
    return Promise.allSettled([...finishing, ...this.pending]);
  }
  hasActiveWork() { return this.active.size > 0 || this.pending.size > 0; }
  async changed() {
    try {
    const agents = await this.world.agents();
    const enabled = new Map(
      agents.filter((agent) => agent.enabled).map((agent) => [agent.id, agent]),
    );
    for (const [id, active] of this.active) {
      if (enabled.get(id)?.revision !== active.revision)
        active.controller.abort();
    }
    for (const [id, activity] of this.activity)
      if (!enabled.has(id)) {
        if (activity.turnId && !this.active.has(id)) await this.world.endTurn(activity.turnId, 'cancelled-before-start');
        this.activity.delete(id);
      }
    if (this.state !== 'stopped') {
      for (const agent of enabled.values()) {
        if (
          !this.active.has(agent.id) &&
          this.activity.get(agent.id)?.dueAt === undefined
        )
          this.activity.set(agent.id, {
            agentId: agent.id,
            state: 'scheduled',
            dueAt: Date.now(),
            turnId: await this.world.scheduleTurn(agent, Date.now()),
          });
      }
    }
    this.emit();
    } catch (error) {
      if (error instanceof DiagnosticError) this.diagnosticFailure(error.message);
      throw error;
    }
  }

  private failedStateRead() {
    if (this.state === 'stopped') return;
    this.error =
      'Could not read saved agent state. Check the database, then resume.';
    this.state = 'paused';
    void this.world.syncEnergy(Date.now(), false).catch(() => {});
    this.emit();
  }

  private diagnosticFailure(message: string) {
    if (this.state !== 'stopped') this.state = 'paused';
    this.error = `${message} The run cannot continue without durable diagnostics. Choose Stop, resolve the problem, then Start.`;
    for (const active of this.active.values()) active.controller.abort();
    void this.world.syncEnergy(Date.now(), false).catch(() => {});
    this.emit();
  }

  async tick() {
    if (this.ticking || this.state !== 'running') return;
    this.ticking = true;
    try {
      await this.world.syncEnergy();
      const agents = await this.world.agents();
      if (this.state !== 'running') return;
      agents.sort(
        (left, right) =>
          (this.activity.get(left.id)?.dueAt ?? Infinity) -
          (this.activity.get(right.id)?.dueAt ?? Infinity),
      );
      for (const agent of agents) {
        if (this.active.size >= this.options.concurrency) break;
        const activity = this.activity.get(agent.id);
        if (
          !agent.enabled ||
          this.active.has(agent.id) ||
          !activity ||
          (activity.dueAt ?? Infinity) > Date.now()
        )
          continue;
        const active = {
          controller: new AbortController(),
          revision: agent.revision,
          epoch: this.epoch,
          turnId: activity.turnId ?? await this.world.scheduleTurn(agent, activity.dueAt ?? Date.now()),
        };
        this.active.set(agent.id, active);
        this.activity.set(agent.id, { agentId: agent.id, state: 'running', turnId: active.turnId });
        this.emit();
        const task = this.run(agent, active);
        this.pending.add(task);
        void task.finally(() => this.pending.delete(task));
      }
    } catch (error) {
      if (error instanceof DiagnosticError) this.diagnosticFailure(error.message);
      else this.failedStateRead();
    } finally {
      this.ticking = false;
    }
  }

  private async run(agent: Agent, active: ActiveTurn) {
    let failure: string | undefined;
    let outcome = 'cancelled';
    const current = () =>
      this.epoch === active.epoch &&
      !active.controller.signal.aborted &&
      this.state !== 'stopped';
    try {
      for (let attempt = 0; attempt <= this.options.retries; attempt++) {
        let applied = false;
        active.controller.signal.throwIfAborted();
        const attemptId = await this.world.startAttempt(active.turnId, attempt + 1, agent);
        const attemptController = new AbortController();
        const signal = AbortSignal.any([
          active.controller.signal,
          attemptController.signal,
        ]);
        const timeout = setTimeout(
          () =>
            attemptController.abort(new Error('The model request timed out.')),
          this.options.timeoutMs,
        );
        let cancel: (() => void) | undefined;
        try {
          const aborted = new Promise<never>((_, reject) => {
            cancel = () =>
              reject(signal.reason ?? new Error('Turn cancelled.'));
            signal.addEventListener('abort', cancel, { once: true });
            if (signal.aborted) cancel();
          });
          await Promise.race([
            this.handler(
              agent,
              signal,
              () => current() && !signal.aborted,
              () => {
                applied = true;
              },
              attemptId,
            ),
            aborted,
          ]);
          failure = undefined;
          outcome = 'completed';
          await this.world.updateDiagnostic(attemptId, {}, 'completed');
          break;
        } catch (error) {
          const reason = error instanceof Error ? error.message : 'The turn failed.';
          outcome = !current() ? 'cancelled' : attemptController.signal.aborted ? 'timeout' : error instanceof TurnError ? error.category : 'provider';
          if (error instanceof DiagnosticError) {
            this.diagnosticFailure(error.message); outcome = 'diagnostic-failure';
            await this.world.updateDiagnostic(attemptId, { error: error.message }, outcome).catch(() => {});
            break;
          }
          await this.world.updateDiagnostic(attemptId, { error: reason }, applied ? 'applied-notification-failure' : outcome);
          if (!current()) break;
          failure = `Attempt ${attempt + 1}/${this.options.retries + 1} failed: ${reason}`;
          if (applied) break;
          if (attempt < this.options.retries)
            await delay(this.options.backoffMs * 2 ** attempt, undefined, {
              signal: active.controller.signal,
            });
        } finally {
          clearTimeout(timeout);
          if (cancel) signal.removeEventListener('abort', cancel);
        }
      }
    } catch (error) {
      if (error instanceof DiagnosticError) {
        outcome = 'diagnostic-failure';
        this.diagnosticFailure(error.message);
        await this.world.updateDiagnostic(active.turnId, { error: error.message }, outcome).catch(() => {});
      }
      if (current()) failure = 'The turn failed.';
    } finally {
      this.active.delete(agent.id);
      try {
        await this.world.endTurn(active.turnId, outcome);
        const latest = await this.world.agent(agent.id);
        if (this.state !== 'stopped' && latest?.enabled && !this.error) {
          const dueAt =
            Date.now() +
            latest.minIntervalMs +
            Math.random() * (latest.maxIntervalMs - latest.minIntervalMs);
          this.activity.set(agent.id, {
            agentId: agent.id,
            state: failure ? 'error' : 'scheduled',
            dueAt,
            ...(failure ? { error: failure } : {}),
            turnId: await this.world.scheduleTurn(latest, dueAt),
          });
        } else this.activity.delete(agent.id);
      } catch (error) {
        if (error instanceof DiagnosticError) this.diagnosticFailure(error.message);
        else if (this.state !== 'stopped') {
          this.activity.set(agent.id, {
            agentId: agent.id,
            state: 'error',
            error: 'Could not reload agent state.',
          });
          this.failedStateRead();
        }
      }
      this.emit();
    }
  }
}
