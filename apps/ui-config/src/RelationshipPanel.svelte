<script lang="ts">
  import type { Agent, AppraisalPage, AppraisalRecord, RelationshipFilter, RelationshipPage, RelationshipState, RelationshipSummary, RelationshipSummaryPage } from "@terrarium/shared";
  import AppraisalEvidence from "./AppraisalEvidence.svelte";

  export let agents: Agent[];
  export let connected: boolean;
  export let stopped: boolean;
  export let refreshVersion = 0;
  export let request: <T>(event: string, payload: unknown) => Promise<T>;

  let observerId = "", targetAgentId = "";
  let filter: RelationshipFilter = {};
  let page: RelationshipPage = { relationships: [], hasMore: false };
  let before: number | undefined;
  let loading = false, detailLoading = false, resetting = false;
  let error = "", notice = "";
  let confirmReset = false;
  let selection: RelationshipState | undefined;
  let ledger: AppraisalPage = { appraisals: [], hasMore: false };
  let ledgerBefore: number | undefined;
  let summaries: RelationshipSummaryPage = { summaries: [], hasMore: false };
  let summaryBefore: number | undefined;
  let evidence: Record<string, AppraisalRecord> = {};
  let evidenceLoading: Record<string, boolean> = {};
  let summaryPreview: unknown = undefined;
  let previewLoading = false;
  let listSequence = 0, detailSequence = 0;

  function clearSelection() {
    detailSequence++; selection = undefined; ledger = { appraisals: [], hasMore: false };
    summaries = { summaries: [], hasMore: false }; ledgerBefore = undefined; summaryBefore = undefined;
    evidence = {}; evidenceLoading = {}; detailLoading = false;
    summaryPreview = undefined; previewLoading = false;
  }
  async function loadRelationships(cursor?: number) {
    if (!connected) return;
    const sequence = ++listSequence;
    loading = true; error = "";
    try {
      const result = await request<RelationshipPage>("relationships:list", { ...filter, limit: 25, ...(cursor ? { before: cursor } : {}) });
      if (sequence !== listSequence || !connected) return;
      page = result; before = cursor;
    } catch (failure) { if (sequence === listSequence) error = failure instanceof Error ? failure.message : "Could not load relationships."; }
    finally { if (sequence === listSequence) loading = false; }
  }
  async function loadDetails(pair: RelationshipState, appraisalCursor?: number, summaryCursor?: number) {
    const sequence = ++detailSequence;
    selection = pair; detailLoading = true; error = "";
    try {
      const payload = { observerId: pair.observerId, targetAgentId: pair.targetAgentId };
      const results = await Promise.all([
        request<AppraisalPage>("relationships:appraisals", { ...payload, limit: 25, ...(appraisalCursor ? { before: appraisalCursor } : {}) }),
        request<RelationshipSummaryPage>("relationships:summaries", { ...payload, limit: 10, ...(summaryCursor ? { beforeVersion: summaryCursor } : {}) }),
      ]);
      if (sequence !== detailSequence || !connected) return;
      [ledger, summaries] = results; ledgerBefore = appraisalCursor; summaryBefore = summaryCursor;
      const retained: Record<string, AppraisalRecord> = {};
      for (const summary of summaries.summaries) for (const id of summary.appraisalIds) if (evidence[id]) retained[id] = evidence[id];
      for (const appraisal of ledger.appraisals) retained[appraisal.id] = appraisal;
      evidence = retained;
    } catch (failure) { if (sequence === detailSequence) error = failure instanceof Error ? failure.message : "Could not load relationship evidence."; }
    finally { if (sequence === detailSequence) detailLoading = false; }
  }
  async function loadSummaryEvidence(summary: RelationshipSummary) {
    if (!connected || evidenceLoading[summary.id]) return;
    const sequence = detailSequence;
    evidenceLoading = { ...evidenceLoading, [summary.id]: true };
    try {
      const records = await Promise.all(summary.appraisalIds.filter(id => !evidence[id]).map(id => request<AppraisalRecord | null>("relationships:appraisal", { id })));
      if (sequence !== detailSequence || !connected) return;
      const loaded = { ...evidence };
      for (const record of records) {
        if (!record) throw new Error("Supporting appraisal no longer exists. Refresh the relationship view.");
        loaded[record.id] = record;
      }
      evidence = loaded;
    } catch (failure) { if (sequence === detailSequence) error = failure instanceof Error ? failure.message : "Could not load supporting evidence."; }
    finally { evidenceLoading = { ...evidenceLoading, [summary.id]: false }; }
  }
  async function previewSummary() {
    if (!connected || !selection) return;
    const sequence = detailSequence;
    previewLoading = true; error = "";
    try {
      const preview = await request<unknown>("relationships:preview", { observerId: selection.observerId, targetAgentId: selection.targetAgentId });
      if (sequence === detailSequence && connected) summaryPreview = preview;
    } catch (failure) { if (sequence === detailSequence) error = failure instanceof Error ? failure.message : "Could not preview summary request."; }
    finally { previewLoading = false; }
  }
  async function resetRelationships() {
    if (!connected || !stopped || !confirmReset) return;
    resetting = true; error = ""; notice = "";
    try {
      const result = await request<{ appraisals: number; relationships: number; summaries: number }>("relationships:reset", { confirm: true });
      confirmReset = false; clearSelection();
      await loadRelationships();
      notice = `Reset ${result.relationships} directional relationships, ${result.appraisals} appraisals and ${result.summaries} summaries. Generated private character state was cleared. Diagnostics and downloaded copies remain.`;
    } catch (failure) { error = failure instanceof Error ? failure.message : "Could not reset relationship memory."; }
    finally { resetting = false; }
  }
  function refresh() {
    summaryPreview = undefined;
    if (!before) void loadRelationships();
    if (selection && !ledgerBefore && !summaryBefore) void loadDetails(selection);
  }
  $: { refreshVersion; if (connected) refresh(); }
  $: if (!connected) { listSequence++; loading = false; page = { relationships: [], hasMore: false }; before = undefined; clearSelection(); confirmReset = false; }
  $: if (!stopped) confirmReset = false;
</script>

<section aria-label="Relationships and appraisal evidence">
  <h2>Relationships and appraisal evidence</h2>
  <p>Scores are directional: an observer's impression of another agent does not imply a reciprocal score. Each starts at zero and stays within −10 to +10. Only the observer receives its impressions in model context.</p>
  {#if error}<p role="alert">{error}</p>{/if}
  {#if notice}<p role="status">{notice}</p>{/if}
  <form on:submit|preventDefault={() => {
    filter = { ...(observerId.trim() ? { observerId: observerId.trim() } : {}), ...(targetAgentId.trim() ? { targetAgentId: targetAgentId.trim() } : {}) };
    clearSelection(); void loadRelationships();
  }}>
    <label>Observer ID (empty for all; deleted IDs supported) <input bind:value={observerId} list="relationship-agents" /></label>
    <label>Target agent ID (empty for all; deleted IDs supported) <input bind:value={targetAgentId} list="relationship-agents" /></label>
    <datalist id="relationship-agents">{#each agents as agent}<option value={agent.id}>{agent.name}</option>{/each}</datalist>
    <button disabled={!connected || loading || resetting}>Apply filters / latest relationships</button>
  </form>
  <ul aria-label="Directional relationship scores">
    {#each page.relationships as relationship (`${relationship.observerId}:${relationship.targetAgentId}`)}
      <li><strong>{relationship.observerName}</strong> → <strong>{relationship.targetName}</strong>: {relationship.score}
        <p>Updated <time datetime={relationship.updatedAt}>{new Date(relationship.updatedAt).toLocaleString()}</time>. Latest appraisal sequence {relationship.latestAppraisalSequence}.</p>
        {#if relationship.summary}<p>Latest summary: {relationship.summary.summary}</p>{:else}<p>No summary yet.</p>{/if}
        <button disabled={!connected || detailLoading || resetting} on:click={() => { clearSelection(); void loadDetails(relationship); }}>Inspect {relationship.observerName}'s impression of {relationship.targetName}</button>
      </li>
    {:else}<li>No recorded relationships match these filters.</li>{/each}
  </ul>
  {#if page.hasMore}<button disabled={!connected || loading || resetting} on:click={() => loadRelationships(page.next)}>Next 25 relationships</button>{/if}
  {#if before}<button disabled={!connected || loading || resetting} on:click={() => loadRelationships()}>Latest relationships</button>{/if}
  {#if selection}
    <h3>{selection.observerName} → {selection.targetName}</h3>
    <p>Observer {selection.observerId} · target {selection.targetAgentId}</p>
    <h4>Appraisal ledger</h4>
    <p>Reasons and complete source snapshots are retained even if conversation history is cleared. Scores are clamped after each accepted appraisal.</p>
    {#if detailLoading}<p>Loading relationship evidence…</p>{/if}
    <ol aria-label="Appraisal ledger">
      {#each ledger.appraisals as appraisal (appraisal.id)}<li><AppraisalEvidence {appraisal} /></li>{:else}<li>No appraisals on this page.</li>{/each}
    </ol>
    {#if ledger.hasMore}<button disabled={!connected || detailLoading || resetting} on:click={() => selection && loadDetails(selection, ledger.next, summaryBefore)}>Next 25 older appraisals</button>{/if}
    {#if ledgerBefore}<button disabled={!connected || detailLoading || resetting} on:click={() => selection && loadDetails(selection, undefined, summaryBefore)}>Latest appraisals</button>{/if}
    <h4>Summary versions</h4>
    <button disabled={!connected || detailLoading || previewLoading || resetting} on:click={previewSummary}>Preview summary request</button>
    <p>Read the current saved summary prompt and evidence without requesting a model. The preview is a snapshot; refresh it after settings or evidence change.</p>
    {#if summaryPreview === null}<p>No changed evidence currently needs summarizing.</p>
    {:else if summaryPreview !== undefined}<details><summary>Assembled summary context and provider payload</summary><pre>{JSON.stringify(summaryPreview, null, 2)}</pre></details>{/if}
    <ol aria-label="Relationship summary versions">
      {#each summaries.summaries as summary (summary.id)}
        <li><p>Version {summary.version} · <time datetime={summary.createdAt}>{new Date(summary.createdAt).toLocaleString()}</time> · through appraisal sequence {summary.throughSequence}</p>
          <p>{summary.summary}</p>
          <p>Summary {summary.id}. Previous summary: {summary.previousSummaryId ?? "None"}.</p>
          <details on:toggle={event => { if ((event.currentTarget as HTMLDetailsElement).open) void loadSummaryEvidence(summary); }}>
            <summary>Inspect {summary.appraisalIds.length} supporting appraisals</summary>
            {#if evidenceLoading[summary.id]}<p>Loading supporting evidence…</p>{/if}
            <ul>{#each summary.appraisalIds as id}
              <li>{#if evidence[id]}<AppraisalEvidence appraisal={evidence[id]} />{:else}<p>Appraisal {id}</p>{/if}</li>
            {/each}</ul>
            <button disabled={!connected || evidenceLoading[summary.id]} on:click={() => loadSummaryEvidence(summary)}>Refresh supporting evidence</button>
          </details>
        </li>
      {:else}<li>No summary versions on this page.</li>{/each}
    </ol>
    {#if summaries.hasMore}<button disabled={!connected || detailLoading || resetting} on:click={() => selection && loadDetails(selection, ledgerBefore, summaries.next)}>Next 10 older summary versions</button>{/if}
    {#if summaryBefore}<button disabled={!connected || detailLoading || resetting} on:click={() => selection && loadDetails(selection, ledgerBefore)}>Latest summary versions</button>{/if}
  {/if}
  <button disabled={!connected || !stopped || resetting} on:click={() => { confirmReset = true; }}>Reset relationship memory</button>
  {#if !stopped}<p>Choose Stop before resetting relationship memory.</p>{/if}
  {#if confirmReset}
    <div role="group" aria-label="Confirm relationship memory reset">
      <p>Permanently clear all appraisal evidence, directional scores and relationship summaries, plus generated private reactions, intentions and exchange subscriptions? This cannot be undone. Conversation history, agent profiles, last speech/emote times and diagnostics are kept. Use Clear diagnostics separately to remove stored diagnostic copies. Downloaded exports remain independent copies.</p>
      <button disabled={!connected || !stopped || resetting} on:click={resetRelationships}>Permanently reset relationship memory</button>
      <button disabled={resetting} on:click={() => { confirmReset = false; }}>Cancel relationship reset</button>
    </div>
  {/if}
</section>

<style>
  section { margin-bottom: 2rem; }
  form { display: grid; gap: 0.75rem; max-width: 40rem; }
  label { display: grid; gap: 0.25rem; }
  button, input { font: inherit; }
  button { width: fit-content; }
  p { overflow-wrap: anywhere; }
  pre { max-height: 24rem; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; }
  [role="alert"] { color: #a21919; }
</style>
