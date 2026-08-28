import { describe, expect, it } from 'vitest';
import { REPLIED_CONDITION, TopologyError, evaluateReplied, nodeSignatures, parseTopology } from '../src/index.ts';
import { topology, workflowJson } from './fixtures.ts';

describe('parseTopology', () => {
  it('orders the 14 executable nodes depth-first from the trigger, output 0 before output 1', () => {
    expect(topology.trigger).toBe('Lead Webhook (form / ad)');
    expect(topology.nodes.map((n) => n.id)).toEqual([
      'node-webhook',
      'node-normalize',
      'node-enrich',
      'node-ghl-upsert',
      'node-ghl-sms',
      'node-ghl-email',
      'node-slack-notify',
      'node-sheets-log',
      'node-wait',
      'node-ghl-checkreply',
      'node-if-replied',
      'node-human-takeover',
      'node-voiceai-stub',
      'node-slack-escalate',
    ]);
  });

  it('drops sticky notes and keeps the disabled flag', () => {
    expect(topology.nodes.some((n) => n.type === 'n8n-nodes-base.stickyNote')).toBe(false);
    expect(topology.nodes.find((n) => n.id === 'node-enrich')?.disabled).toBe(true);
    expect(topology.nodes.filter((n) => n.disabled)).toHaveLength(1);
  });

  it('exposes both outputs of the If node', () => {
    expect(topology.outputs.get('Replied?')).toEqual([
      ['Replied — Human Takes Over'],
      ['Voice AI Callback (stub — configured in GHL)'],
    ]);
  });

  it('carries the workflow id and name', () => {
    expect(topology.id).toBe('SpeedToLead001');
    expect(topology.name).toBe('Speed-to-Lead — Radiant Aesthetics (demo)');
  });

  it('refuses a connection to an unknown node', () => {
    const broken = structuredClone(workflowJson) as { connections: Record<string, { main: Array<Array<{ node: string }>> }> };
    (broken.connections['Normalize Lead'] as { main: Array<Array<{ node: string }>> }).main[0]![0]!.node = 'Ghost';
    expect(() => parseTopology(broken)).toThrow(TopologyError);
  });

  it('refuses a node the trigger cannot reach', () => {
    const broken = structuredClone(workflowJson) as { nodes: Array<Record<string, unknown>> };
    broken.nodes.push({ id: 'orphan', name: 'Orphan', type: 'n8n-nodes-base.noOp', typeVersion: 1, parameters: {} });
    expect(() => parseTopology(broken)).toThrow(/not reachable/);
  });

  it('produces the signatures the drift check compares', () => {
    const sigs = nodeSignatures(topology);
    expect(sigs[0]).toEqual({ id: 'node-webhook', name: 'Lead Webhook (form / ad)', type: 'n8n-nodes-base.webhook', typeVersion: 2 });
    expect(sigs).toHaveLength(14);
  });
});

describe('Replied? mirror', () => {
  it('is pinned to the exact condition in workflow.json', () => {
    const ifNode = topology.nodes.find((n) => n.id === 'node-if-replied');
    const conditions = ifNode?.parameters.conditions as {
      options: { caseSensitive: boolean };
      conditions: Array<{ leftValue: string; rightValue: string; operator: { type: string; operation: string } }>;
      combinator: string;
    };
    expect(conditions.conditions).toHaveLength(1);
    const c = conditions.conditions[0]!;
    expect(c.leftValue).toBe(REPLIED_CONDITION.leftValue);
    expect(c.rightValue).toBe(REPLIED_CONDITION.rightValue);
    expect(c.operator).toEqual(REPLIED_CONDITION.operator);
    expect(conditions.options.caseSensitive).toBe(REPLIED_CONDITION.caseSensitive);
    expect(conditions.combinator).toBe('and');
  });

  it('evaluates like the node', () => {
    expect(evaluateReplied({ conversations: [{ lastMessageDirection: 'inbound' }] })).toMatchObject({ replied: true, outputIndex: 0 });
    expect(evaluateReplied({ conversations: [{ lastMessageDirection: 'INBOUND' }] }).replied).toBe(true);
    expect(evaluateReplied({ conversations: [{ lastMessageDirection: 'outbound' }] })).toMatchObject({ replied: false, outputIndex: 1, observed: 'outbound' });
    expect(evaluateReplied({ conversations: [] })).toMatchObject({ replied: false, observed: 'none' });
    expect(evaluateReplied({})).toMatchObject({ replied: false, observed: 'none' });
  });
});
