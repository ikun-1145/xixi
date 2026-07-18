/**
 * Visualization contracts (Cytoscape-agnostic).
 *
 * The reasoning layer produces a plain GraphView; the graph module maps it to
 * Cytoscape elements. This keeps the rendering library swappable.
 */

export interface GraphNode {
  readonly id: string;
  readonly label: string;
  /** Highlighted when part of the current reasoning path. */
  readonly highlighted?: boolean;
}

export interface GraphEdge {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  readonly label: string;
  /** Negated relations (e.g. 企鹅 不会 飞) are styled differently. */
  readonly negated?: boolean;
  /** True when the edge was derived by the reasoner, not asserted directly. */
  readonly inferred?: boolean;
  readonly highlighted?: boolean;
}

export interface GraphView {
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
}
