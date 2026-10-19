import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import type { MediaBallot, MediaProgramme } from '@terrarium/shared';
import MediaDisplay from '../src/MediaDisplay.svelte';
import MediaBallotDetails from '../src/MediaBallotDetails.svelte';
import ActivityItem from '../src/ActivityItem.svelte';

describe('movie and TV playback inspection', () => {
  const current: MediaProgramme = { id: 'programme-1', title: 'A movie title', description: 'An agent-supplied description.',
    proposerId: 'resident-a', proposerName: 'Resident A', startedAt: '2026-10-19T00:00:00.000Z' };
  const ballot: MediaBallot = {
    id: 'ballot-1', sequence: 1, roomId: 'media-room', proposerId: 'resident-b', proposerName: 'Resident B',
    title: 'A TV show', description: 'A different suggestion.', openedAt: '2026-10-19T00:01:00.000Z', remainingMs: 120000,
    electorateCount: 3, requiredChangeVotes: 2, programmeId: current.id, current, status: 'open', closedAt: null,
    votes: [
      { voterId: 'resident-a', voterName: 'Resident A', status: 'cast', choice: 'keep', votedAt: '2026-10-19T00:01:05.000Z', error: null },
      { voterId: 'resident-b', voterName: 'Resident B', status: 'pending', choice: null, votedAt: null, error: null },
      { voterId: 'resident-c', voterName: 'Resident C', status: 'invalid', choice: null, votedAt: null, error: 'Response was invalid.' },
    ], counts: { change: 0, keep: 1, abstain: 0, pending: 1, invalid: 1, missing: 0, withdrawn: 0, cancelled: 0 },
  };
  it('shows the authoritative remaining running time and escapes supplied descriptions', () => {
    const html = render(MediaDisplay, { props: { display: { current: { ...current, description: '<script>plot</script>' },
      remainingMs: 600000, ballot: null, cooldownRemainingMs: 0 } } }).body;
    expect(html).toContain(current.title);
    expect(html).toContain('Time remaining: 10:00');
    expect(html).toContain('Pause and Stop freeze playback.');
    expect(html).toContain('&lt;script>plot&lt;/script>');
    expect(html).not.toContain('<script>');
  });
  it('makes idle starts available without applying the replacement cooldown', () => {
    const html = render(MediaDisplay, { props: { display: { current: null, remainingMs: 0, ballot: null, cooldownRemainingMs: 300000 } } }).body;
    expect(html).toContain('Nothing is currently playing.');
    expect(html).toContain('without a vote while the screen is idle');
    expect(html).not.toContain('cooldown remaining');
  });
  it('does not promise idle playback while the media capability is disabled', () => {
    const html = render(MediaDisplay, { props: { enabled: false, display: { current: null, remainingMs: 0, ballot: null, cooldownRemainingMs: 0 } } }).body;
    expect(html).toContain('Nothing is currently playing.');
    expect(html).toContain('Enable media before residents can start');
    expect(html).not.toContain('without a vote while the screen is idle');
  });
  it('preserves the original electorate and distinguishes an invalid or pending vote from consent', () => {
    const html = render(MediaBallotDetails, { props: { ballot } }).body;
    expect(html).toContain('Requires 2 change votes from the original 3 enabled residents');
    expect(html).toContain('Change 0 · Keep 1 · Abstain 0 · Pending 1 · Invalid 1');
    expect(html).toContain('Operator-only individual votes');
    expect(html).toContain('Resident B');
    expect(html).toContain('No vote recorded');
    expect(html).toContain('Response was invalid.');
    expect(html).toContain('The proposer must cast a real vote.');
  });
  it('renders media announcements as room events distinct from speech and emotes', () => {
    const html = render(ActivityItem, { props: { item: { id: 'event-1', roomId: 'media-room', agentId: 'world-media',
      speaker: 'Media room', type: 'media', content: 'Nothing is currently playing.', createdAt: current.startedAt } } }).body;
    expect(html).toContain('data-event-type="media"');
    expect(html).toContain('Media room: Nothing is currently playing.');
    expect(html).not.toContain('<em>');
  });
});
