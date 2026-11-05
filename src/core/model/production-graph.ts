import * as z from "zod/mini";
import { DescriptionSchema, IdSchema, NameSchema } from "./primitives.ts";

/**
 * Production chain layout (ROADMAP §4.1). Recipe, item and machine data live in tables
 * (roles "items", "recipes", "machines"); the graph only places nodes and connects them.
 *
 * Ports are identified by item: a connection carries one item from a node that outputs it
 * to a node that takes it as input. Rates are stored in items per second (SI); the UI shows
 * them per second, minute or hour (project setting).
 *
 * Node semantics follow Machinations: Source, Converter (recipe), Pool (storage),
 * Drain (sink), Gate.
 */

export const GRAPH_LIMITS = {
  nodes: 20_000,
  edges: 50_000,
  coordinate: 10_000_000,
  /** Items per second. */
  rate: 1e9,
  machines: 1e9,
} as const;

const coordinate = z.number().check(z.gte(-GRAPH_LIMITS.coordinate), z.lte(GRAPH_LIMITS.coordinate));
const rate = z.number().check(z.gte(0), z.lte(GRAPH_LIMITS.rate));

export const PositionSchema = z.object({ x: coordinate, y: coordinate });
export type Position = z.infer<typeof PositionSchema>;

const nodeBase = {
  id: IdSchema,
  position: PositionSchema,
  /** Optional display label; the item or recipe name is shown otherwise. */
  label: z.optional(NameSchema),
};

export const GraphNodeSchema = z.discriminatedUnion("type", [
  /** Raw resource: mining, harvesting, drops, spawn rates. `rate` = supply in items/s. */
  z.object({
    ...nodeBase,
    type: z.literal("source"),
    item: IdSchema,
    rate,
    /** "poisson": random arrivals around `rate` in Monte Carlo runs. Default "fixed". */
    distribution: z.optional(z.enum(["fixed", "poisson"])),
  }),
  /** Runs a recipe row. `machines`: built machine count (caps supply-driven output). */
  z.object({
    ...nodeBase,
    type: z.literal("recipe"),
    recipe: IdSchema,
    machines: z.optional(z.number().check(z.gte(0), z.lte(GRAPH_LIMITS.machines))),
  }),
  /** Buffer / inventory. Passes its item through in steady state. */
  z.object({
    ...nodeBase,
    type: z.literal("storage"),
    item: IdSchema,
    capacity: z.optional(z.number().check(z.gte(0), z.lte(1e15))),
  }),
  /** Consumption. `rate`: demand in items/s (the target in target-driven mode). */
  z.object({ ...nodeBase, type: z.literal("sink"), item: IdSchema, rate: z.optional(rate) }),
  /** Divides a flow by the `ratio` of its outgoing connections (equal when unset). */
  z.object({ ...nodeBase, type: z.literal("splitter"), item: IdSchema }),
  /** Combines flows of one item. */
  z.object({ ...nodeBase, type: z.literal("merger"), item: IdSchema }),
  /** Passes its item only once `condition` (expression language) holds. */
  z.object({ ...nodeBase, type: z.literal("gate"), item: IdSchema, condition: z.string().check(z.maxLength(10_000)) }),
]);
export type GraphNode = z.infer<typeof GraphNodeSchema>;
export type GraphNodeType = GraphNode["type"];

export const GraphEdgeSchema = z.object({
  id: IdSchema,
  source: IdSchema,
  target: IdSchema,
  /** Row id of the carried item. */
  item: IdSchema,
  /** Share of a splitter's output (relative weight). Ignored for other sources. */
  ratio: z.optional(z.number().check(z.gt(0), z.lte(1e6))),
});
export type GraphEdge = z.infer<typeof GraphEdgeSchema>;

export const ProductionGraphAssetSchema = z.object({
  id: IdSchema,
  kind: z.literal("production-graph"),
  name: NameSchema,
  description: z.optional(DescriptionSchema),
  /** Table with role "items". */
  items: IdSchema,
  /** Table with role "recipes". */
  recipes: IdSchema,
  nodes: z.array(GraphNodeSchema).check(z.maxLength(GRAPH_LIMITS.nodes)),
  edges: z.array(GraphEdgeSchema).check(z.maxLength(GRAPH_LIMITS.edges)),
});
export type ProductionGraphAsset = z.infer<typeof ProductionGraphAssetSchema>;

/** Node types whose `item` field names the one item they pass or hold. */
export function nodeItem(node: GraphNode): string | undefined {
  return node.type === "recipe" ? undefined : node.item;
}
