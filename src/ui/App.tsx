import type { Project } from "../core/index.ts";
import type { UiStrings } from "./strings.ts";

export interface AppProps {
  readonly strings: UiStrings;
  readonly version: string;
  readonly project: Project;
  readonly issueCount: number;
}

/** Responsive app shell. Tools mount inside <main> when opened (later phases). */
export function App({ strings, version, project, issueCount }: AppProps) {
  return (
    <div className="shell">
      <header className="shell-header">
        <h1 className="shell-title">{strings.appName}</h1>
        <span className="shell-version">{strings.version(version)}</span>
      </header>
      <main className="shell-main" id="main" tabIndex={-1}>
        <p>{strings.tagline}</p>
        <section aria-labelledby="project-heading" className="card">
          <h2 id="project-heading">{strings.projectSection}</h2>
          <dl className="facts">
            <dt>{strings.projectName}</dt>
            <dd>{project.manifest.name}</dd>
            <dt>{strings.schemaVersion}</dt>
            <dd>{project.manifest.schemaVersion}</dd>
            <dt>{strings.assetCount}</dt>
            <dd>{project.assets.length}</dd>
            <dt>{strings.issueCount}</dt>
            <dd>{issueCount}</dd>
          </dl>
        </section>
      </main>
      <footer className="shell-footer">{strings.privacyNote}</footer>
    </div>
  );
}
