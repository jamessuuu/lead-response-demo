import { z } from 'zod';

/**
 * A loose reading of an n8n workflow export: enough structure to walk the
 * topology and render the parameters the engine understands. Unknown keys
 * are kept, never interpreted.
 */
export const N8nConnection = z.looseObject({
  node: z.string().min(1),
  type: z.string(),
  index: z.number().int(),
});

export const N8nNode = z.looseObject({
  id: z.string().min(1),
  name: z.string().min(1),
  type: z.string().min(1),
  typeVersion: z.number(),
  parameters: z.record(z.string(), z.unknown()).default({}),
  disabled: z.boolean().optional(),
  notes: z.string().optional(),
});
export type N8nNode = z.infer<typeof N8nNode>;

export const N8nWorkflow = z.looseObject({
  id: z.string().optional(),
  name: z.string().min(1),
  nodes: z.array(N8nNode).min(1),
  connections: z.record(
    z.string(),
    z.looseObject({ main: z.array(z.array(N8nConnection)).default([]) }),
  ),
});
export type N8nWorkflow = z.infer<typeof N8nWorkflow>;

export const STICKY_NOTE = 'n8n-nodes-base.stickyNote';
export const WEBHOOK = 'n8n-nodes-base.webhook';

export interface TopologyNode {
  id: string;
  name: string;
  type: string;
  typeVersion: number;
  disabled: boolean;
  parameters: Record<string, unknown>;
  notes: string | undefined;
}

export interface Topology {
  id: string;
  name: string;
  /** Executable nodes in traversal order: depth-first from the trigger, output 0 before output 1. */
  nodes: TopologyNode[];
  /** node name -> per-output list of downstream node names */
  outputs: Map<string, string[][]>;
  trigger: string;
}

export class TopologyError extends Error {
  override name = 'TopologyError';
}

/**
 * Parse a workflow export into an ordered topology. Sticky notes are dropped;
 * every other node must be reachable from the single webhook trigger, and
 * every connection must point at a node that exists.
 */
export function parseTopology(json: unknown): Topology {
  const wf = N8nWorkflow.parse(json);
  const executable = wf.nodes.filter((n) => n.type !== STICKY_NOTE);
  const byName = new Map<string, N8nNode>();
  for (const n of executable) {
    if (byName.has(n.name)) throw new TopologyError(`duplicate node name: ${n.name}`);
    byName.set(n.name, n);
  }
  const triggers = executable.filter((n) => n.type === WEBHOOK);
  if (triggers.length !== 1) {
    throw new TopologyError(`expected exactly one webhook trigger, found ${triggers.length}`);
  }
  const trigger = triggers[0] as N8nNode;

  const outputs = new Map<string, string[][]>();
  for (const [from, conn] of Object.entries(wf.connections)) {
    if (!byName.has(from)) throw new TopologyError(`connection from unknown node: ${from}`);
    const lists = conn.main.map((targets) =>
      targets.map((t) => {
        if (!byName.has(t.node)) throw new TopologyError(`connection to unknown node: ${t.node}`);
        return t.node;
      }),
    );
    outputs.set(from, lists);
  }

  const order: TopologyNode[] = [];
  const seen = new Set<string>();
  const visit = (name: string): void => {
    if (seen.has(name)) return;
    seen.add(name);
    const n = byName.get(name) as N8nNode;
    order.push({
      id: n.id,
      name: n.name,
      type: n.type,
      typeVersion: n.typeVersion,
      disabled: n.disabled === true,
      parameters: n.parameters,
      notes: n.notes,
    });
    for (const targets of outputs.get(name) ?? []) {
      for (const t of targets) visit(t);
    }
  };
  visit(trigger.name);

  const unreachable = executable.filter((n) => !seen.has(n.name)).map((n) => n.name);
  if (unreachable.length > 0) {
    throw new TopologyError(`nodes not reachable from the trigger: ${unreachable.join(', ')}`);
  }

  return { id: wf.id ?? 'unknown', name: wf.name, nodes: order, outputs, trigger: trigger.name };
}

/** The list the drift check compares against a run file's nodes. */
export interface NodeSignature {
  id: string;
  name: string;
  type: string;
  typeVersion: number;
}

export function nodeSignatures(topology: Topology): NodeSignature[] {
  return topology.nodes.map(({ id, name, type, typeVersion }) => ({ id, name, type, typeVersion }));
}

/** Read a string parameter or fail loudly. */
export function stringParam(node: TopologyNode, key: string): string {
  const v = node.parameters[key];
  if (typeof v !== 'string') throw new TopologyError(`${node.name}: parameter ${key} is not a string`);
  return v;
}

/** The Code node's source, for the hash pin in tests. */
export function jsCodeOf(topology: Topology, nodeName: string): string {
  const node = topology.nodes.find((n) => n.name === nodeName);
  if (!node) throw new TopologyError(`no node named ${nodeName}`);
  return stringParam(node, 'jsCode');
}
