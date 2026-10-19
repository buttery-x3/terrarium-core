import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import type { Agent, ReflectionState } from '@terrarium/shared';
import AgentInspector from '../src/AgentInspector.svelte';

describe('private character state inspector', () => {
  const agent: Agent = {
    id: 'resident-a', revision: 1, name: 'Resident A', instructions: 'Observe', motivations: '', intention: '',
    roomId: 'room-1', provider: 'chatgpt', model: 'fake', enabled: true, minIntervalMs: 60000,
    maxIntervalMs: 150000, contextMessageLimit: 30, energy: 100,
  };
  const reflection: ReflectionState = {
    agentId: agent.id, reflectedAt: '2026-10-19T00:00:00.000Z', reaction: '<script>reaction</script>', intention: 'Listen quietly',
    lastSpeechAt: null, lastEmoteAt: null, engagement: { roomId: 'room-1', rootMessageId: 'speech-1', targetAgentId: 'resident-b' },
  };
  it('shows saved character state and separate schedules without presenting absent opportunities as due', () => {
    const html = render(AgentInspector, { props: {
      agent, agents: [agent, { ...agent, id: 'resident-b', name: 'Resident B' }, { ...agent, id: 'resident-c', name: 'Remote resident', roomId: 'room-2' }],
      reflection, activity: { agentId: agent.id, state: 'scheduled', operation: 'reflection', nextReflectionAt: 1792368000000, nextEmoteAt: 1792368120000 },
    } }).body;
    expect(html).toContain('Current room occupants: Resident A, Resident B');
    expect(html).not.toContain('Remote resident');
    expect(html).toContain('Generated private character state');
    expect(html).toContain('datetime="2026-10-19T00:00:00.000Z"');
    expect(html).toContain('Next reflection');
    expect(html).toMatch(/Next speech opportunity<\/dt><dd[^>]*>None<\/dd>/);
    expect(html).toContain('Next emote opportunity');
    expect(html).toContain('Listen quietly');
    expect(html).toContain('speech-1');
    expect(html).toContain('Interlocutor: Resident B');
    expect(html).toContain('&lt;script>reaction&lt;/script>');
    expect(html).not.toContain('<script>');
  });
  it('distinguishes no generated state and no schedule after a stop or reconnect', () => {
    const html = render(AgentInspector, { props: { agent, agents: [agent], reflection: { ...reflection, reflectedAt: null, reaction: null, intention: null, engagement: null } } }).body;
    expect(html).toContain('No operations scheduled.');
    expect(html).toContain('No generated private character state yet.');
    expect(html).toContain('No local exchange subscription.');
    expect(html).not.toContain('Invalid Date');
    expect(html).not.toContain('Listen quietly');
  });
});
