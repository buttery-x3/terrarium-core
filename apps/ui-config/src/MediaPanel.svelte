<script lang="ts">
  import type { MediaBallot, MediaBallotPage, MediaState } from "@terrarium/shared";
  import MediaDisplay from "./MediaDisplay.svelte";
  import MediaBallotDetails from "./MediaBallotDetails.svelte";

  export let connected: boolean;
  export let enabled: boolean;
  export let roomName: string;
  export let state: MediaState | undefined = undefined;
  export let refreshVersion = 0;
  export let request: <T>(event: string, payload: unknown) => Promise<T>;

  let history: MediaBallotPage = { ballots: [], hasMore: false };
  let before: number | undefined;
  let historyOpen = false, historyLoading = false, detailLoading = false, previewLoading = false;
  let selectedBallot: MediaBallot | null = null;
  let selectedId = "";
  let preview: unknown = undefined;
  let previewDetails: { agentId: string; ballotId: string; capturedAt: string } | undefined;
  let error = "";
  let historySequence = 0, detailSequence = 0, previewSequence = 0;
  $: selected = state?.activeBallot?.id === selectedId ? state.activeBallot : state?.lastBallot?.id === selectedId ? state.lastBallot : selectedBallot;

  async function loadHistory(cursor?: number) {
    if (!connected) return;
    const sequence = ++historySequence;
    historyLoading = true; error = "";
    try {
      const result = await request<MediaBallotPage>("media:ballots", { limit: 20, ...(cursor ? { before: cursor } : {}) });
      if (!connected || sequence !== historySequence) return;
      history = result; before = cursor;
    } catch (failure) { if (sequence === historySequence) error = failure instanceof Error ? failure.message : "Could not load media ballots."; }
    finally { if (sequence === historySequence) historyLoading = false; }
  }
  async function inspectBallot(id: string, clearPreview = true) {
    if (!connected) return;
    const sequence = ++detailSequence;
    selectedId = id; detailLoading = true; error = "";
    if (clearPreview) { preview = undefined; previewDetails = undefined; previewSequence++; previewLoading = false; }
    try {
      const result = await request<MediaBallot | null>("media:ballot", { id });
      if (!connected || sequence !== detailSequence) return;
      selectedBallot = result;
      if (!result) error = "This ballot is no longer available.";
    } catch (failure) { if (sequence === detailSequence) error = failure instanceof Error ? failure.message : "Could not inspect this ballot."; }
    finally { if (sequence === detailSequence) detailLoading = false; }
  }
  async function previewVote(agentId: string, ballotId: string) {
    const sequence = ++previewSequence;
    preview = undefined; previewDetails = undefined; previewLoading = true; error = "";
    try {
      const result = await request<unknown>("media:preview", { agentId, ballotId });
      if (connected && sequence === previewSequence) {
        preview = result; previewDetails = { agentId, ballotId, capturedAt: new Date().toISOString() };
      }
    } catch (failure) { if (sequence === previewSequence) error = failure instanceof Error ? failure.message : "Could not preview this vote request."; }
    finally { if (sequence === previewSequence) previewLoading = false; }
  }
  function refresh() {
    if (historyOpen && !before) void loadHistory();
    if (selectedId) void inspectBallot(selectedId, false);
  }
  $: { refreshVersion; if (connected) refresh(); }
  $: if (!connected) {
    historySequence++; detailSequence++; previewSequence++; historyLoading = false; detailLoading = false; previewLoading = false;
    history = { ballots: [], hasMore: false }; before = undefined; selectedBallot = null; selectedId = ""; preview = undefined; previewDetails = undefined;
  }
</script>

<section aria-label="Media room playback and votes">
  <h2>Media room playback and votes</h2>
  <p>{enabled ? `Movie and TV proposals enabled for ${roomName}.` : "Media proposals disabled."}</p>
  {#if error}<p role="alert">{error}</p>{/if}
  {#if state}<MediaDisplay display={state} {enabled} />{:else}<p>Media state is unavailable while disconnected or loading.</p>{/if}
  {#if state?.activeBallot}
    <h3>Active replacement vote</h3>
    <MediaBallotDetails ballot={state.activeBallot} {connected} previewing={previewLoading} onPreview={previewVote} />
  {:else if state}<p>No replacement vote is active.</p>{/if}
  {#if state?.lastBallot && state.lastBallot.id !== state.activeBallot?.id}
    <p>Last replacement vote: {state.lastBallot.title} · {state.lastBallot.status} · {state.lastBallot.counts.change}/{state.lastBallot.electorateCount} voted change.</p>
    <button disabled={!connected || detailLoading} on:click={() => state?.lastBallot && inspectBallot(state.lastBallot.id)}>Inspect last replacement vote</button>
  {/if}
  <details on:toggle={event => { historyOpen = (event.currentTarget as HTMLDetailsElement).open; if (historyOpen) void loadHistory(before); }}>
    <summary>Replacement vote history</summary>
    {#if historyLoading}<p>Loading ballots…</p>{/if}
    <ol>{#each history.ballots as ballot (ballot.id)}
      <li>{ballot.title} · {ballot.status} · {new Date(ballot.openedAt).toLocaleString()} · {ballot.counts.change}/{ballot.electorateCount} voted change
        <button disabled={!connected || detailLoading} on:click={() => inspectBallot(ballot.id)}>Inspect ballot {ballot.id}</button>
      </li>
    {:else}<li>No replacement ballots on this page.</li>{/each}</ol>
    {#if history.hasMore}<button disabled={!connected || historyLoading} on:click={() => loadHistory(history.next)}>Next 20 older ballots</button>{/if}
    {#if before}<button disabled={!connected || historyLoading} on:click={() => loadHistory()}>Latest ballots</button>{/if}
  </details>
  {#if detailLoading}<p>Loading ballot details…</p>{/if}
  {#if selected && selected.id !== state?.activeBallot?.id}
    <h3>Inspected replacement vote</h3>
    <MediaBallotDetails ballot={selected} {connected} previewing={previewLoading} onPreview={previewVote} />
  {/if}
  <p>Vote-request previews make no model request and cast no vote. Residents see the proposal and aggregate result; individual choices stay in operator inspection.</p>
  {#if previewDetails}<p>Captured vote-request snapshot for {previewDetails.agentId}, ballot {previewDetails.ballotId}, at {new Date(previewDetails.capturedAt).toLocaleString()}. Later votes and playback changes do not update this snapshot.</p>{/if}
  {#if preview === null}<p>No valid pending vote is currently available for that resident.</p>
  {:else if preview !== undefined}<details><summary>Assembled vote context and provider payload</summary><pre>{JSON.stringify(preview, null, 2)}</pre></details>{/if}
</section>

<style>
  section { margin-bottom: 2rem; }
  button { font: inherit; width: fit-content; }
  p { overflow-wrap: anywhere; }
  pre { max-height: 24rem; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; }
  [role="alert"] { color: #a21919; }
</style>
