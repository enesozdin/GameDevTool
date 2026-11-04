import type { Asset, Id, Issue, Project, ReferenceIndex } from "../core/index.ts";
import { isValidName } from "../core/index.ts";
import { NameField } from "../ui/components/NameField.tsx";
import type { UiStrings } from "../ui/strings.ts";
import type { SaveTarget } from "./state.ts";

const MAX_LISTED_ISSUES = 100;

/** References that would break if `asset` were deleted (its own internal ones excluded). */
export function incomingReferenceCount(index: ReferenceIndex, asset: Asset): number {
  let count = index.usedBy(asset.id).filter((r) => r.source !== asset.id).length;
  if (asset.kind === "table") {
    for (const row of asset.rows) count += index.usedBy(row.id).filter((r) => r.source !== asset.id).length;
  }
  return count;
}

export interface ProjectPanelProps {
  readonly strings: UiStrings;
  readonly project: Project;
  readonly target: SaveTarget | null;
  readonly issues: readonly Issue[];
  readonly onRename: (name: string) => void;
  readonly onSelectAsset: (id: Id) => void;
}

export function ProjectPanel({ strings, project, target, issues, onRename, onSelectAsset }: ProjectPanelProps) {
  const s = strings.details;
  return (
    <>
      <section className="card" aria-labelledby="project-heading">
        <h2 id="project-heading">{s.project}</h2>
        <NameField
          id="project-name"
          label={s.name}
          value={project.manifest.name}
          invalidMessage={s.nameInvalid}
          isValid={isValidName}
          onCommit={onRename}
        />
        <dl className="facts">
          <dt>{s.schemaVersion}</dt>
          <dd>{project.manifest.schemaVersion}</dd>
          <dt>{s.assetCount}</dt>
          <dd>{project.assets.length}</dd>
          {target !== null && (
            <>
              <dt>{s.location}</dt>
              <dd>{target.kind === "folder" ? s.locationFolder(target.name) : target.name}</dd>
            </>
          )}
        </dl>
      </section>
      <IssueList strings={strings} project={project} issues={issues} onSelectAsset={onSelectAsset} />
    </>
  );
}

function IssueList({ strings, project, issues, onSelectAsset }: Pick<ProjectPanelProps, "strings" | "project" | "issues" | "onSelectAsset">) {
  const s = strings.issues;
  const shown = issues.slice(0, MAX_LISTED_ISSUES);
  return (
    <section className="card" aria-labelledby="issues-heading">
      <h2 id="issues-heading">
        {s.heading}
        {issues.length > 0 && <span className="badge">{s.count(issues.length)}</span>}
      </h2>
      {issues.length === 0 ? (
        <p className="muted">{s.none}</p>
      ) : (
        <ul className="issues">
          {shown.map((issue, i) => {
            const assetIndex = issue.path[0] === "assets" && typeof issue.path[1] === "number" ? issue.path[1] : -1;
            const asset = project.assets[assetIndex];
            return (
              <li key={i} className={`issue issue-${issue.severity}`}>
                <span className="issue-severity">{s.severity[issue.severity]}</span>
                <span className="issue-text">{s.codes[issue.code] ?? issue.code}</span>
                {asset !== undefined ? (
                  <button type="button" className="link" onClick={() => onSelectAsset(asset.id)}>
                    {asset.name}
                  </button>
                ) : (
                  <code className="issue-path">{issue.path.join(" › ")}</code>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {issues.length > shown.length && <p className="muted">{s.moreHidden(issues.length - shown.length)}</p>}
    </section>
  );
}

export interface AssetPanelProps {
  readonly strings: UiStrings;
  readonly asset: Asset;
  readonly referenceCount: number;
  readonly onRename: (name: string) => void;
  readonly onDelete: () => void;
  readonly onBack: () => void;
}

export function AssetPanel({ strings, asset, referenceCount, onRename, onDelete, onBack }: AssetPanelProps) {
  const s = strings.details;
  return (
    <section className="card" aria-labelledby="asset-heading">
      <button type="button" className="link back" onClick={onBack}>
        ← {s.backToProject}
      </button>
      <h2 id="asset-heading">{strings.assets.kind[asset.kind]}</h2>
      {/* key: a different asset gets a fresh field (drops any invalid draft). */}
      <NameField
        key={asset.id}
        id="asset-name"
        label={s.name}
        value={asset.name}
        invalidMessage={s.nameInvalid}
        isValid={isValidName}
        onCommit={onRename}
      />
      <dl className="facts">
        <dt>{s.id}</dt>
        <dd>
          <code>{asset.id}</code>
        </dd>
        <dt>{s.usedBy}</dt>
        <dd>{s.references(referenceCount)}</dd>
      </dl>
      <p className="muted">{s.comingLater[asset.kind]}</p>
      <div className="actions">
        <button type="button" className="danger" onClick={onDelete}>
          {s.delete}
        </button>
      </div>
    </section>
  );
}
