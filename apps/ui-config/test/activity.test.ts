import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import type { ConversationMessage } from '@terrarium/shared';
import ActivityItem from '../src/ActivityItem.svelte';

describe('room activity rendering', () => {
  const base = { id: 'record-1', roomId: 'room-1', agentId: 'barry', speaker: 'Barry', createdAt: '2026-10-19T00:00:00.000Z', content: 'Barry watches the doorway.' };
  it.each(['emote', 'arrival', 'departure'] as const)('renders %s as attributed italic activity with inspectable identity', type => {
    const html = render(ActivityItem, { props: { item: { ...base, type } } }).body;
    expect(html).toContain(`<em>${base.content}</em>`);
    expect(html).toContain('<strong>Barry</strong>');
    expect(html).toContain(`data-event-type="${type}"`);
    expect(html).toContain('record-1');
    expect(html).toContain('room-1');
    expect(html).toContain(base.createdAt);
  });
  it('keeps speech distinct and escapes activity content and actor labels', () => {
    const speech = render(ActivityItem, { props: { item: { ...base, type: 'speak' } } }).body;
    expect(speech).not.toContain('<em>');
    const item: ConversationMessage = { ...base, type: 'emote', speaker: '<script>actor</script>', content: '<img src=x onerror=alert(1)>' };
    const activity = render(ActivityItem, { props: { item } }).body;
    expect(activity).not.toContain('<script>');
    expect(activity).not.toContain('<img');
    expect(activity).toContain('&lt;img');
  });
});
