<script lang="ts">
  import { onMount } from "svelte";
  import { io } from "socket.io-client";
  import type { Agent, AgentInput, AuthState, ConversationMessage, HistoryCursor, HistoryPage, Result, Room, RunState, WorldState } from "@terrarium/shared";

  const socket = io("/config", { autoConnect: false, transports: ["websocket"] });
  let connected = false;
  let rooms: Room[] = [];
  let agents: Agent[] = [];
  let selectedRoom = "";
  let histories: Record<string, ConversationMessage[]> = {};
  let older: Record<string, boolean> = {};
  let loaded = new Set<string>();
  let recovering = new Map<string, HistoryCursor | undefined>();
  let loading = new Map<string, number>();
  let connectionEpoch = 0;
  let message = "";
  let error = "";
  let notice = "";
  let busy = false;
  let runState: RunState = { state: "stopped", agents: [], concurrency: 4 };
  let auth: AuthState = { connected: false, pending: false };
  let signInUrl = "";
  let models: string[] = [];
  let roomId = "";
  let roomName = "";
  let roomDescription = "";
  let agentId = "";
  let agentName = "";
  let instructions = "";
  let agentRoom = "";
  let agentModel = "gpt-6-luna";
  let enabled = false;
  let minimumSeconds = 10;
  let maximumSeconds = 30;
  let contextMessages = 50;

  const cursor = (item: ConversationMessage | undefined): HistoryCursor | undefined => item ? { id: item.id, createdAt: item.createdAt } : undefined;
  function request<T>(event: string, payload: unknown): Promise<T> {
    if (!socket.connected) return Promise.reject(new Error("The server is disconnected."));
    return new Promise((resolve, reject) => {
      socket.timeout(30000).emit(event, payload, (timeout: Error | null, result: Result<T>) => {
        if (timeout) reject(new Error("The server did not confirm the operation. Reconnect and check saved state before retrying."));
        else if (!result?.ok) reject(new Error(result?.error ?? "The operation failed."));
        else resolve(result.value);
      });
    });
  }
  function merge(room: string, incoming: ConversationMessage[]) {
    const records = new Map((histories[room] ?? []).map(item => [item.id, item]));
    incoming.forEach(item => records.set(item.id, item));
    histories = { ...histories, [room]: [...records.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)) };
  }
  async function loadHistory(room: string, loadOlder = false) {
    if (!room || !connected || loading.has(room)) return;
    if (!loadOlder && loaded.has(room) && !recovering.has(room)) return;
    const epoch = connectionEpoch;
    loading.set(room, epoch);
    try {
      const wasLoaded = loaded.has(room);
      let after = recovering.get(room);
      const before = loadOlder ? cursor(histories[room]?.[0]) : undefined;
      do {
        const page = await request<HistoryPage>("history:get", { roomId: room, ...(before ? { before } : after ? { after } : {}) });
        if (epoch !== connectionEpoch) return;
        merge(room, page.messages);
        if (loadOlder || !wasLoaded) older = { ...older, [room]: page.hasMore };
        if (loadOlder || !after || !page.hasMore || !page.messages.length) break;
        after = cursor(page.messages[page.messages.length - 1]);
      } while (true);
      loaded.add(room); recovering.delete(room);
    } catch (failure) { if (epoch === connectionEpoch) error = failure instanceof Error ? failure.message : "Could not load history."; }
    finally { if (loading.get(room) === epoch) loading.delete(room); }
  }
  async function perform(action: () => Promise<void>) {
    error = ""; notice = ""; busy = true;
    try { await action(); } catch (failure) { error = failure instanceof Error ? failure.message : "The operation failed."; }
    finally { busy = false; }
  }
  function editRoom(room?: Room) { roomId = room?.id ?? ""; roomName = room?.name ?? ""; roomDescription = room?.description ?? ""; }
  function editAgent(agent?: Agent) {
    agentId = agent?.id ?? ""; agentName = agent?.name ?? ""; instructions = agent?.instructions ?? "";
    agentRoom = agent?.roomId ?? selectedRoom; agentModel = agent?.model ?? "gpt-6-luna"; enabled = agent?.enabled ?? false;
    minimumSeconds = (agent?.minIntervalMs ?? 10000) / 1000; maximumSeconds = (agent?.maxIntervalMs ?? 30000) / 1000;
    contextMessages = agent?.contextMessageLimit ?? 50;
  }
  async function discoverModels() {
    try { models = await request<string[]>("auth:models", {}); }
    catch (failure) { error = failure instanceof Error ? failure.message : "Could not load ChatGPT models."; }
  }
  onMount(() => {
    socket.on("connect", () => {
      connected = true; connectionEpoch++;
      if (error === "Cannot connect to the local server. Check that pnpm dev is running.") error = "";
      recovering = new Map([...loaded].map(room => [room, cursor(histories[room]?.[histories[room].length - 1]) ?? { id: '0', createdAt: '1970-01-01T00:00:00.000Z' }]));
    });
    socket.on("disconnect", () => { connected = false; connectionEpoch++; loading.clear(); });
    socket.on("connect_error", () => { error = "Cannot connect to the local server. Check that pnpm dev is running."; });
    socket.on("world:state", (state: WorldState) => {
      rooms = state.rooms; agents = state.agents;
      if (!rooms.some(room => room.id === selectedRoom)) selectedRoom = rooms[0]?.id ?? "";
      if (!agentRoom) agentRoom = selectedRoom;
      void loadHistory(selectedRoom);
    });
    socket.on("conversation:message", (item: ConversationMessage) => merge(item.roomId, [item]));
    socket.on("run:state", (state: RunState) => { runState = state; });
    socket.on("auth:state", (state: AuthState) => {
      const newlyConnected = state.connected && !auth.connected;
      auth = state; if (!state.pending) signInUrl = "";
      if (newlyConnected) void discoverModels();
    });
    socket.on("operation:error", (value: string) => { error = value; });
    socket.connect();
    return () => socket.close();
  });
</script>

<main>
  <h1>Terrarium</h1>
  <p>{connected ? "Server connected" : "Server disconnected"} · Conversation {runState.state}</p>
  {#if runState.error}<p role="alert">{runState.error}</p>{/if}
  {#if error}<p role="alert">{error}</p>{/if}
  {#if notice}<p role="status">{notice}</p>{/if}
  <section aria-label="Connection and run controls">
    <h2>ChatGPT connection</h2>
    <p>{auth.connected ? "Connected with ChatGPT plan usage" : "Connect your ChatGPT account to run agents."}</p>
    {#if auth.error}<p role="alert">{auth.error}</p>{/if}
    <button disabled={!connected || busy || auth.pending} on:click={() => perform(async () => {
      const result = await request<{ url: string }>("auth:login", {}); signInUrl = result.url;
    })}>{auth.connected ? "Reconnect ChatGPT" : "Connect ChatGPT"}</button>
    {#if signInUrl}<p><a href={signInUrl} target="_blank" rel="noreferrer">Continue to ChatGPT sign-in</a></p>{/if}
    {#if auth.pending}<p>Waiting for sign-in to finish in your browser.</p>{/if}
    <p>Pause finishes active turns. Stop cancels active turns and discards late responses.</p>
    <button disabled={!connected || busy || !auth.connected || runState.state === "running"} on:click={() => perform(async () => { runState = await request("run:control", "start"); })}>{runState.state === "paused" ? "Resume" : "Start"}</button>
    <button disabled={!connected || busy || runState.state !== "running"} on:click={() => perform(async () => { runState = await request("run:control", "pause"); })}>Pause</button>
    <button disabled={!connected || busy || runState.state === "stopped"} on:click={() => perform(async () => { runState = await request("run:control", "stop"); })}>Stop</button>
  </section>
  <section>
    <h2>Conversations</h2>
    <label>Room <select bind:value={selectedRoom} on:change={() => loadHistory(selectedRoom)}>{#each rooms as room}<option value={room.id}>{room.name}</option>{/each}</select></label>
    <p>{rooms.find(room => room.id === selectedRoom)?.description ?? ""}</p>
    {#if older[selectedRoom]}<button disabled={!connected} on:click={() => loadHistory(selectedRoom, true)}>Load older messages</button>{/if}
    <ol class="conversation" aria-label="Conversation history">
      {#each histories[selectedRoom] ?? [] as item (item.id)}
        <li><strong>{item.speaker}</strong> <time datetime={item.createdAt}>{new Date(item.createdAt).toLocaleString()}</time><p>{item.content}</p></li>
      {:else}<li>No saved messages in this room yet.</li>{/each}
    </ol>
    <form on:submit|preventDefault={() => perform(async () => {
      const sent = await request<ConversationMessage>("config:message", { roomId: selectedRoom, message });
      merge(sent.roomId, [sent]); message = ""; notice = "Message saved.";
    })}>
      <label>Message <textarea bind:value={message} maxlength="8000" required rows="3"></textarea></label>
      <button disabled={!connected || busy || !selectedRoom || !message.trim()}>Send message</button>
    </form>
  </section>
  <section>
    <h2>Rooms</h2>
    <ul>{#each rooms as room}<li>{room.name} <button on:click={() => editRoom(room)}>Edit {room.name}</button></li>{/each}</ul>
    <button on:click={() => editRoom()}>New room</button>
    <form on:submit|preventDefault={() => perform(async () => {
      const saved = await request<Room>("rooms:save", { ...(roomId ? { id: roomId } : {}), name: roomName, description: roomDescription });
      editRoom(saved); notice = "Room saved.";
    })}>
      <h3>{roomId ? "Edit room" : "Create room"}</h3>
      <label>Room name <input bind:value={roomName} maxlength="8000" required /></label>
      <label>Description <textarea bind:value={roomDescription} maxlength="8000"></textarea></label>
      <button disabled={!connected || busy}>Save room</button>
    </form>
  </section>
  <section>
    <h2>Agents</h2>
    <p>Each agent can have one active turn. Up to {runState.concurrency} requests run at once.</p>
    <ul>{#each agents as agent}
      <li><strong>{agent.name}</strong> · {rooms.find(room => room.id === agent.roomId)?.name ?? agent.roomId} · {agent.enabled ? "Enabled" : "Disabled"}
        <button on:click={() => editAgent(agent)}>Edit {agent.name}</button>
        {#each runState.agents.filter(item => item.agentId === agent.id) as activity}
          <p>{activity.state}{#if activity.dueAt} · Next turn after {new Date(activity.dueAt).toLocaleTimeString()}{/if}</p>
          {#if activity.error}<p role="alert">{activity.error}</p>{/if}
        {/each}
      </li>
    {:else}<li>No agents configured.</li>{/each}</ul>
    <button on:click={() => editAgent()}>New agent</button>
    <form on:submit|preventDefault={() => perform(async () => {
      const input: AgentInput = { ...(agentId ? { id: agentId } : {}), name: agentName, instructions, roomId: agentRoom,
        provider: "chatgpt", model: agentModel, enabled, minIntervalMs: Math.round(minimumSeconds * 1000),
        maxIntervalMs: Math.round(maximumSeconds * 1000), contextMessageLimit: contextMessages };
      const saved = await request<Agent>("agents:save", input); editAgent(saved); notice = "Agent saved.";
    })}>
      <h3>{agentId ? "Edit agent" : "Create agent"}</h3>
      <label>Agent name <input bind:value={agentName} maxlength="8000" required /></label>
      <label>Personality instructions <textarea bind:value={instructions} maxlength="8000" required rows="4"></textarea></label>
      <label>Current room <select bind:value={agentRoom} required>{#each rooms as room}<option value={room.id}>{room.name}</option>{/each}</select></label>
      <label>ChatGPT model <input bind:value={agentModel} list="chatgpt-models" required /></label>
      <datalist id="chatgpt-models">{#each models as model}<option value={model}></option>{/each}</datalist>
      <button type="button" disabled={!auth.connected || busy} on:click={discoverModels}>Refresh available models</button>
      <label>Minimum seconds between turns <input type="number" min="0.001" step="0.001" bind:value={minimumSeconds} required /></label>
      <label>Maximum seconds between turns <input type="number" min={minimumSeconds} step="0.001" bind:value={maximumSeconds} required /></label>
      <label>Recent room messages in context <input type="number" min="1" max="50" bind:value={contextMessages} required /></label>
      <p>Context includes recent messages from the current room, including messages from before arrival.</p>
      <label><input type="checkbox" bind:checked={enabled} /> Enabled</label>
      <button disabled={!connected || busy}>Save agent</button>
    </form>
  </section>
</main>

<style>
  main { max-width: 60rem; margin: 0 auto; padding: 1rem; font-family: system-ui, sans-serif; }
  section { margin-bottom: 2rem; }
  form { display: grid; gap: 0.75rem; max-width: 40rem; }
  label { display: grid; gap: 0.25rem; }
  button, input, select, textarea { font: inherit; }
  button { width: fit-content; }
  textarea { width: 100%; box-sizing: border-box; }
  .conversation { max-height: 28rem; overflow-y: auto; padding-left: 1.5rem; }
  .conversation p { white-space: pre-wrap; overflow-wrap: anywhere; }
  time { font-size: 0.85rem; }
  [role="alert"] { color: #a21919; }
</style>
