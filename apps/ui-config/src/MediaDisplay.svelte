<script lang="ts">
  import type { MediaDisplay } from "@terrarium/shared";

  export let display: MediaDisplay;
  export let enabled = true;
  const remaining = (milliseconds: number) => {
    const seconds = Math.ceil(Math.max(0, milliseconds) / 1000);
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  };
</script>

{#if display.current}
  <article aria-label="Current movie or TV show">
    <h3>{display.current.title}</h3>
    <p>{display.current.description}</p>
    <p>Time remaining: {remaining(display.remainingMs)} of running simulation time. Pause and Stop freeze playback.</p>
    <p>Suggested by {display.current.proposerName} · started <time datetime={display.current.startedAt}>{new Date(display.current.startedAt).toLocaleString()}</time></p>
  </article>
{:else}<p>Nothing is currently playing.</p>
  {#if enabled}<p>A resident can start a movie or TV show without a vote while the screen is idle.</p>
  {:else}<p>Enable media before residents can start a movie or TV show.</p>{/if}
{/if}
{#if display.current && display.cooldownRemainingMs > 0}<p>Replacement proposal cooldown remaining: {remaining(display.cooldownRemainingMs)}.</p>{/if}

<style>
  p { white-space: pre-wrap; overflow-wrap: anywhere; }
  h3 { overflow-wrap: anywhere; }
</style>
