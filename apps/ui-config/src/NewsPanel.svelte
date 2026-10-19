<script lang="ts">
  import type { NewsHistoryPage, NewsState } from "@terrarium/shared";
  import NewsItem from "./NewsItem.svelte";

  export let connected: boolean;
  export let enabled: boolean;
  export let roomName: string;
  export let nextDueAt: number | undefined = undefined;
  export let schedulerError: string | undefined = undefined;
  export let refreshVersion = 0;
  export let request: <T>(event: string, payload: unknown) => Promise<T>;

  let state: NewsState = { current: null, lastAttemptAt: null, lastSuccessAt: null, error: null };
  let history: NewsHistoryPage = { items: [], hasMore: false };
  let before: number | undefined;
  let historyOpen = false, historyLoading = false, previewLoading = false;
  let preview: unknown = undefined;
  let error = "";
  let stateSequence = 0, historySequence = 0, previewSequence = 0;

  async function loadState() {
    if (!connected) return;
    const sequence = ++stateSequence;
    try {
      const result = await request<NewsState>("news:state", {});
      if (connected && sequence === stateSequence) { state = result; error = ""; }
    } catch (failure) { if (sequence === stateSequence) error = failure instanceof Error ? failure.message : "Could not load news state."; }
  }
  async function loadHistory(cursor?: number) {
    if (!connected) return;
    const sequence = ++historySequence;
    historyLoading = true; error = "";
    try {
      const result = await request<NewsHistoryPage>("news:history", { limit: 20, ...(cursor ? { before: cursor } : {}) });
      if (!connected || sequence !== historySequence) return;
      history = result; before = cursor;
    } catch (failure) { if (sequence === historySequence) error = failure instanceof Error ? failure.message : "Could not load selected news history."; }
    finally { if (sequence === historySequence) historyLoading = false; }
  }
  async function previewNews() {
    const sequence = ++previewSequence;
    previewLoading = true; error = "";
    try {
      const result = await request<unknown>("news:preview", {});
      if (connected && sequence === previewSequence) preview = result;
    } catch (failure) { if (sequence === previewSequence) error = failure instanceof Error ? failure.message : "Could not preview news selection."; }
    finally { if (sequence === previewSequence) previewLoading = false; }
  }
  function refresh() {
    preview = undefined; previewSequence++; previewLoading = false;
    void loadState();
    if (historyOpen && !before) void loadHistory();
  }
  $: { refreshVersion; if (connected) refresh(); }
  $: if (!connected) {
    stateSequence++; historySequence++; previewSequence++; historyLoading = false; previewLoading = false;
    state = { current: null, lastAttemptAt: null, lastSuccessAt: null, error: null };
    history = { items: [], hasMore: false }; before = undefined; preview = undefined;
  }
</script>

<section aria-label="News display">
  <h2>News display</h2>
  <p>{enabled ? `News selection enabled for ${roomName}.` : "News selection disabled."} Next selection: {nextDueAt === undefined ? "Not scheduled" : new Date(nextDueAt).toLocaleString()}.</p>
  <p>Selections use web-search evidence and recent headlines to seek a varied topic. Failed or repeated candidates leave the current headline unchanged.</p>
  {#if error}<p role="alert">{error}</p>{/if}
  {#if state.error}<p role="alert">Last selection failed: {state.error}</p>{/if}
  {#if schedulerError && schedulerError !== state.error}<p role="alert">News scheduling: {schedulerError}</p>{/if}
  <p>Last attempt: {state.lastAttemptAt ? new Date(state.lastAttemptAt).toLocaleString() : "None"}. Last successful check: {state.lastSuccessAt ? new Date(state.lastSuccessAt).toLocaleString() : "None"}.</p>
  {#if state.current}<NewsItem item={state.current} />{:else}<p>No headline has been selected yet.</p>{/if}
  <button disabled={!connected || previewLoading} on:click={previewNews}>Preview news request</button>
  <p>Preview uses saved settings and current/recent headlines. It makes no model or search request.</p>
  {#if preview !== undefined}<details><summary>Assembled news context and provider payload</summary><pre>{JSON.stringify(preview, null, 2)}</pre></details>{/if}
  <details on:toggle={event => { historyOpen = (event.currentTarget as HTMLDetailsElement).open; if (historyOpen) void loadHistory(before); }}>
    <summary>Selected news history</summary>
    {#if historyLoading}<p>Loading selected headlines…</p>{/if}
    <ol>{#each history.items as item (item.id)}<li><NewsItem {item} /></li>{:else}<li>No selected headlines on this page.</li>{/each}</ol>
    {#if history.hasMore}<button disabled={!connected || historyLoading} on:click={() => loadHistory(history.next)}>Next 20 older headlines</button>{/if}
    {#if before}<button disabled={!connected || historyLoading} on:click={() => loadHistory()}>Latest selected headlines</button>{/if}
  </details>
</section>

<style>
  section { margin-bottom: 2rem; }
  button { font: inherit; width: fit-content; }
  pre { max-height: 24rem; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; }
  [role="alert"] { color: #a21919; }
</style>
