import { Handle, Position, type NodeProps } from "@xyflow/react";
import { memo } from "react";
import { RATE_EPSILON } from "../../core/index.ts";
import { itemName, useProductionView } from "./context.ts";
import { formatRate } from "./format.ts";
import { inHandle, outHandle, PORT_GAP, PORT_TOP } from "./ProductionNode.tsx";

/**
 * A collapsed sub-chain drawn as one node (IDEF0 decomposition). Its ports are the items
 * crossing the group boundary; connections are made inside the expanded group, so the
 * handles only anchor the merged connections.
 */
export const GroupNode = memo(function GroupNode({ id, selected }: NodeProps) {
  const view = useProductionView();
  const { strings, unit } = view;
  const s = strings.production;
  const group = view.groups.groups.get(id);
  const summary = view.collapsed.get(id);
  if (group === undefined || summary === undefined) return null;
  const rows = Math.max(summary.inputs.length, summary.outputs.length, 1);

  const classes = ["pnode", "pnode-group"];
  if (selected) classes.push("is-selected");
  if (summary.deficit > RATE_EPSILON || summary.bottleneck) classes.push("has-deficit");

  return (
    <div className={classes.join(" ")} style={{ minHeight: PORT_TOP + rows * PORT_GAP + 40 }}>
      <div className="pnode-head pnode-head-row">
        <span className="pnode-head-text">
          <span className="pnode-type">{s.nodeType["group"]}</span>
          <span className="pnode-title">{group.label}</span>
        </span>
        <button type="button" className="pnode-toggle nodrag" title={s.expandHint(group.label)} aria-label={s.expandHint(group.label)} onClick={() => view.toggleGroup(id)}>
          {s.expand}
        </button>
      </div>
      {summary.inputs.map((port, i) => (
        <div key={`in:${port.item}`} className={`pnode-port pnode-port-in${port.warn ? " is-warn" : ""}`} style={{ top: PORT_TOP + i * PORT_GAP }}>
          <Handle type="target" position={Position.Left} id={inHandle(port.item)} isConnectable={false} />
          <span>{`${itemName(view, port.item)} ${formatRate(port.rate, unit, s.perUnit)}`}</span>
        </div>
      ))}
      {summary.outputs.map((port, i) => (
        <div key={`out:${port.item}`} className="pnode-port pnode-port-out" style={{ top: PORT_TOP + i * PORT_GAP }}>
          <Handle type="source" position={Position.Right} id={outHandle(port.item)} isConnectable={false} />
          <span>{`${itemName(view, port.item)} ${formatRate(port.rate, unit, s.perUnit)}`}</span>
        </div>
      ))}
      <div className="pnode-foot">
        <span>{s.groupNodes(summary.nodeCount)}</span>
        {summary.deficit > RATE_EPSILON && <span className="pnode-bad">{s.deficit(formatRate(summary.deficit, unit, s.perUnit))}</span>}
        {summary.lockedCount > 0 && <span className="pnode-bad">{s.lockedCount(summary.lockedCount)}</span>}
        {summary.bottleneck && <span className="pnode-bad">{s.bottleneck}</span>}
      </div>
    </div>
  );
});

/**
 * Frame around an expanded sub-chain. Only the header takes pointer events (CSS), so the
 * canvas inside the frame still pans and box-selects.
 */
export const GroupFrame = memo(function GroupFrame({ id, selected }: NodeProps) {
  const view = useProductionView();
  const s = view.strings.production;
  const group = view.groups.groups.get(id);
  if (group === undefined) return null;
  return (
    <div className={`pframe${selected ? " is-selected" : ""}`}>
      <div className="pframe-head">
        <span className="pframe-title">{group.label}</span>
        <button type="button" className="pnode-toggle nodrag" title={s.collapseHint(group.label)} aria-label={s.collapseHint(group.label)} onClick={() => view.toggleGroup(id)}>
          {s.collapse}
        </button>
      </div>
    </div>
  );
});
