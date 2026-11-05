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
import { useCallback, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import {
  addEdge,
  addNode,
  autoLayout,
  canConnect,
  commonContainer,
  compileCatalog,
  descendantNodes,
  groupElements,
  groupGeometry,
  groupStructure,
  inputKeyFor,
  shownEdges,
  summarizeCollapsed,
  ungroup,
  updateGroup,
  ConditionCompiler,
  evaluateGates,
  scenarioValues,
  resetScenario,
  setScenarioAllOpen,
  setScenarioValue,
  compileNetwork,
  moveNodes,
  RATE_EPSILON,
  removeGraphElements,
  setEdgeRatio,
  solveNetwork,
  updateNode,
  type Change,
  type GraphNode,
  type GroupStructure,
  type Id,
  type IdGenerator,
  type Position,
  type ProductionGraphAsset,
  type Project,
  type SolveMode,
  type Value,
} from "../../core/index.ts";

const NO_OVERRIDES: Readonly<Record<Id, Value>> = {};
import type { UiStrings } from "../strings.ts";
import { ProductionContext, type ProductionView } from "./context.ts";
import { formatRate } from "./format.ts";
import { Inspector } from "./Inspector.tsx";
import { DRAG_MIME, Library, type LibraryDrop } from "./Library.tsx";
import { GroupFrame, GroupNode } from "./GroupNode.tsx";
import { inHandle, outHandle, ProductionNode } from "./ProductionNode.tsx";
import { Report } from "./Report.tsx";
import { Scenario } from "./Scenario.tsx";
import type { SimulationService } from "./simulation.ts";

export interface ProductionEditorProps {
  readonly strings: UiStrings;
  readonly project: Project;
  readonly graph: ProductionGraphAsset;
  readonly newId: IdGenerator;
  readonly commit: (change: Change | null) => void;
  readonly simulation: SimulationService;
}

const nodeTypes = { production: ProductionNode, pgroup: GroupNode, pframe: GroupFrame };
/** Size used for frames before React Flow has measured a node. */
const DEFAULT_SIZE = { width: 260, height: 140 } as const;
/** Frames stay below nodes, even when selected (React Flow adds 1000 to selected nodes). */
const FRAME_Z = -2000;
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
  // Variables change rarely; one compile cache per variable list.
  const variables = project.manifest.variables;
  const conditions = useMemo(() => new ConditionCompiler(variables), [variables]);
  // Scenario: what-if variable values for gates (start values + saved overrides).
  const overrides = graph.scenario?.values;
  const allOpen = graph.scenario?.allOpen === true;
  const values = useMemo(() => scenarioValues(conditions, variables, overrides), [conditions, variables, overrides]);
  const gates = useMemo(() => evaluateGates(graph, catalog, conditions, values), [graph, catalog, conditions, values]);
  const locked = allOpen || gates.lockedCount === 0 ? undefined : gates.locked;
  const result = useMemo(() => solveNetwork(network, mode, { locked }), [network, mode, locked]);
  const nodesById = useMemo(() => new Map(graph.nodes.map((n) => [n.id, n])), [graph.nodes]);
  const structure = useMemo(() => groupStructure(graph), [graph.groups, graph.nodes]);
  const collapsed = useMemo(() => summarizeCollapsed(graph, structure, network, result, locked), [graph, structure, network, result, locked]);

  // Latest values for callbacks that must stay stable (node components, React Flow handlers).
  const latest = useRef({ project, graph, structure, commit });
  latest.current = { project, graph, structure, commit };
  const toggleGroup = useCallback((groupId: Id) => {
    const { project: p, graph: g, structure: st, commit: c } = latest.current;
    c(updateGroup(p, g.id, groupId, { collapsed: st.groups.get(groupId)?.collapsed !== true }));
  }, []);

  const view: ProductionView = useMemo(
    () => ({ strings, catalog, network, result, unit, nodes: nodesById, bottlenecks: new Set(result.bottlenecks), gates: allOpen ? null : gates, groups: structure, collapsed, toggleGroup }),
    [strings, catalog, network, result, unit, nodesById, allOpen, gates, structure, collapsed, toggleGroup],
  );

  // ---- Nodes: local React Flow state (drag positions, measured sizes, selection),
  // rebuilt from the graph whenever the graph changes.
  const [rfNodes, setRfNodes] = useState<Node[]>(() => toRfNodes(graph, structure, []));
  useLayoutEffect(() => setRfNodes((prev) => toRfNodes(graph, structure, prev)), [graph, structure]);
  const [selectedEdges, setSelectedEdges] = useState<ReadonlySet<Id>>(new Set());

  const onNodesChange = useCallback((changes: NodeChange[]) => {
    // Removal goes through onDelete (one undo step for nodes + edges).
    setRfNodes((nodes) => {
      const next = applyNodeChanges(changes.filter((c) => c.type !== "remove"), nodes);
      // Frames depend on measured node sizes.
      const { graph: g, structure: st } = latest.current;
      return st.groups.size > 0 && changes.some((c) => c.type === "dimensions") ? refreshFrames(next, g, st) : next;
    });
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
      const positions = new Map<Id, Position>();
      for (const n of dragged) {
        if (n.type === "production") positions.set(n.id, n.position);
        else if (n.type === "pgroup") {
          // A collapsed group moves all of its nodes by the same offset.
          const origin = (n.data as { origin: Position }).origin;
          const dx = n.position.x - origin.x;
          const dy = n.position.y - origin.y;
          for (const id of descendantNodes(structure, n.id)) {
            const p = nodesById.get(id)?.position;
            if (p !== undefined) positions.set(id, { x: p.x + dx, y: p.y + dy });
          }
        }
      }
      commit(moveNodes(project, graph.id, positions));
    },
    [commit, project, graph.id, structure, nodesById],
  );

  const deleteSelection = useCallback(
    (rfNodeList: readonly Node[], edgeIds: Iterable<Id>) => {
      const nodeIds = new Set<Id>();
      const groupIds = new Set<Id>();
      for (const n of rfNodeList) (n.type === "production" ? nodeIds : groupIds).add(n.id);
      commit(removeGraphElements(project, graph.id, nodeIds, new Set(edgeIds), groupIds));
      setSelectedEdges(new Set());
    },
    [commit, project, graph.id],
  );

  // The connection carries the source port's item; the target handle must be the port that
  // item goes into (its own port, or a tag port it fits).
  const connectable = useCallback(
    (c: Connection | Edge): string | null => {
      const item = itemOfHandle(c.sourceHandle);
      const key = itemOfHandle(c.targetHandle);
      const target = nodesById.get(c.target);
      if (item === null || key === null || target === undefined || inputKeyFor(target, catalog, item) !== key) return null;
      return canConnect(graph, catalog, c.source, c.target, item) ? item : null;
    },
    [graph, catalog, nodesById],
  );
  const isValidConnection: IsValidConnection = useCallback((c) => connectable(c) !== null, [connectable]);

  const onConnect = useCallback(
    (c: Connection) => {
      const item = connectable(c);
      if (item === null) return;
      commit(addEdge(project, graph.id, { id: newId(), source: c.source, target: c.target, item }));
    },
    [commit, project, graph, connectable, newId],
  );

  // ---- Edges: derived from the graph and the solution. Connections at a collapsed group
  // are merged per item and cannot be selected (expand the group to edit them).
  const rfEdges: Edge[] = useMemo(
    () =>
      shownEdges(graph, structure, network, result).map((e) => {
        const single = e.edge >= 0;
        return {
          id: e.id,
          source: e.source,
          target: e.target,
          sourceHandle: outHandle(e.item),
          targetHandle: inHandle(e.targetKey),
          label: e.valid ? formatRate(e.flow, unit, s.perUnit) : "!",
          selectable: single,
          deletable: single,
          selected: single && selectedEdges.has(e.id),
          className: !e.valid ? "pedge-invalid" : e.short ? "pedge-short" : e.flow > RATE_EPSILON ? "pedge-flow" : "pedge-idle",
          markerEnd: { type: MarkerType.ArrowClosed },
        };
      }),
    [graph, structure, network, result, unit, s, selectedEdges],
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
  const selectedNode = selectedNodes.length === 1 && selectedNodes[0]!.type === "production" ? nodesById.get(selectedNodes[0]!.id) : undefined;
  const selectedGroup = selectedNodes.length === 1 && selectedNodes[0]!.type !== "production" ? structure.groups.get(selectedNodes[0]!.id) : undefined;
  const selectedEdge = selectedEdges.size === 1 ? graph.edges.find((e) => selectedEdges.has(e.id)) : undefined;
  const selectionIds = () => {
    const nodeIds = new Set<Id>();
    const groupIds = new Set<Id>();
    for (const n of selectedNodes) (n.type === "production" ? nodeIds : groupIds).add(n.id);
    return { nodeIds, groupIds };
  };
  const canGroup = selectedNodes.length > 0 && (() => {
    const { nodeIds, groupIds } = selectionIds();
    return commonContainer(graph, nodeIds, groupIds) !== null;
  })();
  const groupSelection = () => {
    const { nodeIds, groupIds } = selectionIds();
    commit(groupElements(project, graph.id, nodeIds, groupIds, { id: newId(), label: s.groupDefault((graph.groups?.length ?? 0) + 1) }));
  };
  const ungroupSelection = () => {
    if (selectedGroup !== undefined) commit(ungroup(project, graph.id, selectedGroup.id));
  };
  const onCanvasKeyDown = (e: KeyboardEvent) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey || e.key.toLowerCase() !== "g") return;
    e.preventDefault();
    if (e.shiftKey) ungroupSelection();
    else if (canGroup) groupSelection();
  };

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
          <button type="button" disabled={!canGroup} title={selectedNodes.length > 0 && !canGroup ? s.groupMixedHint : s.groupHint} onClick={groupSelection}>
            {s.group}
          </button>
          <button type="button" disabled={selectedGroup === undefined} title={s.ungroupHint} onClick={ungroupSelection}>
            {s.ungroup}
          </button>
        </div>
        <div className="pbody">
          <aside className="pside">
            <Library strings={strings} catalog={catalog} onAdd={(d) => addFromLibrary(d)} />
          </aside>
          <div className="pcanvas" aria-label={s.canvasLabel} onDragOver={(e) => e.dataTransfer.types.includes(DRAG_MIME) && e.preventDefault()} onDrop={onDrop} onKeyDown={onCanvasKeyDown}>
            <ReactFlow
              nodes={rfNodes}
              edges={rfEdges}
              nodeTypes={nodeTypes}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onNodeDragStop={onNodeDragStop}
              onConnect={onConnect}
              isValidConnection={isValidConnection}
              onDelete={({ nodes, edges }) => deleteSelection(nodes, edges.map((e) => e.id))}
              onNodeDoubleClick={(_, n) => n.type !== "production" && toggleGroup(n.id)}
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
              group={selectedGroup}
              groupNodeCount={selectedGroup === undefined ? 0 : descendantNodes(structure, selectedGroup.id).length}
              edge={selectedEdge}
              selectionSize={selectedNodes.length + selectedEdges.size}
              onNodeChange={(id, fields) => commit(updateNode(project, graph.id, id, fields))}
              onEdgeRatio={(id, ratio) => commit(setEdgeRatio(project, graph.id, id, ratio))}
              onGroupChange={(id, fields) => commit(updateGroup(project, graph.id, id, fields))}
              onUngroup={ungroupSelection}
              onDelete={() => deleteSelection(selectedNodes, selectedEdges)}
            />
            <Scenario
              strings={strings}
              variables={variables}
              conditions={conditions}
              gates={gates}
              values={values}
              overrides={overrides ?? NO_OVERRIDES}
              allOpen={allOpen}
              onOverride={(id, value) => commit(setScenarioValue(project, graph.id, id, value))}
              onReset={() => commit(resetScenario(project, graph.id))}
              onAllOpen={(open) => commit(setScenarioAllOpen(project, graph.id, open))}
            />
            <Report strings={strings} project={project} graph={graph} catalog={catalog} network={network} result={result} unit={unit} selected={selectedNode} simulation={simulation} locked={locked} />
          </aside>
        </div>
      </div>
    </ProductionContext.Provider>
  );
}

/**
 * What the canvas draws → React Flow nodes: frames of expanded groups (behind), collapsed
 * groups, and the nodes not hidden in a collapsed group. Keeps measured size and selection.
 */
function toRfNodes(graph: ProductionGraphAsset, structure: GroupStructure, prev: readonly Node[]): Node[] {
  const byId = new Map(prev.map((n) => [n.id, n]));
  const keep = (rf: Node): Node => {
    const p = byId.get(rf.id);
    if (p?.selected && p.type === rf.type) rf.selected = true;
    if (p?.measured && p.type === rf.type) rf.measured = p.measured;
    return rf;
  };
  const out: Node[] = [];
  if (structure.groups.size > 0) {
    const geometry = groupGeometry(graph, structure, sizeFrom(byId));
    const frames = [...geometry.frames].sort((a, b) => structure.depth.get(a[0])! - structure.depth.get(b[0])!);
    for (const [id, r] of frames) out.push(keep(frameNode(id, r, structure)));
    for (const [id, at] of geometry.collapsedAt) out.push(keep({ id, type: "pgroup", position: at, data: { origin: at } }));
  }
  for (const gn of graph.nodes) {
    if (structure.shownAs.get(gn.id) !== gn.id) continue;
    out.push(keep({ id: gn.id, type: "production", position: gn.position, data: {} }));
  }
  return out;
}

function sizeFrom(byId: ReadonlyMap<string, Node>): (id: Id) => { width: number; height: number } {
  return (id) => {
    const m = byId.get(id)?.measured;
    return m?.width !== undefined && m.height !== undefined ? { width: m.width, height: m.height } : DEFAULT_SIZE;
  };
}

function frameNode(id: Id, r: { x: number; y: number; width: number; height: number }, structure: GroupStructure): Node {
  return {
    id,
    type: "pframe",
    position: { x: r.x, y: r.y },
    width: r.width,
    height: r.height,
    data: {},
    draggable: false,
    connectable: false,
    className: "pframe-wrap",
    zIndex: FRAME_Z + structure.depth.get(id)!,
  };
}

/** Frames recomputed from measured sizes; unchanged frames keep their objects. */
function refreshFrames(nodes: Node[], graph: ProductionGraphAsset, structure: GroupStructure): Node[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const { frames } = groupGeometry(graph, structure, sizeFrom(byId));
  let changed = false;
  const next = nodes.map((n) => {
    if (n.type !== "pframe") return n;
    const r = frames.get(n.id);
    if (r === undefined || (r.x === n.position.x && r.y === n.position.y && r.width === n.width && r.height === n.height)) return n;
    changed = true;
    return { ...n, position: { x: r.x, y: r.y }, width: r.width, height: r.height };
  });
  return changed ? next : nodes;
}
