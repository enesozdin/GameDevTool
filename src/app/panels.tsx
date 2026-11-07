import type { Asset, Change, Id, IdGenerator, Issue, Project } from "../core/index.ts";
import { ISSUES_TRUNCATED, isValidName, MAX_ISSUES_PER_CODE } from "../core/index.ts";
import { NameField } from "../ui/components/NameField.tsx";
import type { UiStrings } from "../ui/strings.ts";
import { VariablesPanel } from "../ui/variables/VariablesPanel.tsx";
import type { SaveTarget } from "./state.ts";

const MAX_LISTED_ISSUES = 100;

export interface ProjectPanelProps {
  readonly strings: UiStrings;
  readonly project: Project;
  readonly target: SaveTarget | null;
  readonly issues: readonly Issue[];
  readonly newId: IdGenerator;
  readonly commit: (change: Change | null) => void;
  readonly onRename: (name: string) => void;
  readonly onSelectAsset: (id: Id) => void;
}

export function ProjectPanel({ strings, project, target, issues, newId, commit, onRename, onSelectAsset }: ProjectPanelProps) {
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
      <VariablesPanel strings={strings} project={project} newId={newId} commit={commit} />
      <IssueList strings={strings} project={project} issues={issues} onSelectAsset={onSelectAsset} />
    </>
  );
}

function IssueList({ strings, project, issues, onSelectAsset }: Pick<ProjectPanelProps, "strings" | "project" | "issues" | "onSelectAsset">) {
  const s = strings.issues;
  // validateProject lists at most MAX_ISSUES_PER_CODE of each code and adds one
  // ISSUES_TRUNCATED issue per capped code, at the end, with the number left out.
  const firstTruncated = issues.findIndex((issue) => issue.code === ISSUES_TRUNCATED);
  const listed = firstTruncated < 0 ? issues : issues.slice(0, firstTruncated);
  let omitted = 0;
  for (let i = listed.length; i < issues.length; i++) omitted += Number(issues[i]!.params?.omitted ?? 0);
  const total = listed.length + omitted;
  const shown = listed.slice(0, MAX_LISTED_ISSUES);
  return (
    <section className="card" aria-labelledby="issues-heading">
      <h2 id="issues-heading">
        {s.heading}
        {total > 0 && <span className="badge">{s.count(total)}</span>}
      </h2>
      {total === 0 ? (
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
      {total > shown.length && <p className="muted">{s.moreHidden(total - shown.length)}</p>}
      {omitted > 0 && <p className="muted">{s.capped(MAX_ISSUES_PER_CODE)}</p>}
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
      {s.comingLater[asset.kind] !== undefined && <p className="muted">{s.comingLater[asset.kind]}</p>}
      <div className="actions">
        <button type="button" className="danger" onClick={onDelete}>
          {s.delete}
        </button>
      </div>
    </section>
  );
}
