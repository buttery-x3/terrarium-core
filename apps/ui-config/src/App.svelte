<script lang="ts">
  import { onMount } from "svelte";
  import { io } from "socket.io-client";
  import ActivityItem from "./ActivityItem.svelte";
  import AgentInspector from "./AgentInspector.svelte";
  import RelationshipPanel from "./RelationshipPanel.svelte";
  import NewsPanel from "./NewsPanel.svelte";
  import MediaPanel from "./MediaPanel.svelte";
  import ReasoningSelect from "./ReasoningSelect.svelte";
  import { actionSchema, configurationSchema, configurationFileLimitBytes, defaultSettings, defaultPrompts, type Settings, type DiagnosticRecord, type DiagnosticPage, type DiagnosticFilter, type DiagnosticUsage, type Configuration, type ConfigurationPreview } from "@terrarium/shared";
  import type { Agent, AgentInput, AuthState, ClearHistoryInput, ConversationMessage, HistoryCleared, HistoryCursor, HistoryPage, MediaState, ReflectionState, Result, Room, RunState, WorldState } from "@terrarium/shared";

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
  let models: import("@terrarium/shared").ChatGptModel[] = [];
  let modelRequest = 0;
  let roomId = "";
  let roomName = "";
  let roomDescription = "";
  let roomFoodSource = false;
  let agentId = "";
  let deleteAgentConfirmation: Agent | undefined;
  let agentName = "";
  let instructions = "";
  let motivations = "";
  let intention = "";
  let settings: Settings = structuredClone(defaultSettings);
  let activeSettings: Settings = structuredClone(defaultSettings);
  let settingsVersion = 0;
  let promptAgent = "";
  let promptOperation: "reflection" | "speech" | "emote" = "reflection";
  let promptPreview: { payload: { model: string; instructions: string; input: unknown; text: unknown }; constraints: string } | undefined;
  let reflections: ReflectionState[] = [];
  let reflectionRequest = 0;
  let relationshipVersion = 0;
  let newsVersion = 0;
  let mediaVersion = 0;
  let mediaState: MediaState | undefined;
  let mediaStateSequence = 0;
  let diagnosticAgent = "", diagnosticRoom = "", diagnosticAction = "", diagnosticOutcome = "", diagnosticFrom = "", diagnosticTo = "";
  let diagnosticPage: DiagnosticPage = { records: [], hasMore: false };
  let diagnosticBefore: number | undefined;
  let diagnosticLoading = false;
  let diagnosticDetails: Record<string, DiagnosticRecord> = {};
  let diagnosticUsage: DiagnosticUsage | undefined;
  let confirmDiagnosticClear = false;
  let agentRoom = "";
  let agentModel = "gpt-6-luna";
  let agentReasoningEffort: string | null = null;
  let enabled = false;
  let minimumSeconds = 10;
  let maximumSeconds = 30;
  const timingFields = [
    { key: "reflectionIntervalMs", label: "Reflection interval" },
    { key: "speechMinDelayMs", label: "Minimum speech delay" },
    { key: "speechMaxDelayMs", label: "Maximum speech delay" },
    { key: "speechCooldownMs", label: "Speech cooldown" },
    { key: "emoteMinIntervalMs", label: "Minimum emote interval" },
    { key: "emoteMaxIntervalMs", label: "Maximum emote interval" },
  ] as const;
  type TimingKey = typeof timingFields[number]["key"];
  let agentTimingSeconds: Partial<Record<TimingKey, number>> = {};
  let contextMessages = 30;
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
  function editRoom(room?: Room) { roomId = room?.id ?? ""; roomName = room?.name ?? ""; roomDescription = room?.description ?? ""; roomFoodSource = room?.isFoodSource ?? false; }
  function editAgent(agent?: Agent) {
    deleteAgentConfirmation = undefined;
    agentId = agent?.id ?? ""; agentName = agent?.name ?? ""; instructions = agent?.instructions ?? "";
    motivations = agent?.motivations ?? ""; intention = agent?.intention ?? "";
    agentRoom = agent?.roomId ?? selectedRoom; agentModel = agent?.model ?? "gpt-6-luna"; enabled = agent?.enabled ?? false;
    agentReasoningEffort = agent?.reasoningEffort ?? null;
    minimumSeconds = (agent?.minIntervalMs ?? 10000) / 1000; maximumSeconds = (agent?.maxIntervalMs ?? 30000) / 1000;
    agentTimingSeconds = {};
    for (const { key } of timingFields) if (agent?.timingOverrides?.[key] !== undefined) agentTimingSeconds[key] = agent.timingOverrides[key]! / 1000;
    contextMessages = agent?.contextMessageLimit ?? 30;
  }
  async function loadReflections() {
    if (!connected) return;
    const sequence = ++reflectionRequest;
    try {
      const states = await request<ReflectionState[]>("reflection:list", {});
      if (sequence === reflectionRequest && connected) reflections = states;
    } catch (failure) { if (sequence === reflectionRequest && connected) error = failure instanceof Error ? failure.message : "Could not load private character state."; }
  }
  async function loadMediaState() {
    const sequence = ++mediaStateSequence;
    try { const state = await request<MediaState>("media:state", {}); if (connected && sequence === mediaStateSequence) mediaState = state; }
    catch (failure) { if (connected && sequence === mediaStateSequence) error = failure instanceof Error ? failure.message : "Could not load media state."; }
  }
  async function deleteAgent() {
    if (!deleteAgentConfirmation) return;
    const agent = deleteAgentConfirmation;
    deleteAgentConfirmation = undefined;
    await request<{ id: string }>("agents:delete", { id: agent.id });
    if (agentId === agent.id) editAgent();
    notice = `Deleted agent “${agent.name}”. Existing conversation messages were kept.`;
  }
  async function discoverModels() {
    const sequence = ++modelRequest;
    try { const catalog = await request<typeof models>("auth:model-catalog", {}); if (sequence === modelRequest && connected && auth.connected) models = catalog; }
    catch (failure) { if (sequence === modelRequest) { models = []; error = failure instanceof Error ? failure.message : "Could not load ChatGPT models."; } }
  }
  function reasoningForChangedModel(model: string, effort: string | null | undefined): string | null {
    if (effort == null || models.find(item => item.slug === model)?.supportedReasoningEfforts?.some(item => item.effort === effort)) return effort ?? null;
    notice = `Reasoning strength reset to Model default for ${model}. Save to apply this change.`;
    return null;
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
  async function exportConversations() {
    const markdown = await request<string>("history:export", {});
    const url = URL.createObjectURL(new Blob([markdown], { type: "text/markdown;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url; link.download = "terrarium-conversations.md";
    document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    notice = "Conversations exported from all rooms.";
  }
  async function previewConfiguration() {
    importPreview = undefined;
    if (importConfiguration) importPreview = await request<ConfigurationPreview>("config:preview", importConfiguration);
  }
  async function previewNewsRoomSetup() {
    const configuration = await request<Configuration>("config:export", {});
    if (!configuration.rooms.some(room => room.id === "room-1")) throw new Error("Room room-1 does not exist. Choose a news room in shared settings instead.");
    const savedSettings = configuration.settings ?? activeSettings;
    importConfiguration = configurationSchema.parse({ ...configuration,
      rooms: configuration.rooms.map(room => room.id === "room-1" ? { ...room, name: "News Room",
        description: "A shared news display shows one current, sourced headline from varied topics. Residents can discuss what is on screen." } : room),
      settings: { ...savedSettings, news: { ...savedSettings.news, enabled: true, roomId: "room-1" } },
    });
    importFileName = "News Room setup";
    await previewConfiguration();
    notice = "News Room setup is ready under Configuration files. Review the preview, then choose Apply import to save it.";
  }
  async function previewMediaRoomSetup() {
    const configuration = await request<Configuration>("config:export", {});
    const savedSettings = configuration.settings ?? activeSettings;
    importConfiguration = configurationSchema.parse({ ...configuration,
      rooms: configuration.rooms.some(room => room.id === "media-room") ? configuration.rooms : [...configuration.rooms, {
        id: "media-room", name: "Media Room", isFoodSource: false,
        description: "Residents suggest movies or TV shows to watch together. The current title and description appear on the screen; replacing something already playing requires a local vote.",
      }], settings: { ...savedSettings, media: { ...savedSettings.media, enabled: true, roomId: "media-room" } },
    });
    importFileName = "Media Room setup";
    await previewConfiguration();
    notice = "Media Room setup is ready under Configuration files. Review the preview, then choose Apply import to save it.";
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
  function diagnosticFilter(): DiagnosticFilter {
    return { ...(diagnosticAgent ? { agentId: diagnosticAgent } : {}), ...(diagnosticRoom ? { roomId: diagnosticRoom } : {}),
      ...(diagnosticAction ? { action: diagnosticAction as NonNullable<DiagnosticFilter["action"]> } : {}),
      ...(diagnosticOutcome ? { outcome: diagnosticOutcome } : {}),
      ...(diagnosticFrom ? { from: new Date(diagnosticFrom).toISOString() } : {}),
      ...(diagnosticTo ? { to: new Date(diagnosticTo).toISOString() } : {}) };
  }
  async function loadDiagnostics(before?: number) {
    if (!connected || diagnosticLoading) return;
    diagnosticLoading = true;
    try {
      diagnosticPage = await request<DiagnosticPage>("diagnostics:list", { ...diagnosticFilter(), ...(before ? { before } : {}) });
      const retained: Record<string, DiagnosticRecord> = {};
      for (const record of diagnosticPage.records) if (diagnosticDetails[record.id]) retained[record.id] = diagnosticDetails[record.id];
      diagnosticDetails = retained;
      diagnosticBefore = before;
      diagnosticUsage = await request<DiagnosticUsage>("diagnostics:usage", {});
    } catch (failure) { error = failure instanceof Error ? failure.message : "Could not load diagnostics."; }
    finally { diagnosticLoading = false; }
  }
  async function exportDiagnostics() {
    const records: DiagnosticRecord[] = [];
    const filter = diagnosticFilter();
    const retentionAtStart = await request<DiagnosticUsage>("diagnostics:usage", {});
    let before: number | undefined;
    while (true) {
      const page = await request<DiagnosticPage>("diagnostics:export", { ...filter, limit: 10, ...(before ? { before } : {}) });
      records.push(...page.records);
      if (!page.hasMore) break;
      before = page.next;
    }
    const retentionAtEnd = await request<DiagnosticUsage>("diagnostics:usage", {});
    const retentionChangedDuringExport = retentionAtStart.pruneGeneration !== retentionAtEnd.pruneGeneration ||
      retentionAtStart.retention !== retentionAtEnd.retention || retentionAtStart.maxAgeMinutes !== retentionAtEnd.maxAgeMinutes ||
      retentionAtStart.limitBytes !== retentionAtEnd.limitBytes;
    const url = URL.createObjectURL(new Blob([JSON.stringify({ format: "terrarium-diagnostics", version: 1, exportedAt: new Date().toISOString(),
      filter, retentionAtStart, retentionAtEnd, retentionChangedDuringExport, records }, null, 2)], { type: "application/json" }));
    const link = document.createElement("a"); link.href = url; link.download = "terrarium-diagnostics.json";
    document.body.appendChild(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    notice = `Exported ${records.length} diagnostic records. ${retentionChangedDuringExport ? "Retention changed during export; records may have expired between pages, so this is not a complete snapshot. " : ""}Exported files retain their conversation snapshots independently.`;
  }
  async function loadDiagnostic(id: string) {
    try { diagnosticDetails = { ...diagnosticDetails, [id]: await request<DiagnosticRecord>("diagnostics:get", { id }) }; }
    catch (failure) {
      if (failure instanceof Error && failure.message.includes("no longer retained")) {
        notice = failure.message;
        await loadDiagnostics(diagnosticBefore);
      } else throw failure;
    }
  }
  onMount(() => {
    socket.on("connect", () => {
      connected = true;
      void loadDiagnostics();
      void loadReflections();
      void loadMediaState();
      // INVARIANT: reconnect discards caches that may have missed a conversation clear.
      histories = {}; older = {}; loaded.clear(); loading.clear();
      if (error === "Cannot connect to the local server. Check that pnpm dev is running.") error = "";
    });
    socket.on("disconnect", () => { connected = false; models = []; modelRequest++; auth = { ...auth, connected: false }; reflections = []; mediaState = undefined; mediaStateSequence++; reflectionRequest++; loading.clear(); importPreview = undefined; clearConfirmation = undefined; deleteAgentConfirmation = undefined; });
    socket.on("connect_error", () => { error = "Cannot connect to the local server. Check that pnpm dev is running."; });
    socket.on("world:state", (state: WorldState) => {
      importPreview = undefined;
      rooms = state.rooms; agents = state.agents;
      activeSettings = state.settings;
      if (state.settingsVersion !== settingsVersion) { settings = structuredClone(state.settings); settingsVersion = state.settingsVersion; promptPreview = undefined; }
      if (!agents.some(agent => agent.id === promptAgent)) { promptAgent = agents[0]?.id ?? ""; promptPreview = undefined; }
      if (!rooms.some(room => room.id === selectedRoom)) selectedRoom = rooms[0]?.id ?? "";
      if (!agentRoom) agentRoom = selectedRoom;
      if (agentId && !agents.some(agent => agent.id === agentId)) editAgent();
      if (deleteAgentConfirmation && !agents.some(agent => agent.id === deleteAgentConfirmation?.id && agent.revision === deleteAgentConfirmation.revision)) deleteAgentConfirmation = undefined;
      void loadHistory(selectedRoom);
    });
    socket.on("conversation:message", (item: ConversationMessage) => merge(item.roomId, [item]));
    socket.on("energy:state", (values: { id: string; energy: number }[]) => {
      const energy = new Map(values.map(item => [item.id, item.energy]));
      agents = agents.map(agent => ({ ...agent, energy: energy.get(agent.id) ?? agent.energy }));
    });
    socket.on("diagnostics:changed", () => { void loadDiagnostics(diagnosticBefore); });
    socket.on("reflection:changed", () => { void loadReflections(); });
    socket.on("relationships:changed", () => { relationshipVersion++; });
    socket.on("news:changed", () => { newsVersion++; });
    socket.on("media:state", (state: MediaState) => { mediaStateSequence++; mediaState = state; });
    socket.on("media:changed", () => { mediaVersion++; void loadMediaState(); });
    socket.on("conversation:cleared", (result: HistoryCleared) => {
      resetHistory(result.roomIds); clearConfirmation = undefined;
      void loadHistory(selectedRoom);
    });
    socket.on("run:state", (state: RunState) => { runState = state; if (state.state !== "stopped") clearConfirmation = undefined; });
    socket.on("auth:state", (state: AuthState) => {
      const newlyConnected = state.connected && !state.pending && (!auth.connected || auth.pending);
      auth = state; if (!state.pending) signInUrl = "";
      if (!state.connected || state.pending) { modelRequest++; models = []; }
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
    <p>Save rooms and agents as JSON, including instructions, model, timing, enabled state and current room. Conversation history, generated private character state and ChatGPT credentials stay separate.</p>
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
          {#each importPreview.defaults as detail}<li>{detail}</li>{/each}
          <li>Shared settings: {importPreview.settingsChanged ? "will update" : "unchanged"}. Existing current energy is preserved. Diagnostic retention may remove eligible completed records.</li>
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
    <button disabled={!connected || busy} on:click={() => perform(exportConversations)}>Export conversations</button>
    <p>Download all saved messages from every room as Markdown.</p>
    <label>Room <select bind:value={selectedRoom} on:change={() => { clearConfirmation = undefined; void loadHistory(selectedRoom); }}>{#each rooms as room}<option value={room.id}>{room.name}</option>{/each}</select></label>
    <p>{rooms.find(room => room.id === selectedRoom)?.description ?? ""}</p>
    <label>Clear saved messages from <select bind:value={clearScope} disabled={busy} on:change={() => { clearConfirmation = undefined; }}><option value="room">Current room</option><option value="all">All rooms</option></select></label>
    <button disabled={!connected || busy || runState.state !== "stopped" || (clearScope === "room" && !selectedRoom)} on:click={confirmClear}>Clear conversation</button>
    {#if runState.state !== "stopped"}<p>Choose Stop before clearing conversation history.</p>{/if}
    {#if clearConfirmation}
      <div role="group" aria-label="Confirm conversation clearing">
        <p>Permanently delete all saved messages in {clearConfirmation.label}? This cannot be undone. The messages will also be removed from agents' observed conversation memory. Rooms, agents and their settings will be kept. Generated private reactions, intentions, appraisal evidence and relationship summaries are retained and may still reflect this conversation. The current news display, selected-news history, media programmes, ballots and individual votes are retained. Affected exchange subscriptions are cleared. Use Reset relationship memory separately to clear relationship evidence and dependent private state. Diagnostic snapshots and downloaded exports may still contain this conversation. Use Clear diagnostics separately to remove stored diagnostic copies.</p>
        <button disabled={!connected || busy || runState.state !== "stopped"} on:click={() => perform(clearHistory)}>Permanently delete messages</button>
        <button disabled={busy} on:click={() => { clearConfirmation = undefined; }}>Cancel clearing</button>
      </div>
    {/if}
    {#if older[selectedRoom]}<button disabled={!connected} on:click={() => loadHistory(selectedRoom, true)}>Load older messages</button>{/if}
    <ol class="conversation" aria-label="Conversation history">
      {#each histories[selectedRoom] ?? [] as item (item.id)}
        <ActivityItem {item} />
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
    <ul>{#each rooms as room}<li>{room.name}{room.isFoodSource ? " · Food source" : ""} <button on:click={() => editRoom(room)}>Edit {room.name}</button></li>{/each}</ul>
    <button on:click={() => editRoom()}>New room</button>
    <form on:submit|preventDefault={() => perform(async () => {
      const saved = await request<Room>("rooms:save", { ...(roomId ? { id: roomId } : {}), name: roomName, description: roomDescription, isFoodSource: roomFoodSource });
      editRoom(saved); notice = "Room saved.";
    })}>
      <h3>{roomId ? "Edit room" : "Create room"}</h3>
      <label>Room name <input bind:value={roomName} maxlength="8000" required /></label>
      <label>Description <textarea bind:value={roomDescription} maxlength="8000"></textarea></label>
      <label><input type="checkbox" bind:checked={roomFoodSource} /> Provides unlimited food</label>
      <button disabled={!connected || busy}>Save room</button>
    </form>
  </section>
  <section>
    <h2>Agents</h2>
    <p>Each agent can have one active operation. Up to {runState.concurrency} requests run at once. Reflection, speech and emotes have independent schedules; an opportunity can produce no outward action.</p>
    <ul>{#each agents as agent}
      <li><strong>{agent.name}</strong> · {rooms.find(room => room.id === agent.roomId)?.name ?? agent.roomId} · {agent.enabled ? "Enabled" : "Disabled"}
        · Energy {agent.energy.toFixed(2)} / {activeSettings.energy.maximum}
        <button on:click={() => editAgent(agent)}>Edit {agent.name}</button>
        <button disabled={!connected || busy} on:click={() => { deleteAgentConfirmation = agent; }}>Delete {agent.name}</button>
        {#if deleteAgentConfirmation?.id === agent.id}
          <div role="group" aria-label="Confirm agent deletion">
        <p>Permanently delete agent “{deleteAgentConfirmation.name}” and its settings? Its active turn will be cancelled. Existing conversation messages and diagnostic records will be kept.</p>
            <button disabled={!connected || busy} on:click={() => perform(deleteAgent)}>Permanently delete agent</button>
            <button disabled={busy} on:click={() => { deleteAgentConfirmation = undefined; }}>Cancel deletion</button>
          </div>
        {/if}
        <AgentInspector {agent} {agents} reflection={reflections.find(item => item.agentId === agent.id)} activity={runState.agents.find(item => item.agentId === agent.id)} />
      </li>
    {:else}<li>No agents configured.</li>{/each}</ul>
    <button on:click={() => editAgent()}>New agent</button>
    <form on:submit|preventDefault={() => perform(async () => {
      const timingOverrides: NonNullable<AgentInput["timingOverrides"]> = {};
      for (const { key } of timingFields) if (agentTimingSeconds[key] !== undefined) timingOverrides[key] = Math.round(agentTimingSeconds[key]! * 1000);
      const input: AgentInput = { ...(agentId ? { id: agentId } : {}), name: agentName, instructions, motivations, intention, roomId: agentRoom,
        provider: "chatgpt", model: agentModel, reasoningEffort: agentReasoningEffort, enabled, minIntervalMs: Math.round(minimumSeconds * 1000),
        maxIntervalMs: Math.round(maximumSeconds * 1000), contextMessageLimit: contextMessages, timingOverrides };
      const saved = await request<Agent>("agents:save", input); if (agents.some(agent => agent.id === saved.id)) editAgent(saved); notice = "Agent saved.";
    })}>
      <h3>{agentId ? "Edit agent" : "Create agent"}</h3>
      <label>Agent name <input bind:value={agentName} maxlength="8000" required /></label>
      <label>Personality instructions <textarea bind:value={instructions} maxlength="8000" required rows="4"></textarea></label>
      <label>Motivations and preferences <textarea bind:value={motivations} maxlength="8000" rows="4"></textarea></label>
      <p>Interests, company or solitude, conversational preferences and tolerance for repetition. There is no boredom meter or forced movement timer.</p>
      <label>Current intention (optional) <textarea bind:value={intention} maxlength="1000" rows="2"></textarea></label>
      <p>An operator-configured immediate aim. Generated private reactions and intentions are saved separately and shown in the agent inspector.</p>
      <label>Current room <select bind:value={agentRoom} required>{#each rooms as room}<option value={room.id}>{room.name}</option>{/each}</select></label>
      <label>ChatGPT model <input bind:value={agentModel} list="chatgpt-models" required on:change={() => { agentReasoningEffort = reasoningForChangedModel(agentModel, agentReasoningEffort); }} /></label>
      <datalist id="chatgpt-models">{#each models as model}<option value={model.slug}>{model.displayName}</option>{/each}</datalist>
      <button type="button" disabled={!auth.connected || busy} on:click={discoverModels}>Refresh available models</button>
      <ReasoningSelect model={agentModel} bind:value={agentReasoningEffort} {models} />
      <p>This resident's strength applies to reflection, speech, emotes, relationship summaries and media votes. News has its own setting.</p>
      <h4>Timing overrides</h4>
      <p>Leave a field blank to inherit its saved shared setting. All values are seconds. These schedules replace the legacy interval between turns.</p>
      {#each timingFields as field}
        <label>{field.label} override (seconds)
          <input type="number" min="0.001" step="0.001" placeholder={String(activeSettings.scheduling[field.key] / 1000)} bind:value={agentTimingSeconds[field.key]} />
          <small>Shared setting: {activeSettings.scheduling[field.key] / 1000} seconds</small>
        </label>
      {/each}
      <details><summary>Legacy timing retained for configuration compatibility</summary><p>Saved legacy interval: {minimumSeconds}–{maximumSeconds} seconds. Superseded by reflection, speech and emote schedules.</p></details>
      <label>Personal memory limit <input type="number" min="1" max="50" bind:value={contextMessages} required /></label>
      <p>Keep this many personally observed speech and activity items across rooms. New agents start with empty memory; earlier room history is not included. Reducing the limit discards older observations.</p>
      <label><input type="checkbox" bind:checked={enabled} /> Enabled</label>
      <button disabled={!connected || busy}>Save agent</button>
    </form>
  </section>
  <RelationshipPanel {agents} {connected} stopped={runState.state === "stopped"} refreshVersion={relationshipVersion} {request} />
  <NewsPanel {connected} enabled={activeSettings.news.enabled} roomName={rooms.find(room => room.id === activeSettings.news.roomId)?.name ?? activeSettings.news.roomId} nextDueAt={runState.nextNewsAt} schedulerError={runState.newsError} refreshVersion={newsVersion} {request} />
  <MediaPanel {connected} enabled={activeSettings.media.enabled} roomName={rooms.find(room => room.id === activeSettings.media.roomId)?.name ?? activeSettings.media.roomId} state={mediaState} refreshVersion={mediaVersion} {request} />
  <section aria-label="Shared settings">
    <h2>Shared behaviour and energy</h2>
    <p>Saved settings version {settingsVersion}. Stop before saving changes. Prompt preview uses saved settings.</p>
    <p>Active energy rules: {activeSettings.energy.enabled ? "enabled" : "disabled"}; initial {activeSettings.energy.initial}; maximum {activeSettings.energy.maximum}; depletion {activeSettings.energy.depletionPerMinute} per running minute; low at {activeSettings.energy.lowThreshold} or below; meals fill to maximum.</p>
    <form on:submit|preventDefault={() => perform(async () => { await request("settings:save", settings); notice = "Shared settings saved."; })}>
      <h3>Reflection and action timing</h3>
      <p>Reflection updates private character state and may schedule speech or emotes. Due speech and emote opportunities use fresh local context. Remaining inactive is valid. Movement does not wait for speech eligibility; eating follows the energy and food-source rules below.</p>
      {#each timingFields as field}
        <label>{field.label} (seconds)
          <input type="number" min="0.001" step="0.001" value={settings.scheduling[field.key] / 1000} required on:input={event => { settings.scheduling[field.key] = Math.round(event.currentTarget.valueAsNumber * 1000); }} />
        </label>
      {/each}
      <label><input type="checkbox" bind:checked={settings.scheduling.engagementEnabled} /> Allow subscriptions to one local exchange per agent</label>
      <p>A reply in a subscribed exchange creates a speech opportunity subject to the speech cooldown. The agent may remain silent. Repeated triggers combine; reflection keeps its regular cadence. Leaving the exchange removes the subscription.</p>
      <h3>Relationship appraisals and summaries</h3>
      <label>Maximum appraisals per reflection <input type="number" min="0" max="5" step="1" bind:value={settings.relationships.maxAppraisalsPerReflection} required /></label>
      <label>Relationship summary interval (seconds) <input type="number" min="0.001" step="0.001" value={settings.relationships.summaryIntervalMs / 1000} required on:input={event => { settings.relationships.summaryIntervalMs = Math.round(event.currentTarget.valueAsNumber * 1000); }} /></label>
      <label>Maximum new appraisals per summary batch <input type="number" min="1" max="50" step="1" bind:value={settings.relationships.summaryBatchSize} required /></label>
      <p>Appraisals use witnessed speech or authored emotes from other agents. Zero disables new appraisals. Changed relationships are summarized from bounded evidence batches. An observer's score and summary remain private to that observer and the operator.</p>
      <h3>News selection</h3>
      <label><input type="checkbox" bind:checked={settings.news.enabled} /> Enable shared news selection</label>
      <label>News display room <select bind:value={settings.news.roomId}>{#each rooms as room}<option value={room.id}>{room.name}</option>{/each}</select></label>
      <label>News selection interval (seconds) <input type="number" min="0.001" step="0.001" value={settings.news.intervalMs / 1000} required on:input={event => { settings.news.intervalMs = Math.round(event.currentTarget.valueAsNumber * 1000); }} /></label>
      <label>News selection model <input bind:value={settings.news.model} list="chatgpt-models" required on:change={() => { settings.news.reasoningEffort = reasoningForChangedModel(settings.news.model, settings.news.reasoningEffort); }} /></label>
      <ReasoningSelect model={settings.news.model} bind:value={settings.news.reasoningEffort} {models} label="News reasoning strength" />
      <label>News topics (one per line, up to 12) <textarea rows="6" value={settings.news.topics.join("\n")} required on:change={event => { settings.news.topics = event.currentTarget.value.split(/\r?\n/).map(topic => topic.trim()).filter(Boolean); }}></textarea></label>
      <label>Recent headlines supplied for variety <input type="number" min="1" max="30" step="1" bind:value={settings.news.recentHeadlineLimit} required /></label>
      <p>One shared request selects a sourced headline for the assigned room. Topics and the editable news prompt guide variety; web search must be supported by the selected model and account. A failure retains the existing display.</p>
      <button type="button" disabled={!connected || busy || runState.state !== "stopped"} on:click={() => perform(previewNewsRoomSetup)}>Preview News Room setup</button>
      <p>Previews renaming room-1 to News Room, updating its description and enabling news there using the existing configuration import. Saved profiles, IDs and room history are retained. The preview uses saved configuration; save other edits first.</p>
      <h3>Movies and TV</h3>
      <label><input type="checkbox" bind:checked={settings.media.enabled} /> Enable movie and TV proposals</label>
      <label>Media room <select bind:value={settings.media.roomId}>
        {#if !rooms.some(room => room.id === settings.media.roomId)}<option value={settings.media.roomId}>{settings.media.roomId} (not created yet)</option>{/if}
        {#each rooms as room}<option value={room.id}>{room.name}</option>{/each}
      </select></label>
      <label>Playback duration (seconds of running simulation) <input type="number" min="0.001" step="0.001" value={settings.media.programmeDurationMs / 1000} required on:input={event => { settings.media.programmeDurationMs = Math.round(event.currentTarget.valueAsNumber * 1000); }} /></label>
      <label>Replacement vote deadline (running seconds) <input type="number" min="0.001" step="0.001" value={settings.media.ballotDurationMs / 1000} required on:input={event => { settings.media.ballotDurationMs = Math.round(event.currentTarget.valueAsNumber * 1000); }} /></label>
      <label>Replacement proposal cooldown (running seconds) <input type="number" min="0.001" step="0.001" value={settings.media.proposalCooldownMs / 1000} required on:input={event => { settings.media.proposalCooldownMs = Math.round(event.currentTarget.valueAsNumber * 1000); }} /></label>
      <p>Agents suggest a movie or TV title and short description from memory. Their recollections are simulation material; no catalogue lookup is required. Idle playback starts immediately. Replacements need a strict majority of the original enabled local residents. The cooldown never blocks starting an idle screen.</p>
      <button type="button" disabled={!connected || busy || runState.state !== "stopped"} on:click={() => perform(previewMediaRoomSetup)}>Preview Media Room setup</button>
      <p>Previews adding media-room if absent and enabling media there. Existing rooms and profiles are kept. Review and apply under Configuration files; the preview uses saved settings.</p>
      <h3>Observable activity</h3>
      <label><input type="checkbox" bind:checked={settings.activity.roomEventsEnabled} /> Record automatic room arrival and departure events</label>
      <label><input type="checkbox" bind:checked={settings.activity.emotesEnabled} /> Allow observable emote opportunities</label>
      <p>Movement events are observed only by residents present at the time, including the moving agent. Turning them off prevents new movement records. Other speech and emote observations continue.</p>
      <h3>Energy</h3>
      <label><input type="checkbox" bind:checked={settings.energy.enabled} /> Enable energy and eating</label>
      <label>Initial energy for new agents <input type="number" min="0" max={settings.energy.maximum} step="any" bind:value={settings.energy.initial} required /></label>
      <label>Maximum energy <input type="number" min="0.01" step="any" bind:value={settings.energy.maximum} required /></label>
      <label>Depletion per running minute <input type="number" min="0" step="any" bind:value={settings.energy.depletionPerMinute} required /></label>
      <label>Low energy at or below <input type="number" min="0" max={settings.energy.maximum} step="any" bind:value={settings.energy.lowThreshold} required /></label>
      <p>Eating requires enabled energy, a food-source current room, energy at or below the low threshold and energy below maximum. Meals fill to maximum. Decay freezes while paused, stopped, individually disabled or offline. Stop/restart preserves energy. Zero energy does not restrict movement or speech. At least one food-source room is required when enabled.</p>
      <h3>Shared prompt text</h3>
      <p>Each operation uses its applicable sections below, followed by resolved context and enforced protocol constraints. Preview the operation to inspect the exact request order. There is no hidden behavioural fallback.</p>
      {#each Object.keys(defaultPrompts) as name}
        {@const key = name as keyof typeof defaultPrompts}
        <label>{({ framing: "Role and framing", profiles: "Profile interpretation", actionSelection: "Action selection", energy: "Energy and food guidance", reminders: "Reminders", observations: "Personal observation guidance", emotes: "Observable emote guidance", reflection: "Private reflection guidance", appraisals: "Relationship appraisal guidance", relationshipSummary: "Relationship summary guidance", newsSelection: "News selection guidance", mediaParticipation: "Movie and TV participation guidance", mediaVote: "Media vote guidance" })[key]}
          <textarea rows="4" maxlength="8000" required={key !== "reminders"} bind:value={settings.prompts[key]}></textarea>
        </label>
        <button type="button" on:click={() => { settings.prompts[key] = defaultPrompts[key]; }}>Restore default {key}</button>
      {/each}
      <h3>Diagnostic retention</h3>
      <label>Diagnostic retention <select bind:value={settings.diagnostics.retention}><option value="rolling-time">Keep recent history</option><option value="rolling-size">Keep within a size target</option><option value="manual">Keep everything; pause at capacity</option></select></label>
      {#if settings.diagnostics.retention === "rolling-time"}
        <label>Keep completed history for (minutes) <input type="number" min="1" max="525600" step="1" bind:value={settings.diagnostics.maxAgeMinutes} required /></label>
        <p>Default: 30 minutes after a whole turn finishes, using wall-clock time including Pause and Stop. The size budget does not apply.</p>
      {:else}
        <label>Diagnostic payload {settings.diagnostics.retention === "manual" ? "budget" : "target"} (MiB) <input type="number" min="32" max="16384" step="1" bind:value={settings.diagnostics.maxPayloadMiB} required /></label>
      {/if}
      {#if settings.diagnostics.retention === "manual"}
        <p>No automatic deletion. Each active attempt reserves 8 MiB; the run pauses when the budget or an attempt's reservation is exceeded.</p>
      {:else}
        <p>Saving this policy allows automatic deletion of eligible existing records. Export anything you want to keep first. Cleanup removes whole completed turns, including all retries. Active requests keep their full evidence until they actually finish, even after cancellation; the size target may temporarily be exceeded. Diagnostic limits do not pause the simulation. A storage write failure can still pause it.</p>
      {/if}
      <p>Size measures saved diagnostic payloads plus a row allowance, not total database file size. Retention does not remove conversation history or downloaded exports.</p>
      <button disabled={!connected || busy || runState.state !== "stopped"}>Save shared settings</button>
    </form>
  </section>
  <section aria-label="Prompt preview">
    <h2>Assembled prompt preview</h2>
    <label>Preview agent <select bind:value={promptAgent} on:change={() => { promptPreview = undefined; }}>{#each agents as agent}<option value={agent.id}>{agent.name}</option>{/each}</select></label>
    <label>Preview operation <select bind:value={promptOperation} on:change={() => { promptPreview = undefined; }}><option value="reflection">Private reflection</option><option value="speech">Speech opportunity</option><option value="emote">Emote opportunity</option></select></label>
    <button disabled={!connected || busy || !promptAgent} on:click={() => perform(async () => { promptPreview = await request("prompt:preview", { agentId: promptAgent, operation: promptOperation }); })}>Preview saved prompt</button>
    <p>Preview reads current saved state without requesting a model or applying an operation. The payload shows Terrarium's instructions, input, model, any explicit reasoning strength and output schema. It does not show provider-internal instructions or reasoning.</p>
    {#if promptPreview}
      <p>Model: {promptPreview.payload.model}</p>
      <h3>Instructions in request order</h3>
      <pre class="configuration-json">{promptPreview.payload.instructions}</pre>
      <h3>Personal memory with observation metadata</h3>
      <pre class="configuration-json">{JSON.stringify(promptPreview.payload.input, null, 2)}</pre>
      <details><summary>Enforced protocol and output schema</summary><pre class="configuration-json">{promptPreview.constraints}\n\n{JSON.stringify(promptPreview.payload.text, null, 2)}</pre></details>
      <details><summary>Complete preview snapshot and provider payload</summary><pre class="configuration-json">{JSON.stringify(promptPreview, null, 2)}</pre></details>
    {/if}
  </section>
  <section aria-label="Decision diagnostics">
    <h2>Decision diagnostics</h2>
    <p>Operator-only history. Attempt 0 records scheduling and the overall operation; numbered attempts record requests. Reflection can update private character state without an outward action. Intention is generated character state, not a verified explanation.</p>
    {#if diagnosticUsage}
      <p>Stored payloads: {(diagnosticUsage.bytes / 1048576).toFixed(2)} MiB; protected active history: {(diagnosticUsage.protectedBytes / 1048576).toFixed(2)} MiB.
        {#if diagnosticUsage.retention === "manual"}Reserved: {(diagnosticUsage.reservedBytes / 1048576).toFixed(2)} MiB; budget: {diagnosticUsage.limitBytes / 1048576} MiB. Retained until explicitly cleared.
        {:else if diagnosticUsage.retention === "rolling-time"}Completed turns expire after {diagnosticUsage.maxAgeMinutes} wall-clock minutes, including while paused or stopped.
        {:else}Target: {diagnosticUsage.limitBytes / 1048576} MiB. Oldest completed turns are removed first; protected history can temporarily exceed the target.{/if}
      </p>
    {/if}
    <form on:submit|preventDefault={() => loadDiagnostics()}>
      <label>Agent ID (empty for all; deleted IDs supported) <input bind:value={diagnosticAgent} list="diagnostic-agents" /></label>
      <datalist id="diagnostic-agents">{#each agents as agent}<option value={agent.id}>{agent.name}</option>{/each}</datalist>
      <label>Decision room <select bind:value={diagnosticRoom}><option value="">All rooms</option>{#each rooms as room}<option value={room.id}>{room.name}</option>{/each}</select></label>
      <label>Action <select bind:value={diagnosticAction}><option value="">All actions</option>{#each ["speak", "emote", "move", "wait", "eat", "relationship-summary", "news", "propose-media", "media-vote"] as action}<option value={action}>{action}</option>{/each}</select></label>
      <label>Outcome <select bind:value={diagnosticOutcome}><option value="">All outcomes</option>{#each ["scheduled", "running", "completed", "applied", "applied-noop", "applied-notification-failure", "provider", "timeout", "parse", "schema", "world-validation", "persistence", "stale", "cancelled", "cancelled-before-start", "cancelled-no-vote", "vote-invalid", "vote-missing", "interrupted", "diagnostic-failure"] as outcome}<option value={outcome}>{outcome}</option>{/each}</select></label>
      <label>Scheduled from <input type="datetime-local" bind:value={diagnosticFrom} /></label>
      <label>Scheduled through <input type="datetime-local" bind:value={diagnosticTo} /></label>
      <button disabled={!connected || diagnosticLoading}>Apply filters / latest page</button>
    </form>
    <button disabled={!connected || busy} on:click={() => perform(exportDiagnostics)}>Export filtered diagnostics</button>
    <p>Export retrieves pages as they are available. Automatic retention continues during Pause, Stop and export; the download reports if cleanup changed the records during export. To keep a stable completed history, Stop and select “Keep everything” before exporting. Requests still finishing may update their records.</p>
    <button disabled={!connected || busy || runState.state !== "stopped"} on:click={() => { confirmDiagnosticClear = true; }}>Clear diagnostics</button>
    {#if confirmDiagnosticClear}
      <p>Permanently delete all stored diagnostic records and prompt/response snapshots? Conversation history and downloaded files remain. This cannot be undone.</p>
      <button disabled={!connected || busy || runState.state !== "stopped"} on:click={() => perform(async () => { await request("diagnostics:clear", { confirm: true }); confirmDiagnosticClear = false; diagnosticDetails = {}; await loadDiagnostics(); notice = "Stored diagnostics cleared."; })}>Permanently clear all diagnostics</button>
      <button on:click={() => { confirmDiagnosticClear = false; }}>Cancel diagnostic clearing</button>
    {/if}
    <ol aria-label="Activity records">
      {#each diagnosticPage.records as record (record.id)}
        <li><strong>{record.agentName}</strong> · {record.operation ?? "Legacy turn"} · {new Date(record.scheduledAt).toLocaleString()} · {record.roomId} · attempt {record.attempt} · {record.action ?? (record.attempt === 0 ? "Scheduling summary" : "No outward action")} · {record.outcome}
          <p>Requested {new Date(record.requestedAt ?? record.scheduledAt).toLocaleString()} · scheduled {new Date(record.scheduledAt).toLocaleString()} · due {new Date(record.dueAt).toLocaleString()} · started {record.startedAt ? new Date(record.startedAt).toLocaleString() : "not started"} · ended {record.endedAt ? new Date(record.endedAt).toLocaleString() : "pending"}</p>
          <details on:toggle={event => { if ((event.currentTarget as HTMLDetailsElement).open) void perform(() => loadDiagnostic(record.id)); }}>
            <summary>Inspect operation {record.turnId}, attempt {record.attempt}</summary>
            {#if diagnosticDetails[record.id]}
              {@const detail = diagnosticDetails[record.id].details}
              {@const proposedAction = actionSchema.safeParse((detail?.proposal as { action?: unknown } | undefined)?.action)}
              {#if detail?.energySeen !== undefined}<p>Energy seen by model: {detail.energySeen}. Before action: {detail.energyBefore ?? "not applied"}. After action: {detail.energyAfter ?? "not applied"}.</p>{/if}
              {#if proposedAction.success && proposedAction.data.type === "move"}
                <p>Proposed move: {record.roomId} → {proposedAction.data.roomId}. Outcome: {record.outcome}.</p>
                <p>Declared move reason: {detail?.moveReason ?? proposedAction.data.reason ?? "Not recorded."}</p>
                <p>This is the resident's declared purpose, not a verified explanation. It is visible only in diagnostics.</p>
              {/if}
              {#if detail?.sourceRoomId}<p>Applied location: {detail.sourceRoomId} → {detail.destinationRoomId}. {detail.moved ? "Location changed." : "Location unchanged."}</p>{/if}
              {#if detail?.optionalValidationErrors?.length}
                <p>Rejected optional items:</p>
                <ul>{#each detail.optionalValidationErrors as rejection}
                  <li>{rejection.field === "appraisals" ? `Appraisal ${(rejection.index ?? 0) + 1}` : "New engagement"}{rejection.sourceId ? ` (${rejection.sourceId})` : ""}: {rejection.error}</li>
                {/each}</ul>
              {/if}
              {#if detail?.selfReport}<p>Model self-report: {detail.selfReport}</p>{/if}
              {#if detail?.truncated}<p>Response capture is partial or incomplete. Capture limit: 4 MiB of provider stream data.</p>{/if}
              <pre class="configuration-json">{JSON.stringify(diagnosticDetails[record.id], null, 2)}</pre>
            {:else}<p>Loading details…</p>{/if}
          </details>
        </li>
      {:else}<li>No matching records.</li>{/each}
    </ol>
    {#if diagnosticPage.hasMore}<button disabled={diagnosticLoading} on:click={() => loadDiagnostics(diagnosticPage.next)}>Next 50 older records</button>{/if}
    {#if diagnosticBefore}<button disabled={diagnosticLoading} on:click={() => loadDiagnostics()}>Return to latest records</button>{/if}
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
  .configuration-json { max-height: 24rem; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; }
  [role="alert"] { color: #a21919; }
</style>
