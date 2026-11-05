import { Handle, Position, type NodeProps } from "@xyflow/react";
import { memo, type ReactNode } from "react";
import { GateStatus, Limit, NodeKind, RATE_EPSILON } from "../../core/index.ts";
import { itemName, nodeTitle, useProductionView } from "./context.ts";
import { formatNumber, formatRate } from "./format.ts";

/** Handle ids: "in:<itemId>" / "out:<itemId>". */
export const inHandle = (item: string) => `in:${item}`;
export const outHandle = (item: string) => `out:${item}`;

export const PORT_TOP = 44;
export const PORT_GAP = 26;

/**
 * One production node, IDEF0-style: inputs on the left, outputs on the right. Shows the
 * rate per port and, for recipes, the machine count. React applies `style` through the
 * CSSOM, which the CSP allows (only style attributes in the HTML source would be blocked).
 */
export const ProductionNode = memo(function ProductionNode({ id, selected }: NodeProps) {
  const view = useProductionView();
  const { strings, network: net, result, unit } = view;
  const s = strings.production;
  const node = view.nodes.get(id);
  const index = net.nodeIndex.get(id);
  if (node === undefined || index === undefined) return null;

  const inputs: number[] = [];
  for (let q = net.inStart[index]!; q < net.inStart[index + 1]!; q++) inputs.push(q);
  const outputs: number[] = [];
  for (let p = net.outStart[index]!; p < net.outStart[index + 1]!; p++) outputs.push(p);
  const rows = Math.max(inputs.length, outputs.length, 1);
  const deficit = result.nodeDeficit[index]!;
  const isBottleneck = view.bottlenecks.has(index);
  const machines = result.machines[index]!;
  const gate = view.gates?.status[index] ?? GateStatus.none;
  const isLocked = gate === GateStatus.closed || gate === GateStatus.error;

  const classes = ["pnode", `pnode-${node.type}`];
  if (selected) classes.push("is-selected");
  if (deficit > RATE_EPSILON) classes.push("has-deficit");
  if (isBottleneck) classes.push("is-bottleneck");
  if (isLocked) classes.push("is-locked");

  let status: string | null = null;
  if (net.kind[index] === NodeKind.recipe && !Number.isNaN(machines)) status = s.machines(formatNumber(machines), Math.ceil(machines - 1e-9));
  else if (net.kind[index] !== NodeKind.recipe) status = formatRate(result.activity[index]!, unit, s.perUnit);

  let limitText: string | null = null;
  if (result.mode === "supply" && net.kind[index] === NodeKind.recipe) {
    const lim = result.limit[index];
    if (lim === Limit.machines) limitText = s.limitedBy(s.limitMachines);
    else if (lim === Limit.input && result.limitPort[index]! >= 0) limitText = s.limitedBy(itemName(view, net.inItem[result.limitPort[index]!]!));
  }

  return (
    <div className={classes.join(" ")} style={{ minHeight: PORT_TOP + rows * PORT_GAP + 40 }}>
      <div className="pnode-head">
        <span className="pnode-type">{s.nodeType[node.type]}</span>
        <span className="pnode-title">{nodeTitle(view, node)}</span>
      </div>
      {inputs.map((q, i) => (
        <PortLabel key={q} side="in" row={i} text={`${itemName(view, net.inItem[q]!)} ${formatRate(result.inSupplied[q]!, unit, s.perUnit)}`} warn={result.inRequired[q]! - result.inSupplied[q]! > RATE_EPSILON}>
          <Handle type="target" position={Position.Left} id={inHandle(net.inItem[q]!)} />
        </PortLabel>
      ))}
      {outputs.map((p, i) => (
        <PortLabel key={p} side="out" row={i} text={`${itemName(view, net.outItem[p]!)} ${formatRate(result.outProduced[p]!, unit, s.perUnit)}`} warn={false}>
          <Handle type="source" position={Position.Right} id={outHandle(net.outItem[p]!)} />
        </PortLabel>
      ))}
      <div className="pnode-foot">
        {status !== null && <span>{status}</span>}
        {deficit > RATE_EPSILON && <span className="pnode-bad">{s.deficit(formatRate(deficit, unit, s.perUnit))}</span>}
        {isLocked && <span className="pnode-bad">{gate === GateStatus.error ? s.gateError : node.type === "gate" ? s.gateClosed : s.recipeLocked}</span>}
        {gate === GateStatus.open && node.type === "gate" && <span className="muted">{s.gateOpen}</span>}
        {isBottleneck && <span className="pnode-bad">{s.bottleneck}</span>}
        {limitText !== null && <span className="muted">{limitText}</span>}
      </div>
    </div>
  );
});

function PortLabel({ side, row, text, warn, children }: { side: "in" | "out"; row: number; text: string; warn: boolean; children: ReactNode }) {
  return (
    <div className={`pnode-port pnode-port-${side}${warn ? " is-warn" : ""}`} style={{ top: PORT_TOP + row * PORT_GAP }}>
      {children}
      <span>{text}</span>
    </div>
  );
}
