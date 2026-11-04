import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import {
  addAsset,
  buildReferenceIndex,
  createDocument,
  createEmptyProject,
  createTable,
  CURRENT_SCHEMA_VERSION,
  loadProject,
  redoLabel,
  removeAsset,
  renameAsset,
  renameProject,
  saveProject,
  undoLabel,
  validateProject,
  type Asset,
  type Change,
  type Id,
  type IdGenerator,
  type Project,
} from "../core/index.ts";
import { VirtualListbox } from "../ui/components/VirtualListbox.tsx";
import type { UiStrings } from "../ui/strings.ts";
import { AssetPanel, incomingReferenceCount, ProjectPanel } from "./panels.tsx";
import { initialState, isDirty, reducer } from "./state.ts";
import { defaultFileName, downloadProject, pickProjectFile, readProjectFile } from "./storage/project-file.ts";
import { clearRecovery, readLatestRecovery, writeRecovery, type RecoveryEntry } from "./storage/recovery.ts";

/** Debounce for the crash-recovery write. Flushed immediately when the tab is hidden. */
const RECOVERY_DELAY_MS = 1_500;

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
const MOD = isMac ? "⌘" : "Ctrl+";

export interface ShellProps {
  readonly strings: UiStrings;
  readonly version: string;
  readonly newId: IdGenerator;
  readonly initialProject: Project;
}

interface Notice {
  readonly text: string;
  readonly kind: "info" | "error";
}

export function Shell({ strings, version, newId, initialProject }: ShellProps) {
  const [state, dispatch] = useReducer(reducer, initialProject, initialState);
  const [selectedId, setSelectedId] = useState<Id | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [recovery, setRecovery] = useState<RecoveryEntry | null>(null);

  const project = state.history.present;
  const dirty = isDirty(state);
  const index = useMemo(() => buildReferenceIndex(project), [project]);
  const issues = useMemo(() => validateProject(project, index), [project, index]);
  const selected = selectedId === null ? undefined : project.assets.find((a) => a.id === selectedId);
  const referenceCount = useMemo(() => (selected ? incomingReferenceCount(index, selected) : 0), [index, selected]);

  const commitChange = useCallback((change: Change | null) => {
    if (change !== null) dispatch({ type: "commit", change, now: Date.now() });
  }, []);

  const confirmDiscard = () => !dirty || window.confirm(strings.confirm.discardChanges);

  // ---- Actions ------------------------------------------------------------------------
  const actions = {
    newProject() {
      if (!confirmDiscard()) return;
      dispatch({ type: "replace", project: createEmptyProject(strings.untitledProject, newId), fileName: null, saved: true });
      setSelectedId(null);
      setNotice(null);
    },
    async open() {
      if (!confirmDiscard()) return;
      const file = await pickProjectFile();
      if (file === null) return;
      const result = await readProjectFile(file);
      if (!result.ok) {
        setNotice({ kind: "error", text: strings.openFailed(strings.loadErrors[result.error.code] ?? result.error.code) });
        return;
      }
      const { fileName, loaded } = result.value;
      // A migrated project differs from its file until saved, so it starts dirty.
      dispatch({ type: "replace", project: loaded.project, fileName, saved: loaded.migratedFrom === undefined });
      setSelectedId(null);
      setNotice({
        kind: "info",
        text: loaded.migratedFrom === undefined ? strings.status.opened(fileName) : strings.status.migrated(loaded.migratedFrom, CURRENT_SCHEMA_VERSION),
      });
    },
    save() {
      const fileName = state.fileName ?? defaultFileName(project.manifest.name);
      downloadProject(project, fileName);
      dispatch({ type: "saved", fileName });
      setNotice({ kind: "info", text: strings.status.savedFile(fileName) });
    },
    undo: () => dispatch({ type: "undo" }),
    redo: () => dispatch({ type: "redo" }),
    add(asset: Asset) {
      commitChange(addAsset(project, asset));
      setSelectedId(asset.id);
    },
    remove(asset: Asset) {
      const refs = incomingReferenceCount(index, asset);
      const message = refs > 0 ? strings.confirm.deleteReferenced(asset.name, refs) : strings.confirm.deleteAsset(asset.name);
      if (!window.confirm(message)) return;
      commitChange(removeAsset(project, asset.id));
      setSelectedId(null);
    },
  };

  // ---- Keyboard shortcuts (one listener; reads the latest actions through a ref) --------
  const actionsRef = useRef(actions);
  useLayoutEffect(() => {
    actionsRef.current = actions;
  });
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const key = e.key.toLowerCase();
      const a = actionsRef.current;
      if (key === "s") a.save();
      else if (key === "o") void a.open();
      else if (key === "z" && !e.shiftKey) a.undo();
      else if ((key === "z" && e.shiftKey) || key === "y") a.redo();
      else return;
      // Also overrides the native undo of text inputs: they are bound to project data,
      // so the project history is the only consistent undo.
      e.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // ---- Leaving with unsaved changes -----------------------------------------------------
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  // ---- Crash recovery -------------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    void readLatestRecovery().then((entry) => {
      if (!cancelled && entry !== null) setRecovery(entry);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const pendingWrite = useRef<(() => void) | null>(null);
  const writtenIds = useRef(new Set<string>());
  useEffect(() => {
    const id = project.manifest.id;
    if (!dirty) {
      pendingWrite.current = null;
      if (writtenIds.current.delete(id)) void clearRecovery(id);
      return;
    }
    const write = () => {
      pendingWrite.current = null;
      writtenIds.current.add(id);
      void writeRecovery({ projectId: id, projectName: project.manifest.name, savedAt: Date.now(), text: saveProject(project) });
    };
    pendingWrite.current = write;
    const timer = setTimeout(write, RECOVERY_DELAY_MS);
    return () => clearTimeout(timer);
  }, [project, dirty]);

  useEffect(() => {
    const flush = () => {
      if (document.visibilityState === "hidden") pendingWrite.current?.();
    };
    document.addEventListener("visibilitychange", flush);
    return () => document.removeEventListener("visibilitychange", flush);
  }, []);

  const restoreRecovery = (entry: RecoveryEntry) => {
    if (!confirmDiscard()) return;
    setRecovery(null);
    const loaded = loadProject(entry.text);
    if (!loaded.ok) {
      void clearRecovery(entry.projectId);
      setNotice({ kind: "error", text: strings.openFailed(strings.loadErrors[loaded.error.code] ?? loaded.error.code) });
      return;
    }
    dispatch({ type: "replace", project: loaded.value.project, fileName: null, saved: false });
    setSelectedId(null);
    setNotice({ kind: "info", text: strings.status.recovered });
  };

  const discardRecovery = (entry: RecoveryEntry) => {
    setRecovery(null);
    void clearRecovery(entry.projectId);
  };

  // ---- Render ---------------------------------------------------------------------------
  const t = strings.toolbar;
  const nextUndo = undoLabel(state.history);
  const nextRedo = redoLabel(state.history);
  const statusText = dirty ? strings.status.unsaved : state.fileName === null ? strings.status.neverSaved : strings.status.saved;
  const formatTime = (ms: number) => new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(ms);

  return (
    <div className="shell">
      <a className="skip-link" href="#main">
        {strings.skipToContent}
      </a>
      <header className="shell-header">
        <h1 className="shell-title">{strings.appName}</h1>
        <div className="toolbar" role="group" aria-label={t.label}>
          <button type="button" onClick={actions.newProject}>
            {t.new}
          </button>
          <button type="button" onClick={() => void actions.open()} title={t.withShortcut(t.open, `${MOD}O`)}>
            {t.open}
          </button>
          <button type="button" onClick={actions.save} title={t.withShortcut(t.save, `${MOD}S`)}>
            {t.save}
          </button>
          <span className="toolbar-sep" aria-hidden="true" />
          <button
            type="button"
            onClick={actions.undo}
            disabled={nextUndo === undefined}
            title={t.withShortcut(nextUndo ? t.undoAction(strings.changes[nextUndo] ?? nextUndo) : t.undo, `${MOD}Z`)}
          >
            {t.undo}
          </button>
          <button
            type="button"
            onClick={actions.redo}
            disabled={nextRedo === undefined}
            title={t.withShortcut(nextRedo ? t.redoAction(strings.changes[nextRedo] ?? nextRedo) : t.redo, isMac ? "⇧⌘Z" : "Ctrl+Y")}
          >
            {t.redo}
          </button>
        </div>
        <p className={dirty ? "save-state is-dirty" : "save-state"}>{statusText}</p>
      </header>

      {notice !== null && (
        <div className={`notice notice-${notice.kind}`} role={notice.kind === "error" ? "alert" : "status"}>
          {notice.text}
        </div>
      )}

      {recovery !== null && (
        <div className="banner" role="region" aria-label={strings.recovery.restore}>
          <p>{strings.recovery.found(recovery.projectName, formatTime(recovery.savedAt))}</p>
          <div className="actions">
            <button type="button" className="primary" onClick={() => restoreRecovery(recovery)}>
              {strings.recovery.restore}
            </button>
            <button type="button" onClick={() => discardRecovery(recovery)}>
              {strings.recovery.discard}
            </button>
          </div>
        </div>
      )}

      <div className="workspace">
        <aside className="sidebar" aria-labelledby="assets-heading">
          <h2 id="assets-heading">{strings.assets.heading}</h2>
          <div className="actions">
            <button type="button" onClick={() => actions.add(createDocument(newId, strings.untitledDocument))}>
              {strings.assets.addDocument}
            </button>
            <button type="button" onClick={() => actions.add(createTable(newId, strings.untitledTable))}>
              {strings.assets.addTable}
            </button>
          </div>
          {project.assets.length === 0 ? (
            <p className="muted">{strings.assets.empty}</p>
          ) : (
            <VirtualListbox
              id="asset-list"
              label={strings.assets.listLabel}
              items={project.assets}
              getKey={(a) => a.id}
              selectedKey={selected ? selected.id : null}
              onSelect={setSelectedId}
              renderItem={(a) => (
                <>
                  <span className="asset-kind">{strings.assets.kind[a.kind]}</span>
                  <span className="asset-name">{a.name}</span>
                </>
              )}
            />
          )}
        </aside>

        <main className="details" id="main" tabIndex={-1}>
          {selected !== undefined ? (
            <AssetPanel
              strings={strings}
              asset={selected}
              referenceCount={referenceCount}
              onRename={(name) => commitChange(renameAsset(project, selected.id, name))}
              onDelete={() => actions.remove(selected)}
              onBack={() => setSelectedId(null)}
            />
          ) : (
            <ProjectPanel
              strings={strings}
              project={project}
              fileName={state.fileName}
              issues={issues}
              onRename={(name) => commitChange(renameProject(project, name))}
              onSelectAsset={setSelectedId}
            />
          )}
        </main>
      </div>

      <footer className="shell-footer">
        <span>{strings.privacyNote}</span>
        <span>{strings.version(version)}</span>
      </footer>
    </div>
  );
}
