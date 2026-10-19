<script lang="ts">
  import type { AppraisalRecord } from "@terrarium/shared";

  export let appraisal: AppraisalRecord;
</script>

<article aria-label="Appraisal evidence">
  <p><strong>{appraisal.observerName}</strong> → <strong>{appraisal.targetName}</strong> · {appraisal.reaction} · score after appraisal {appraisal.scoreAfter}</p>
  <p>{appraisal.reason}</p>
  <p>Appraisal {appraisal.id} · sequence {appraisal.sequence} · <time datetime={appraisal.createdAt}>{new Date(appraisal.createdAt).toLocaleString()}</time></p>
  <details>
    <summary>Saved source: {appraisal.source.speaker} · {appraisal.source.type} · {appraisal.source.id}</summary>
    <blockquote>{appraisal.source.content}</blockquote>
    <p>Actor {appraisal.source.agentId} · room {appraisal.source.roomId} · <time datetime={appraisal.source.createdAt}>{new Date(appraisal.source.createdAt).toLocaleString()}</time></p>
    {#if appraisal.source.replyToId}<p>Reply to {appraisal.source.replyToId} · exchange {appraisal.source.conversationId ?? appraisal.source.id}</p>{/if}
    <p>Observer {appraisal.observerId} · target {appraisal.targetAgentId}</p>
  </details>
</article>

<style>
  blockquote { margin: 0.5rem 1rem; white-space: pre-wrap; overflow-wrap: anywhere; }
  p { overflow-wrap: anywhere; }
</style>
