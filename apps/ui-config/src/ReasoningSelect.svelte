<script lang="ts">
  import type { ChatGptModel } from "@terrarium/shared";

  export let model: string;
  export let value: string | null | undefined = null;
  export let models: ChatGptModel[] = [];
  export let label = "Reasoning strength";

  const strengthLabels: Record<string, string> = { low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max", ultra: "Ultra" };
  const strengthLabel = (effort: string) => strengthLabels[effort] ?? effort;

  $: selected = models.find(item => item.slug === model);
  $: levels = selected?.supportedReasoningEfforts ?? [];
  $: supported = value == null || levels.some(item => item.effort === value);
  $: description = levels.find(item => item.effort === value)?.description;
</script>

<label>{label}
  <select bind:value>
    <option value={null}>Model default</option>
    {#if !supported}<option value={value} disabled>{strengthLabel(value!)} (unavailable)</option>{/if}
    {#each levels as level}<option value={level.effort}>{strengthLabel(level.effort)}</option>{/each}
  </select>
</label>
{#if !supported}
  <p role="alert">The saved strength {value} is not currently available for {model}. Refresh available models or choose Model default before saving or running.</p>
{:else if selected?.supportedReasoningEfforts == null}
  <p>Reasoning options are unavailable for this model. Model default sends no strength override.</p>
{:else if !levels.length}
  <p>This model advertises no adjustable reasoning strength. Use Model default.</p>
{:else if description}
  <p>{description}</p>
{:else}
  <p>Model default leaves the strength to ChatGPT. An explicit choice applies to requests using this model.</p>
{/if}
{#if selected?.defaultReasoningEffort}<p>Catalog default: {strengthLabel(selected.defaultReasoningEffort)}. Model default sends no strength override.</p>{/if}
