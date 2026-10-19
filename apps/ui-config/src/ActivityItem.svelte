<script lang="ts">
  import type { ConversationMessage } from "@terrarium/shared";
  export let item: ConversationMessage;
</script>

<li data-event-type={item.type} title={`Record ${item.id} · ${item.roomId}`}>
  <strong>{item.speaker}</strong> · {item.type}
  <time datetime={item.createdAt}>{new Date(item.createdAt).toLocaleString()}</time>
  <p>{#if item.type === "speak"}{item.content}{:else}<em>{item.content}</em>{/if}</p>
</li>

<style>
  p { white-space: pre-wrap; overflow-wrap: anywhere; }
  time { font-size: 0.85rem; }
</style>
