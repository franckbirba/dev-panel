// src/worker/workflow-graph.js
// ADR-006 — graphe explicite + boucles bornées.
//
// Builds the internal { nodes, edges, loops } representation for a workflow
// document (either the legacy `steps:` shape or the new `nodes:`/`edges:`/
// `loops:` shape), and validates the central rule:
//
//   Every cycle in the graph MUST belong to a declared loop — one with
//   `until`, `max_iterations`, and `budget_tokens`. A cycle that escapes
//   every declared loop is rejected at load time, by name, so "why does
//   this loop?" becomes a question of reading the YAML instead of
//   archaeology on logs.
//
// Cycle detection is a real DFS over the edge graph (three-color: white /
// gray / black), not a heuristic — any back-edge (an edge into a node
// currently on the DFS stack) proves a cycle exists, and the DFS stack at
// that point IS the cycle.

/**
 * Build the { nodes, edges, loops } graph for a workflow document already
 * carrying either `steps:` (legacy) or `nodes:`/`edges:`/`loops:` (new).
 * Returns the graph; throws (with the flow name in the message) on any
 * validation failure.
 */
export function buildWorkflowGraph(doc) {
  const graph = Array.isArray(doc.steps)
    ? graphFromLegacySteps(doc)
    : graphFromNodesEdges(doc);

  validateNodeReferences(doc.name, graph);
  validateLoopDeclarations(doc.name, graph);
  validateCyclesAreDeclared(doc.name, graph);

  return graph;
}

/**
 * Le premier agent d'un workflow, quel que soit son format.
 *
 * Deux sites lisaient `flow.steps[0].agent` en dur (dispatch.js et
 * engine.js#maybeResumeParent) : un workflow au format graphe n'a pas de
 * `steps`, et ces appels jetteraient un TypeError au premier dispatch — la
 * review C8 a trouvé le second site, qui n'avait pas été signalé. Un seul
 * helper, pour qu'il n'y ait plus de site à oublier.
 *
 * Format graphe : le point d'entrée est le premier nœud déclaré (les nœuds
 * sont ordonnés dans le YAML, comme les steps l'étaient).
 */
export function firstAgentOf(flow) {
  if (Array.isArray(flow?.steps) && flow.steps.length) return flow.steps[0].agent;
  const nodes = flow?.graph?.nodes ?? flow?.nodes;
  if (Array.isArray(nodes) && nodes.length) return nodes[0].agent ?? nodes[0].id;
  throw new Error(
    `workflow ${flow?.name ?? '(sans nom)'}: aucun agent d'entrée (ni steps[0] ni nodes[0])`,
  );
}

// ---------------------------------------------------------------------
// New format: doc.nodes / doc.edges / doc.loops, taken close to verbatim.
// ---------------------------------------------------------------------
function graphFromNodesEdges(doc) {
  const nodes = Array.isArray(doc.nodes) ? doc.nodes.map(n => ({ ...n })) : [];
  const edges = Array.isArray(doc.edges) ? doc.edges.map(e => ({ ...e })) : [];
  const loops = Array.isArray(doc.loops) ? doc.loops.map(l => ({ ...l, _legacy: false })) : [];
  return { nodes, edges, loops };
}

// ---------------------------------------------------------------------
// Legacy format: doc.steps (list) with `on:` transitions. Converted to the
// same nodes/edges shape so ONE validator (and one engine execution path,
// eventually) covers both. Cycles found here are synthesized into an
// implicit, `_legacy: true` loop bounded by the existing `max_revisions` /
// `on_exhaustion` fields — this preserves current prod behavior for the 4
// shipped YAMLs exactly (see engine.js triggerNext, which still reads
// `flow.max_revisions` directly for legacy flows).
// ---------------------------------------------------------------------
function graphFromLegacySteps(doc) {
  const nodes = doc.steps.map(s => ({ id: s.agent, agent: s.agent }));
  const edges = [];
  for (const step of doc.steps) {
    for (const [status, branch] of Object.entries(step.on || {})) {
      if (!branch || !branch.next) continue; // terminal: no graph edge
      if (branch.workflow) continue; // cross-workflow jump (e.g. replan) — not an intra-graph edge
      edges.push({ from: step.agent, on: status, to: branch.next, when: branch.when || null });
    }
  }

  const cycles = findAllCycles({ nodes, edges });
  const loops = [];
  const seen = new Set();
  for (const cycle of cycles) {
    const bodySorted = [...cycle].sort();
    const key = bodySorted.join(',');
    if (seen.has(key)) continue;
    seen.add(key);
    loops.push({
      id: `legacy:${cycle.join('->')}`,
      body: cycle,
      until: null, // legacy exit is via predicate/on-branch shape, not a single `until`
      max_iterations: doc.max_revisions ?? null,
      budget_tokens: null, // legacy flows have no per-loop token budget (global only)
      on_exhaustion: doc.on_exhaustion || 'block',
      _legacy: true
    });
  }

  return { nodes, edges, loops };
}

// ---------------------------------------------------------------------
// Validation passes
// ---------------------------------------------------------------------
function validateNodeReferences(flowName, graph) {
  const ids = new Set(graph.nodes.map(n => n.id));
  for (const edge of graph.edges) {
    if (edge.terminal) continue;
    if (edge.workflow) continue; // cross-workflow jump — target lives in another flow
    if (!ids.has(edge.from)) {
      throw new Error(`workflow ${flowName}: edge references unknown node "${edge.from}" (from)`);
    }
    if (edge.to != null && !ids.has(edge.to)) {
      throw new Error(`workflow ${flowName}: edge references unknown node "${edge.to}" (to)`);
    }
  }
  for (const loop of graph.loops) {
    for (const nodeId of loop.body || []) {
      if (!ids.has(nodeId)) {
        throw new Error(
          `workflow ${flowName}: loop "${loop.id}" references unknown node "${nodeId}" in body`
        );
      }
    }
  }
}

function validateLoopDeclarations(flowName, graph) {
  for (const loop of graph.loops) {
    // Legacy-synthesized loops are bounded by max_revisions (translated
    // already) — they aren't "hand declared" so they're exempt from the
    // until/budget completeness check. Hand-authored loops (new format)
    // must be fully specified.
    if (loop._legacy) continue;

    if (!loop.until) {
      throw new Error(`workflow ${flowName}: loop "${loop.id}" is missing "until" (exit predicate)`);
    }
    if (loop.max_iterations == null) {
      throw new Error(`workflow ${flowName}: loop "${loop.id}" is missing "max_iterations"`);
    }
    if (!Number.isFinite(loop.max_iterations) || loop.max_iterations <= 0) {
      throw new Error(`workflow ${flowName}: loop "${loop.id}" has an invalid "max_iterations" (must be a positive number)`);
    }
    if (loop.budget_tokens == null) {
      throw new Error(`workflow ${flowName}: loop "${loop.id}" is missing "budget_tokens" (budget)`);
    }
    if (!Number.isFinite(loop.budget_tokens) || loop.budget_tokens <= 0) {
      throw new Error(`workflow ${flowName}: loop "${loop.id}" has an invalid "budget_tokens" (must be a positive number)`);
    }
    if (!Array.isArray(loop.body) || loop.body.length === 0) {
      throw new Error(`workflow ${flowName}: loop "${loop.id}" is missing a non-empty "body"`);
    }

    // The declaration must correspond to a REAL cycle among its body nodes
    // — otherwise it's a lie: bounds on a loop that can't actually repeat.
    const bodySet = new Set(loop.body);
    const cyclesAmongBody = findAllCycles({
      nodes: graph.nodes.filter(n => bodySet.has(n.id)),
      edges: graph.edges.filter(e => !e.terminal && bodySet.has(e.from) && bodySet.has(e.to))
    });
    if (cyclesAmongBody.length === 0) {
      throw new Error(
        `workflow ${flowName}: loop "${loop.id}" declares body [${loop.body.join(', ')}] but the edges ` +
        `among those nodes form no cycle — declaration does not match the graph`
      );
    }
  }
}

// Tout cycle du graphe doit être RÉELLEMENT compté par une boucle déclarée.
//
// Première version : « les nœuds du cycle sont un sous-ensemble du body ».
// Insuffisant, trouvé en review (2026-08-20) : le compteur d'itérations ne
// s'incrémente que sur le back-edge de la boucle (body[last] -> body[0], cf.
// engine.js#findLoopForTransition). Un cycle inclus dans le body mais passant
// par un AUTRE arc (typiquement un self-loop b->b dans un body [a,b])
// satisfaisait la règle tout en ne consommant jamais ni compteur ni budget —
// il retombait sur le garde-fou global max_revisions, pas sur la borne PAR
// BOUCLE que la spec promet. La lettre était respectée, pas l'intention.
//
// Règle durcie : un cycle est couvert si ses nœuds sont dans le body ET s'il
// emprunte le back-edge que le moteur compte effectivement.
function validateCyclesAreDeclared(flowName, graph) {
  const cycles = findAllCycles(graph);

  // Le cycle traverse-t-il l'arc from->to ? (le cycle est ordonné et sa
  // dernière transition reboucle sur le premier nœud)
  const cycleUsesEdge = (cycle, from, to) =>
    cycle.some((n, i) => n === from && cycle[(i + 1) % cycle.length] === to);

  for (const cycle of cycles) {
    const cycleSet = new Set(cycle);
    const covered = graph.loops.some((loop) => {
      const body = loop.body || [];
      const bodySet = new Set(body);
      if (![...cycleSet].every((n) => bodySet.has(n))) return false;
      // Les boucles legacy synthétisées gardent la sémantique globale
      // (max_revisions) — c'est leur contrat documenté, pas un back-edge.
      if (loop._legacy) return true;
      return cycleUsesEdge(cycle, body[body.length - 1], body[0]);
    });
    if (!covered) {
      throw new Error(
        `workflow ${flowName}: undeclared cycle detected among nodes [${cycle.join(' -> ')}] — ` +
        `every cycle must belong to a declared loop (with until, max_iterations, budget_tokens) ` +
        `AND go through that loop's counted back-edge (body[last] -> body[0])`
      );
    }
  }
}

// ---------------------------------------------------------------------
// DFS-based cycle detection (three-color algorithm), not a heuristic.
// Returns a list of cycles, each as an ordered array of node ids
// [n1, n2, ..., nk] where nk has an edge back to n1. De-duplicated by
// their node-set (a cycle found via two different entry points is the
// same cycle).
// ---------------------------------------------------------------------
export function findAllCycles({ nodes, edges }) {
  const adjacency = new Map();
  for (const n of nodes) adjacency.set(n.id, []);
  for (const e of edges) {
    if (e.terminal) continue;
    if (e.to == null) continue;
    if (!adjacency.has(e.from)) adjacency.set(e.from, []);
    adjacency.get(e.from).push(e.to);
  }

  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map([...adjacency.keys()].map(id => [id, WHITE]));
  const stack = [];
  const stackIndex = new Map();
  const cycles = [];
  const seenKeys = new Set();

  function visit(u) {
    color.set(u, GRAY);
    stack.push(u);
    stackIndex.set(u, stack.length - 1);

    for (const v of adjacency.get(u) || []) {
      if (!adjacency.has(v)) continue; // dangling edge — reported separately
      const c = color.get(v);
      if (c === WHITE) {
        visit(v);
      } else if (c === GRAY) {
        // Back-edge u -> v: the cycle is stack[stackIndex(v) .. end].
        const startIdx = stackIndex.get(v);
        const cycle = stack.slice(startIdx);
        const key = [...cycle].sort().join(',');
        if (!seenKeys.has(key)) {
          seenKeys.add(key);
          cycles.push(cycle);
        }
      }
      // BLACK: already fully explored, no new cycle through this edge.
    }

    stack.pop();
    stackIndex.delete(u);
    color.set(u, BLACK);
  }

  for (const id of adjacency.keys()) {
    if (color.get(id) === WHITE) visit(id);
  }

  return cycles;
}
