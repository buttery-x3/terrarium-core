<script lang="ts">
  import type { NewsItem } from "@terrarium/shared";

  export let item: NewsItem;
  function sourceLink(value: string) {
    try { const url = new URL(value); return ["http:", "https:"].includes(url.protocol) ? url.href : undefined; }
    catch { return undefined; }
  }
</script>

<article aria-label="Sourced news item">
  <h3>{item.headline}</h3>
  <p>{item.description}</p>
  <p>Topic: {item.category}</p>
  <p>{#if item.publishedAt}Published <time datetime={item.publishedAt}>{new Date(item.publishedAt).toLocaleString()}</time>{:else}Publication time not supplied.{/if}
    · Retrieved <time datetime={item.retrievedAt}>{new Date(item.retrievedAt).toLocaleString()}</time></p>
  <ul aria-label="News sources">{#each item.sourceUrls as source}
    {@const href = sourceLink(source)}
    <li>{#if href}<a {href} target="_blank" rel="noreferrer noopener">{source}</a>{:else}{source}{/if}</li>
  {/each}</ul>
  <details><summary>News identity</summary><p>{item.id} · sequence {item.sequence}</p></details>
</article>

<style>
  p { white-space: pre-wrap; overflow-wrap: anywhere; }
  a { overflow-wrap: anywhere; }
</style>
