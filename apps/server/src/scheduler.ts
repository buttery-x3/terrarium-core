import { setTimeout as delay } from 'node:timers/promises';
import type { Agent, AgentActivity, RunState } from '@terrarium/shared';
import type { World } from '@terrarium/persistence';

type TurnHandler = (
  agent: Agent,
  signal: AbortSignal,
  stillCurrent: () => boolean,
  onApplied: () => void,
) => Promise<void>;
type ActiveTurn = {
  controller: AbortController;
  revision: number;
  epoch: number;
};

export class Scheduler {
  private state: RunState['state'] = 'stopped';
  private epoch = 0;
  private active = new Map<string, ActiveTurn>();
  private activity = new Map<string, AgentActivity>();
  private ticking = false;
  private timer?: ReturnType<typeof setInterval>;
  private error?: string;

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
    this.stop();
  }

  async start() {
    if (this.state === 'running') return;
    this.error = undefined;
    this.state = 'running';
    try {
      await this.changed();
    } catch (error) {
      this.failedStateRead();
      throw error;
    }
    this.emit();
  }
  pause() {
    if (this.state === 'running') {
      this.state = 'paused';
      this.emit();
    }
  }
  stop() {
    this.state = 'stopped';
    this.epoch += 1;
    this.error = undefined;
    for (const active of this.active.values()) active.controller.abort();
    this.activity.clear();
    this.emit();
  }
  async changed() {
    const agents = await this.world.agents();
    const enabled = new Map(
      agents.filter((agent) => agent.enabled).map((agent) => [agent.id, agent]),
    );
    for (const [id, active] of this.active) {
      if (enabled.get(id)?.revision !== active.revision)
        active.controller.abort();
    }
    for (const id of this.activity.keys())
      if (!enabled.has(id)) this.activity.delete(id);
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
          });
      }
    }
    this.emit();
  }

  private failedStateRead() {
    if (this.state === 'stopped') return;
    this.error =
      'Could not read saved agent state. Check the database, then resume.';
    this.state = 'paused';
    this.emit();
  }

  async tick() {
    if (this.ticking || this.state !== 'running') return;
    this.ticking = true;
    try {
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
        };
        this.active.set(agent.id, active);
        this.activity.set(agent.id, { agentId: agent.id, state: 'running' });
        this.emit();
        void this.run(agent, active);
      }
    } catch {
      this.failedStateRead();
    } finally {
      this.ticking = false;
    }
  }

  private async run(agent: Agent, active: ActiveTurn) {
    let failure: string | undefined;
    const current = () =>
      this.epoch === active.epoch &&
      !active.controller.signal.aborted &&
      this.state !== 'stopped';
    try {
      for (let attempt = 0; attempt <= this.options.retries; attempt++) {
        let applied = false;
        active.controller.signal.throwIfAborted();
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
            ),
            aborted,
          ]);
          failure = undefined;
          break;
        } catch (error) {
          if (!current()) break;
          const reason = error instanceof Error ? error.message : 'The turn failed.';
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
    } catch {
      if (current()) failure = 'The turn failed.';
    } finally {
      this.active.delete(agent.id);
      try {
        const latest = await this.world.agent(agent.id);
        if (this.state !== 'stopped' && latest?.enabled) {
          const dueAt =
            Date.now() +
            latest.minIntervalMs +
            Math.random() * (latest.maxIntervalMs - latest.minIntervalMs);
          this.activity.set(agent.id, {
            agentId: agent.id,
            state: failure ? 'error' : 'scheduled',
            dueAt,
            ...(failure ? { error: failure } : {}),
          });
        } else this.activity.delete(agent.id);
      } catch {
        if (this.state !== 'stopped') {
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
