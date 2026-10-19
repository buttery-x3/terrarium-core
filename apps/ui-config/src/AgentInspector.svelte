<script lang="ts">
  import type { Agent, AgentActivity, ReflectionState } from "@terrarium/shared";

  export let agent: Agent;
  export let agents: Agent[];
  export let activity: AgentActivity | undefined = undefined;
  export let reflection: ReflectionState | undefined = undefined;

  const timestamp = (value: string | number | null | undefined) => value === undefined || value === null ? "None" : new Date(value).toLocaleString();
</script>

<details>
  <summary>Inspect {agent.name}'s private state and schedules</summary>
  <p>Current room occupants: {agents.filter(item => item.roomId === agent.roomId).map(item => item.name).join(", ") || "None"}.</p>
  {#if activity}
    <p>{activity.state}{#if activity.operation} · {activity.operation}{/if}{#if activity.dueAt} · Next operation due {timestamp(activity.dueAt)}{/if}</p>
    <dl>
      <dt>Next reflection</dt><dd>{timestamp(activity.nextReflectionAt)}</dd>
      <dt>Next speech opportunity</dt><dd>{timestamp(activity.nextSpeechAt)}</dd>
      <dt>Next emote opportunity</dt><dd>{timestamp(activity.nextEmoteAt)}</dd>
    </dl>
    {#if activity.error}<p role="alert">{activity.error}</p>{/if}
  {:else}<p>No operations scheduled.</p>{/if}
  <h4>Generated private character state</h4>
  <p>Visible to the operator and this agent. Other residents do not receive it.</p>
  {#if reflection?.reflectedAt}
    <p>Last changed <time datetime={reflection.reflectedAt}>{timestamp(reflection.reflectedAt)}</time>. An unchanged reflection keeps this timestamp.</p>
    <dl>
      <dt>Reaction</dt><dd>{reflection.reaction ?? "None"}</dd>
      <dt>Immediate intention</dt><dd>{reflection.intention ?? "None"}</dd>
    </dl>
  {:else}<p>No generated private character state yet.</p>{/if}
  <p>Last speech: {timestamp(reflection?.lastSpeechAt)}. Last emote: {timestamp(reflection?.lastEmoteAt)}.</p>
  {#if reflection?.engagement}
    <p>Subscribed local exchange: {reflection.engagement.rootMessageId}. Interlocutor: {agents.find(item => item.id === reflection.engagement?.targetAgentId)?.name ?? reflection.engagement.targetAgentId}. Room: {reflection.engagement.roomId}.</p>
  {:else}<p>No local exchange subscription.</p>{/if}
</details>

<style>
  dt { font-weight: 600; }
  dd { margin: 0 0 0.5rem; white-space: pre-wrap; overflow-wrap: anywhere; }
  [role="alert"] { color: #a21919; }
</style>
