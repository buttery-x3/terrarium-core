import { describe, expect, it, vi } from 'vitest';
import { render } from 'svelte/server';
import type { AppraisalRecord } from '@terrarium/shared';
import AppraisalEvidence from '../src/AppraisalEvidence.svelte';
import RelationshipPanel from '../src/RelationshipPanel.svelte';

describe('relationship evidence rendering', () => {
  const appraisal: AppraisalRecord = {
    id: 'appraisal-1', sequence: 12, observerId: 'observer', observerName: 'Observer', targetAgentId: 'target', targetName: 'Saved target name',
    reaction: 'dislike', reason: 'The interruption bothered me.', createdAt: '2026-10-19T01:00:00.000Z', scoreAfter: -10,
    source: { id: 'source-1', roomId: 'room-2', agentId: 'target', speaker: 'Original speaker name', type: 'speak', createdAt: '2026-10-19T00:59:00.000Z', content: 'First line\nSecond line' },
  };
  it('shows directional identity and complete immutable evidence without relying on a current agent or archive', () => {
    const html = render(AppraisalEvidence, { props: { appraisal } }).body;
    expect(html).toContain('<strong>Observer</strong> → <strong>Saved target name</strong>');
    expect(html).toContain('score after appraisal -10');
    expect(html).toContain(appraisal.reason);
    expect(html).toContain('appraisal-1');
    expect(html).toContain('source-1');
    expect(html).toContain('Original speaker name');
    expect(html).toContain('First line\nSecond line');
    expect(html).toContain('room-2');
    expect(html).toContain('datetime="2026-10-19T00:59:00.000Z"');
    expect(html).toContain('Observer observer · target target');
  });
  it('escapes the generated appraisal reason and saved source content', () => {
    const html = render(AppraisalEvidence, { props: { appraisal: { ...appraisal,
      reason: '<script>reason</script>', source: { ...appraisal.source, content: '<img src=x onerror=alert(1)>' },
    } } }).body;
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;script>reason&lt;/script>');
    expect(html).toContain('&lt;img');
  });
  it('keeps destructive reset unavailable when disconnected or running', () => {
    const request = vi.fn();
    const html = render(RelationshipPanel, { props: { agents: [], connected: false, stopped: false, request } }).body;
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Reset relationship memory<\/button>/);
    expect(html).toContain('Choose Stop before resetting relationship memory.');
    expect(html).not.toContain('Permanently reset relationship memory');
    expect(request).not.toHaveBeenCalled();
  });
});
