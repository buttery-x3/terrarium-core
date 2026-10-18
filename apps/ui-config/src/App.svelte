<script lang="ts">
  import { onMount } from "svelte";
  import { io } from "socket.io-client";
  import { configurationSchema, configurationFileLimitBytes, type Configuration, type ConfigurationPreview } from "@terrarium/shared";
  import type { Agent, AgentInput, AuthState, ClearHistoryInput, ConversationMessage, HistoryCleared, HistoryCursor, HistoryPage, Result, Room, RunState, WorldState } from "@terrarium/shared";

  const socket = io("/config", { autoConnect: false, transports: ["websocket"] });
  let connected = false;
  let rooms: Room[] = [];
  let agents: Agent[] = [];
  let selectedRoom = "";
  let histories: Record<string, ConversationMessage[]> = {};
  let older: Record<string, boolean> = {};
  let loaded = new Set<string>();
  let loading = new Map<string, symbol>();
  let clearScope: "room" | "all" = "room";
  let clearConfirmation: { input: ClearHistoryInput; label: string } | undefined;
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
  let importConfiguration: Configuration | undefined;
  let importPreview: ConfigurationPreview | undefined;
  let importFileName = "";

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
    if (!loadOlder && loaded.has(room)) return;
    const token = Symbol();
    loading.set(room, token);
    try {
      const before = loadOlder ? cursor(histories[room]?.[0]) : undefined;
      const page = await request<HistoryPage>("history:get", { roomId: room, ...(before ? { before } : {}) });
      if (loading.get(room) !== token) return;
      merge(room, page.messages);
      older = { ...older, [room]: page.hasMore };
      loaded.add(room);
    } catch (failure) { if (loading.get(room) === token) error = failure instanceof Error ? failure.message : "Could not load history."; }
    finally { if (loading.get(room) === token) loading.delete(room); }
  }
  function resetHistory(roomIds: string[]) {
    const remaining = { ...histories }, remainingOlder = { ...older };
    for (const room of roomIds) {
      delete remaining[room]; delete remainingOlder[room];
      loaded.delete(room); loading.delete(room);
    }
    histories = remaining; older = remainingOlder;
  }
  function confirmClear() {
    clearConfirmation = clearScope === "all"
      ? { input: { scope: "all" }, label: "all rooms" }
      : { input: { scope: "room", roomId: selectedRoom }, label: `room “${rooms.find(room => room.id === selectedRoom)?.name ?? selectedRoom}”` };
  }
  async function clearHistory() {
    if (!clearConfirmation) return;
    const selection = clearConfirmation;
    clearConfirmation = undefined;
    const result = await request<HistoryCleared>("history:clear", selection.input);
    notice = `Cleared ${result.deletedMessages} saved messages from ${selection.label}. Rooms and agents are unchanged.`;
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
  function clearImport() { importConfiguration = undefined; importPreview = undefined; importFileName = ""; }
  async function exportConfiguration() {
    const configuration = await request<Configuration>("config:export", {});
    const url = URL.createObjectURL(new Blob([JSON.stringify(configuration, null, 2) + "\n"], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url; link.download = "terrarium-config.json";
    document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    notice = "Configuration exported.";
  }
  async function previewConfiguration() {
    importPreview = undefined;
    if (importConfiguration) importPreview = await request<ConfigurationPreview>("config:preview", importConfiguration);
  }
  async function readConfigurationFile(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    clearImport();
    if (!file) return;
    await perform(async () => {
      if (file.size > configurationFileLimitBytes) throw new Error("Choose a JSON file smaller than 512 KiB.");
      let value: unknown;
      try { value = JSON.parse((await file.text()).replace(/^\uFEFF/, "")); }
      catch { throw new Error("The selected file is not valid JSON."); }
      const parsed = configurationSchema.safeParse(value);
      if (!parsed.success) throw new Error(parsed.error.issues.slice(0, 10).map(issue => `${issue.path.join(".") || "Configuration"}: ${issue.message}`).join("; "));
      importConfiguration = parsed.data; importFileName = file.name;
      await previewConfiguration();
    });
    input.value = "";
  }
  async function applyConfiguration() {
    if (!importConfiguration || !importPreview) return;
    const payload = { configuration: importConfiguration, previewToken: importPreview.token };
    importPreview = undefined;
    const result = await request<ConfigurationPreview>("config:import", payload);
    clearImport(); editRoom(); editAgent();
    notice = `Configuration imported. Rooms saved: ${result.rooms.length}; agents saved: ${result.agents.length}. Choose Start when ready.`;
  }
  onMount(() => {
    socket.on("connect", () => {
      connected = true;
      // INVARIANT: reconnect discards caches that may have missed a conversation clear.
      histories = {}; older = {}; loaded.clear(); loading.clear();
      if (error === "Cannot connect to the local server. Check that pnpm dev is running.") error = "";
    });
    socket.on("disconnect", () => { connected = false; loading.clear(); importPreview = undefined; clearConfirmation = undefined; });
    socket.on("connect_error", () => { error = "Cannot connect to the local server. Check that pnpm dev is running."; });
    socket.on("world:state", (state: WorldState) => {
      importPreview = undefined;
      rooms = state.rooms; agents = state.agents;
      if (!rooms.some(room => room.id === selectedRoom)) selectedRoom = rooms[0]?.id ?? "";
      if (!agentRoom) agentRoom = selectedRoom;
      void loadHistory(selectedRoom);
    });
    socket.on("conversation:message", (item: ConversationMessage) => merge(item.roomId, [item]));
    socket.on("conversation:cleared", (result: HistoryCleared) => {
      resetHistory(result.roomIds); clearConfirmation = undefined;
      void loadHistory(selectedRoom);
    });
    socket.on("run:state", (state: RunState) => { runState = state; if (state.state !== "stopped") clearConfirmation = undefined; });
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
    <h2>Configuration files</h2>
    <p>Save rooms and agents as JSON, including instructions, model, timing, enabled state and current room. Conversation history and ChatGPT credentials stay separate.</p>
    <button disabled={!connected || busy} on:click={() => perform(exportConfiguration)}>Export configuration</button>
    <label>Import configuration JSON <input type="file" accept=".json,application/json" disabled={!connected || busy} on:change={readConfigurationFile} /></label>
    <p>Files can be up to 512 KiB. Import updates matching IDs and adds new IDs. Entries absent from the file are kept.</p>
    {#if runState.state !== "stopped"}<p>Choose Stop before applying an import. Imported agents keep their enabled settings; Start remains a separate action.</p>{/if}
    {#if importConfiguration}
      <h3>Preview: {importFileName}</h3>
      {#if importPreview}
        <p>Rooms: {importPreview.rooms.filter(item => item.operation === "add").length} to add, {importPreview.rooms.filter(item => item.operation === "update").length} to update. Agents: {importPreview.agents.filter(item => item.operation === "add").length} to add, {importPreview.agents.filter(item => item.operation === "update").length} to update.</p>
        <ul aria-label="Configuration changes">
          {#each importPreview.rooms as room}<li>{room.operation === "add" ? "Add" : "Update"} room: {room.name} ({room.id})</li>{/each}
          {#each importPreview.agents as agent}<li>{agent.operation === "add" ? "Add" : "Update"} agent: {agent.name} ({agent.id})</li>{/each}
        </ul>
        <button disabled={!connected || busy || runState.state !== "stopped"} on:click={() => perform(applyConfiguration)}>Apply import</button>
      {:else}
        <p>Preview the file against the current saved configuration before applying it.</p>
        <button disabled={!connected || busy} on:click={() => perform(previewConfiguration)}>Preview again</button>
      {/if}
      <button disabled={busy} on:click={clearImport}>Cancel import</button>
      <details><summary>View configuration JSON</summary><pre class="configuration-json">{JSON.stringify(importConfiguration, null, 2)}</pre></details>
    {/if}
  </section>
  <section>
    <h2>Conversations</h2>
    <label>Room <select bind:value={selectedRoom} on:change={() => { clearConfirmation = undefined; void loadHistory(selectedRoom); }}>{#each rooms as room}<option value={room.id}>{room.name}</option>{/each}</select></label>
    <p>{rooms.find(room => room.id === selectedRoom)?.description ?? ""}</p>
    <label>Clear saved messages from <select bind:value={clearScope} disabled={busy} on:change={() => { clearConfirmation = undefined; }}><option value="room">Current room</option><option value="all">All rooms</option></select></label>
    <button disabled={!connected || busy || runState.state !== "stopped" || (clearScope === "room" && !selectedRoom)} on:click={confirmClear}>Clear conversation</button>
    {#if runState.state !== "stopped"}<p>Choose Stop before clearing conversation history.</p>{/if}
    {#if clearConfirmation}
      <div role="group" aria-label="Confirm conversation clearing">
        <p>Permanently delete all saved messages in {clearConfirmation.label}? This cannot be undone. The messages will also be removed from agent conversation context. Rooms, agents and their settings will be kept.</p>
        <button disabled={!connected || busy || runState.state !== "stopped"} on:click={() => perform(clearHistory)}>Permanently delete messages</button>
        <button disabled={busy} on:click={() => { clearConfirmation = undefined; }}>Cancel clearing</button>
      </div>
    {/if}
    {#if older[selectedRoom]}<button disabled={!connected} on:click={() => loadHistory(selectedRoom, true)}>Load older messages</button>{/if}
    <ol class="conversation" aria-label="Conversation history">
      {#each histories[selectedRoom] ?? [] as item (item.id)}
        <li><strong>{item.speaker}</strong> <time datetime={item.createdAt}>{new Date(item.createdAt).toLocaleString()}</time><p>{item.content}</p></li>
      {:else}<li>No saved messages in this room yet.</li>{/each}
    </ol>
    <form on:submit|preventDefault={() => perform(async () => {
      await request<ConversationMessage>("config:message", { roomId: selectedRoom, message });
      message = ""; notice = "Message saved.";
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
  .configuration-json { max-height: 24rem; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; }
  time { font-size: 0.85rem; }
  [role="alert"] { color: #a21919; }
</style>
