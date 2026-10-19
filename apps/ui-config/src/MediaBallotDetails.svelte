<script lang="ts">
  import type { MediaBallot } from "@terrarium/shared";

  export let ballot: MediaBallot;
  export let connected = false;
  export let previewing = false;
  export let onPreview: ((agentId: string, ballotId: string) => void) | undefined = undefined;
</script>

<article aria-label="Media ballot details">
  <h4>Replace {ballot.current.title} with {ballot.title}</h4>
  <p>{ballot.description}</p>
  <details><summary>Original programme description</summary><p>{ballot.current.description}</p><p>Programme {ballot.programmeId}</p></details>
  <p>Proposed by {ballot.proposerName} · {ballot.status} · ballot {ballot.id}</p>
  <p>Requires {ballot.requiredChangeVotes} change votes from the original {ballot.electorateCount} enabled residents. The proposer must cast a real vote.</p>
  <p>Change {ballot.counts.change} · Keep {ballot.counts.keep} · Abstain {ballot.counts.abstain} · Pending {ballot.counts.pending} · Invalid {ballot.counts.invalid} · Missing {ballot.counts.missing} · Withdrawn {ballot.counts.withdrawn} · Cancelled {ballot.counts.cancelled}</p>
  <p>Opened <time datetime={ballot.openedAt}>{new Date(ballot.openedAt).toLocaleString()}</time>{#if ballot.closedAt} · closed <time datetime={ballot.closedAt}>{new Date(ballot.closedAt).toLocaleString()}</time>{:else} · {Math.ceil(Math.max(0, ballot.remainingMs) / 1000)} running seconds remaining{/if}</p>
  <details>
    <summary>Operator-only individual votes</summary>
    <p>Individual choices and request failures are visible only here and in diagnostics. Missing or invalid votes never count as agreement.</p>
    <div class="votes"><table>
      <thead><tr><th>Resident</th><th>Status</th><th>Choice</th><th>Recorded</th><th>Request</th></tr></thead>
      <tbody>{#each ballot.votes as vote (vote.voterId)}
        <tr><td>{vote.voterName}<br />{vote.voterId}</td><td>{vote.status}</td><td>{vote.choice ?? "No vote recorded"}</td>
          <td>{vote.votedAt ? new Date(vote.votedAt).toLocaleString() : "Not recorded"}</td>
          <td>{#if vote.error}<p>{vote.error}</p>{/if}
            {#if onPreview}<button disabled={!connected || previewing || ballot.status !== "open" || vote.status !== "pending"} on:click={() => onPreview?.(vote.voterId, ballot.id)}>Preview {vote.voterName}'s vote request</button>{/if}
          </td>
        </tr>
      {/each}</tbody>
    </table></div>
  </details>
</article>

<style>
  p, h4, td { overflow-wrap: anywhere; }
  .votes { overflow-x: auto; }
  th, td { text-align: left; vertical-align: top; padding: 0.35rem; }
  button { font: inherit; }
</style>
