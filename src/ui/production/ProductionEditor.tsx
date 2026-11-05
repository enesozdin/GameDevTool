import {
  applyNodeChanges,
  Background,
  Controls,
  MarkerType,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type IsValidConnection,
  type Node,
  type NodeChange,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useCallback, useLayoutEffect, useMemo, useState, type DragEvent } from "react";
import {
  addEdge,
  addNode,
  autoLayout,
  canConnect,
  compileCatalog,
  ConditionCompiler,
  compileNetwork,
  moveNodes,
  RATE_EPSILON,
  removeGraphElements,
  setEdgeRatio,
  solveNetwork,
  updateNode,
  type Change,
  type GraphNode,
  type Id,
  type IdGenerator,
  type Position,
  type ProductionGraphAsset,
  type Project,
  type SolveMode,
} from "../../core/index.ts";
import type { UiStrings } from "../strings.ts";
import { ProductionContext, type ProductionView } from "./context.ts";
import { formatRate } from "./format.ts";
import { Inspector } from "./Inspector.tsx";
import { DRAG_MIME, Library, type LibraryDrop } from "./Library.tsx";
import { inHandle, outHandle, ProductionNode } from "./ProductionNode.tsx";
import { Report } from "./Report.tsx";
import type { SimulationService } from "./simulation.ts";

export interface ProductionEditorProps {
  readonly strings: UiStrings;
  readonly project: Project;
  readonly graph: ProductionGraphAsset;
  readonly newId: IdGenerator;
  readonly commit: (change: Change | null) => void;
  readonly simulation: SimulationService;
}

const nodeTypes = { production: ProductionNode };
const HANDLE_PREFIX = 4; // "in:" / "out:" → item id after the prefix
const itemOfHandle = (handle: string | null | undefined): string | null => {
  if (typeof handle !== "string") return null;
  const colon = handle.indexOf(":");
  return colon < 0 || colon > HANDLE_PREFIX ? null : handle.slice(colon + 1);
};

export function ProductionEditor(props: ProductionEditorProps) {
  return (
    <ReactFlowProvider>
      <Editor {...props} />
    </ReactFlowProvider>
  );
}

function Editor({ strings, project, graph, newId, commit, simulation }: ProductionEditorProps) {
  const s = strings.production;
  const unit = project.manifest.settings.rateUnit;
  const [mode, setMode] = useState<SolveMode>("target");
  const flow = useReactFlow();

  // The catalog only depends on the three tables; other edits keep the same object.
  const find = (id: Id | undefined) => (id === undefined ? undefined : project.assets.find((a) => a.id === id));
  const itemsAsset = find(graph.items);
  const recipesAsset = find(graph.recipes);
  const machineColumn = recipesAsset?.kind === "table" && recipesAsset.role?.kind === "recipes" ? recipesAsset.columns.find((c) => c.id === (recipesAsset.role as { machine?: Id }).machine) : undefined;
  const machinesAsset = find(machineColumn?.type.kind === "reference" ? machineColumn.type.table : undefined);
  // Deliberately keyed on the three table objects (not the whole project): edits share
  // structure, so they change identity only when one of these tables is edited.
  const catalog = useMemo(() => compileCatalog(project, graph.recipes, graph.items), [itemsAsset, recipesAsset, machinesAsset, graph.recipes, graph.items]);
  const network = useMemo(() => compileNetwork(graph, catalog), [graph, catalog]);
  const result = useMemo(() => solveNetwork(network, mode), [network, mode]);
  // Variables change rarely; one compile cache per variable list.
  const conditions = useMemo(() => new ConditionCompiler(project.manifest.variables), [project.manifest.variables]);
  const nodesById = useMemo(() => new Map(graph.nodes.map((n) => [n.id, n])), [graph.nodes]);

  const view: ProductionView = useMemo(
    () => ({ strings, catalog, network, result, unit, nodes: nodesById, bottlenecks: new Set(result.bottlenecks) }),
    [strings, catalog, network, result, unit, nodesById],
  );

  // ---- Nodes: local React Flow state (drag positions, measured sizes, selection),
  // rebuilt from the graph whenever the graph changes.
  const [rfNodes, setRfNodes] = useState<Node[]>(() => toRfNodes(graph.nodes, []));
  useLayoutEffect(() => setRfNodes((prev) => toRfNodes(graph.nodes, prev)), [graph.nodes]);
  const [selectedEdges, setSelectedEdges] = useState<ReadonlySet<Id>>(new Set());

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    // Removal goes through onDelete (one undo step for nodes + edges).
    setRfNodes((nodes) => applyNodeChanges(changes.filter((c) => c.type !== "remove"), nodes));
  }, []);

  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    setSelectedEdges((prev) => {
      let next: Set<Id> | null = null;
      for (const c of changes) {
        if (c.type !== "select") continue;
        next ??= new Set(prev);
        if (c.selected) next.add(c.id);
        else next.delete(c.id);
      }
      return next ?? prev;
    });
  }, []);

  const onNodeDragStop = useCallback(
    (_: unknown, _node: Node, dragged: Node[]) => {
      const positions = new Map<Id, Position>(dragged.map((n) => [n.id, n.position]));
      commit(moveNodes(project, graph.id, positions));
    },
    [commit, project, graph.id],
  );

  const deleteSelection = useCallback(
    (nodeIds: Iterable<Id>, edgeIds: Iterable<Id>) => {
      commit(removeGraphElements(project, graph.id, new Set(nodeIds), new Set(edgeIds)));
      setSelectedEdges(new Set());
    },
    [commit, project, graph.id],
  );

  const isValidConnection: IsValidConnection = useCallback(
    (c) => {
      const item = itemOfHandle(c.sourceHandle);
      return item !== null && item === itemOfHandle(c.targetHandle) && canConnect(graph, catalog, c.source, c.target, item);
    },
    [graph, catalog],
  );

  const onConnect = useCallback(
    (c: Connection) => {
      const item = itemOfHandle(c.sourceHandle);
      if (item === null || item !== itemOfHandle(c.targetHandle) || !canConnect(graph, catalog, c.source, c.target, item)) return;
      commit(addEdge(project, graph.id, { id: newId(), source: c.source, target: c.target, item }));
    },
    [commit, project, graph, catalog, newId],
  );

  // ---- Edges: derived from the graph and the solution on every render.
  const rfEdges: Edge[] = useMemo(
    () =>
      graph.edges.map((e, i) => {
        const valid = network.edgeInPort[i]! >= 0;
        const f = result.edgeFlow[i]!;
        const inPort = network.edgeInPort[i]!;
        const short = valid && result.inRequired[inPort]! - result.inSupplied[inPort]! > RATE_EPSILON;
        return {
          id: e.id,
          source: e.source,
          target: e.target,
          sourceHandle: outHandle(e.item),
          targetHandle: inHandle(e.item),
          label: valid ? formatRate(f, unit, s.perUnit) : "!",
          selected: selectedEdges.has(e.id),
          className: !valid ? "pedge-invalid" : short ? "pedge-short" : f > RATE_EPSILON ? "pedge-flow" : "pedge-idle",
          markerEnd: { type: MarkerType.ArrowClosed },
        };
      }),
    [graph.edges, network, result, unit, s, selectedEdges],
  );

  // ---- Adding nodes from the library (click: centre of the view; drop: cursor).
  const addFromLibrary = (drop: LibraryDrop, at?: Position) => {
    const el = document.querySelector(".pcanvas");
    const rect = el?.getBoundingClientRect();
    const position = at ?? flow.screenToFlowPosition({ x: (rect?.left ?? 0) + (rect?.width ?? 0) / 2, y: (rect?.top ?? 0) + (rect?.height ?? 0) / 2 });
    const base = { id: newId(), position: { x: Math.round(position.x), y: Math.round(position.y) } };
    let node: GraphNode;
    if (drop.kind === "recipe") node = { ...base, type: "recipe", recipe: drop.recipe };
    else if (drop.type === "source") node = { ...base, type: "source", item: drop.item, rate: 0 };
    else if (drop.type === "gate") node = { ...base, type: "gate", item: drop.item, condition: "" };
    else node = { ...base, type: drop.type, item: drop.item };
    commit(addNode(project, graph.id, node));
  };

  const onDrop = (e: DragEvent) => {
    const data = e.dataTransfer.getData(DRAG_MIME);
    if (data === "") return;
    e.preventDefault();
    let drop: LibraryDrop;
    try {
      drop = JSON.parse(data) as LibraryDrop;
    } catch {
      return;
    }
    if (drop.kind === "recipe" ? !catalog.recipes.has(drop.recipe) : !catalog.items.has(drop.item)) return;
    addFromLibrary(drop, flow.screenToFlowPosition({ x: e.clientX, y: e.clientY }));
  };

  const selectedNodes = rfNodes.filter((n) => n.selected);
  const selectedNode = selectedNodes.length === 1 ? nodesById.get(selectedNodes[0]!.id) : undefined;
  const selectedEdge = selectedEdges.size === 1 ? graph.edges.find((e) => selectedEdges.has(e.id)) : undefined;

  if (catalog.itemsTable === undefined || catalog.recipesTable === undefined) {
    return <p className="field-error">{s.noTables}</p>;
  }

  return (
    <ProductionContext.Provider value={view}>
      <div className="peditor">
        <div className="toolbar" role="toolbar" aria-label={s.mode}>
          <div className="segmented" role="radiogroup" aria-label={s.mode}>
            <button type="button" role="radio" aria-checked={mode === "target"} className={mode === "target" ? "is-on" : undefined} title={s.modeTargetHint} onClick={() => setMode("target")}>
              {s.modeTarget}
            </button>
            <button type="button" role="radio" aria-checked={mode === "supply"} className={mode === "supply" ? "is-on" : undefined} title={s.modeSupplyHint} onClick={() => setMode("supply")}>
              {s.modeSupply}
            </button>
          </div>
          <button type="button" onClick={() => commit(moveNodes(project, graph.id, autoLayout(graph), "auto-layout"))}>
            {s.autoLayout}
          </button>
          <button type="button" onClick={() => void flow.fitView({ duration: 200 })}>
            {s.fitView}
          </button>
        </div>
        <div className="pbody">
          <aside className="pside">
            <Library strings={strings} catalog={catalog} onAdd={(d) => addFromLibrary(d)} />
          </aside>
          <div className="pcanvas" aria-label={s.canvasLabel} onDragOver={(e) => e.dataTransfer.types.includes(DRAG_MIME) && e.preventDefault()} onDrop={onDrop}>
            <ReactFlow
              nodes={rfNodes}
              edges={rfEdges}
              nodeTypes={nodeTypes}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onNodeDragStop={onNodeDragStop}
              onConnect={onConnect}
              isValidConnection={isValidConnection}
              onDelete={({ nodes, edges }) => deleteSelection(nodes.map((n) => n.id), edges.map((e) => e.id))}
              onlyRenderVisibleElements
              fitView
              minZoom={0.1}
              deleteKeyCode={["Delete", "Backspace"]}
              colorMode="system"
            >
              <Background />
              <Controls showInteractive={false} />
            </ReactFlow>
          </div>
          <aside className="pside">
            <Inspector
              strings={strings}
              catalog={catalog}
              conditions={conditions}
              unit={unit}
              node={selectedNode}
              edge={selectedEdge}
              selectionSize={selectedNodes.length + selectedEdges.size}
              onNodeChange={(id, fields) => commit(updateNode(project, graph.id, id, fields))}
              onEdgeRatio={(id, ratio) => commit(setEdgeRatio(project, graph.id, id, ratio))}
              onDelete={() => deleteSelection(selectedNodes.map((n) => n.id), selectedEdges)}
            />
            <Report strings={strings} project={project} graph={graph} catalog={catalog} network={network} result={result} unit={unit} selected={selectedNode} simulation={simulation} />
          </aside>
        </div>
      </div>
    </ProductionContext.Provider>
  );
}

/** Graph nodes → React Flow nodes, keeping measured size and selection of existing ones. */
function toRfNodes(nodes: readonly GraphNode[], prev: readonly Node[]): Node[] {
  const byId = new Map(prev.map((n) => [n.id, n]));
  return nodes.map((gn) => {
    const p = byId.get(gn.id);
    const rf: Node = { id: gn.id, type: "production", position: gn.position, data: {} };
    if (p?.selected) rf.selected = true;
    if (p?.measured) rf.measured = p.measured;
    return rf;
  });
}
