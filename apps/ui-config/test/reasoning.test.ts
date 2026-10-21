import { describe, expect, it } from 'vitest';
import { render } from 'svelte/server';
import type { ChatGptModel } from '@terrarium/shared';
import ReasoningSelect from '../src/ReasoningSelect.svelte';

const models: ChatGptModel[] = [
  { slug: 'one', displayName: 'One', defaultReasoningEffort: 'medium', supportedReasoningEfforts: [
    { effort: 'low', description: 'Faster' }, { effort: 'xhigh', description: '<script>Deep</script>' }] },
  { slug: 'two', displayName: 'Two', defaultReasoningEffort: 'low', supportedReasoningEfforts: [{ effort: 'low', description: 'Fast' }] },
];
describe('model-specific reasoning selector', () => {
  it('shows only the chosen model options, its default, and escaped selected guidance', () => {
    const html = render(ReasoningSelect, { props: { model: 'one', value: 'xhigh', models } }).body;
    expect(html).toContain('Model default');
    expect(html).not.toContain('Model default (');
    expect(html).toContain('Catalog default: Medium');
    expect(html).toContain('Extra high');
    expect(html).toContain('value="low"'); expect(html).toContain('value="xhigh"');
    expect(html).not.toContain('value="high"'); expect(html).not.toContain('value="ultra"');
    expect(html).toContain('&lt;script>Deep&lt;/script>'); expect(html).not.toContain('<script>');
  });
  it('retains an unsupported saved choice visibly without substituting a different strength', () => {
    const html = render(ReasoningSelect, { props: { model: 'two', value: 'xhigh', models } }).body;
    expect(html).toContain('Extra high (unavailable)'); expect(html).toContain('role="alert"');
    expect(html).toContain('not currently available for two');
  });
  it('offers only Model default when capability metadata is missing', () => {
    const html = render(ReasoningSelect, { props: { model: 'unknown', models } }).body;
    expect(html).toContain('Model default'); expect(html).toContain('options are unavailable');
    expect(html).not.toContain('value="low"'); expect(html).not.toContain('value="xhigh"');
  });
});
