import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from "react";
import {
  addAsset,
  addAssets,
  createProductionGraph,
  createProductionSample,
  createProductionTables,
  findProductionTables,
  buildReferenceIndex,
  createReferenceIndexCache,
  createDocument,
  createEmptyProject,
  createTable,
  CURRENT_SCHEMA_VERSION,
  loadProject,
  openProjectFolder,
  readFolderSession,
  redoLabel,
  removeAsset,
  renameAsset,
  projectFileName,
  renameProject,
  saveProject,
  saveProjectFolder,
  savedFileName,
  undoLabel,
  validateProject,
  createValidationCache,
  FormulaEngine,
  type Asset,
  type Change,
  type FolderIo,
  type FolderLoadError,
  type FolderSession,
  type Id,
  type IdGenerator,
  type Project,
} from "../core/index.ts";
import { VirtualListbox } from "../ui/components/VirtualListbox.tsx";
import { ProductionEditor } from "../ui/production/ProductionEditor.tsx";
import { TableEditor } from "../ui/tables/TableEditor.tsx";
import type { UiStrings } from "../ui/strings.ts";
import { AssetPanel, ProjectPanel } from "./panels.tsx";
import { initialState, isDirty, reducer } from "./state.ts";
import { downloadProject, pickProjectFile, readProjectFile } from "./storage/project-file.ts";
import { createFolderIo, ensureWritable, isFolderModeSupported, pickProjectFolder } from "./storage/project-folder.ts";
import { clearRecovery, readLatestRecovery, writeRecovery, type RecoveryEntry } from "./storage/recovery.ts";
import { downloadText, pickTextFile } from "./storage/text-file.ts";
import { createSimulationService } from "./simulation.ts";

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

/** The open project folder: its handle and what this app knows is on disk. */
interface OpenFolder {
  readonly handle: FileSystemDirectoryHandle;
  readonly io: FolderIo;
  readonly session: FolderSession;
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function Shell({ strings, version, newId, initialProject }: ShellProps) {
  const [state, dispatch] = useReducer(reducer, initialProject, initialState);
  const [selectedId, setSelectedId] = useState<Id | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [recovery, setRecovery] = useState<RecoveryEntry | null>(null);
  const [saving, setSaving] = useState(false);
  const folderMode = useMemo(isFolderModeSupported, []);
  const simulation = useMemo(createSimulationService, []);
  /** Set while the project's target is a folder. Kept outside the reducer: it holds a handle. */
  const folder = useRef<OpenFolder | null>(null);
  /** Guards against overlapping saves (e.g. Ctrl+S pressed again while writing). */
  const busy = useRef(false);

  const project = state.history.present;
  const dirty = isDirty(state);
  // Both caches follow the history: an edit re-collects and re-checks only the changed
  // assets and rows, so a cell edit in a large table stays cheap.
  const indexCache = useMemo(createReferenceIndexCache, []);
  const index = useMemo(() => buildReferenceIndex(project, indexCache), [project, indexCache]);
  const validationCache = useMemo(createValidationCache, []);
  // Formula columns; recalculates only what an edit touched (see core/formulas.ts).
  const formulaEngine = useMemo(() => new FormulaEngine(), []);
  const formulas = useMemo(() => formulaEngine.evaluate(project), [formulaEngine, project]);
  const issues = useMemo(() => validateProject(project, index, validationCache, formulas), [project, index, validationCache, formulas]);
  const selected = selectedId === null ? undefined : project.assets.find((a) => a.id === selectedId);
  // Kept by the index cache: no pass over the rows of a selected table on each edit.
  const referenceCount = useMemo(() => (selected ? index.incomingCount(selected) : 0), [index, selected]);

  const commitChange = useCallback((change: Change | null) => {
    if (change !== null) dispatch({ type: "commit", change, now: Date.now() });
  }, []);

  const confirmDiscard = () => !dirty || window.confirm(strings.confirm.discardChanges);

  const loadErrorText = (error: FolderLoadError) => {
    const reason = strings.loadErrors[error.code] ?? error.code;
    return "file" in error && error.file !== undefined ? `${reason} ${strings.inFile(error.file)}` : reason;
  };

  /** Writes `snapshot` to the folder. Returns true when the whole project was saved. */
  const writeFolder = async (target: OpenFolder, snapshot: Project, confirmed: boolean): Promise<boolean> => {
    if (!(await ensureWritable(target.handle))) {
      setNotice({ kind: "error", text: strings.saveErrors.permission });
      return false;
    }
    let result = await saveProjectFolder(target.io, target.session, snapshot, { overwrite: confirmed });
    if (result.status === "conflict") {
      if (!window.confirm(strings.confirm.overwriteChanged(result.paths.length, result.paths[0]!))) {
        setNotice({ kind: "info", text: strings.status.notSaved });
        return false;
      }
      result = await saveProjectFolder(target.io, target.session, snapshot, { overwrite: true });
    }
    switch (result.status) {
      case "saved":
        folder.current = { ...target, session: result.session };
        dispatch({ type: "saved", project: snapshot, target: { kind: "folder", name: target.handle.name } });
        setNotice({ kind: "info", text: strings.status.savedFolder(target.handle.name, result.written, result.removed) });
        return true;
      case "failed":
        // Keep what was written, but only for the folder that is already the save target.
        if (folder.current?.handle === target.handle) folder.current = { ...target, session: result.session };
        setNotice({ kind: "error", text: strings.saveErrors.failed(result.path, result.message) });
        return false;
      case "duplicate-id":
        setNotice({ kind: "error", text: strings.saveErrors["duplicate-id"] });
        return false;
      case "conflict":
        return false;
    }
  };

  /** Runs one save at a time and shows "Saving…" while it runs. */
  const exclusive = async (body: () => Promise<unknown>) => {
    if (busy.current) return;
    busy.current = true;
    setSaving(true);
    try {
      await body();
    } catch (e) {
      setNotice({ kind: "error", text: strings.saveErrors.folderUnavailable(errorText(e)) });
    } finally {
      busy.current = false;
      setSaving(false);
    }
  };

  // ---- Actions ------------------------------------------------------------------------
  const actions = {
    newProject() {
      // A folder save in flight would bind its folder to the new project when it ends.
      if (busy.current || !confirmDiscard()) return;
      folder.current = null;
      dispatch({ type: "replace", project: createEmptyProject(strings.untitledProject, newId), target: null, saved: true });
      setSelectedId(null);
      setNotice(null);
    },
    async open() {
      if (busy.current || !confirmDiscard()) return;
      const file = await pickProjectFile();
      if (file === null) return;
      const result = await readProjectFile(file);
      // A save may have started while the file was read; it must finish on its own project.
      if (busy.current) return;
      if (!result.ok) {
        setNotice({ kind: "error", text: strings.openFailed(strings.loadErrors[result.error.code] ?? result.error.code) });
        return;
      }
      const { fileName, loaded } = result.value;
      folder.current = null;
      // A migrated project differs from its file until saved, so it starts dirty.
      dispatch({ type: "replace", project: loaded.project, target: { kind: "file", name: fileName }, saved: loaded.migratedFrom === undefined });
      setSelectedId(null);
      setNotice({
        kind: "info",
        text: loaded.migratedFrom === undefined ? strings.status.opened(fileName) : strings.status.migrated(loaded.migratedFrom, CURRENT_SCHEMA_VERSION),
      });
    },
    openFolder: () =>
      exclusive(async () => {
        if (!confirmDiscard()) return;
        const handle = await pickProjectFolder();
        if (handle === null) return;
        const io = createFolderIo(handle);
        const result = await openProjectFolder(io);
        if (!result.ok) {
          setNotice({ kind: "error", text: strings.openFolderFailed(loadErrorText(result.error)) });
          return;
        }
        const { loaded, session } = result.value;
        folder.current = { handle, io, session };
        // Migrated: the files are older than the project in memory until saved.
        dispatch({ type: "replace", project: loaded.project, target: { kind: "folder", name: handle.name }, saved: loaded.migratedFrom === undefined });
        setSelectedId(null);
        setNotice({
          kind: "info",
          text: loaded.migratedFrom === undefined ? strings.status.openedFolder(handle.name) : strings.status.migrated(loaded.migratedFrom, CURRENT_SCHEMA_VERSION),
        });
      }),
    saveToFolder: () =>
      exclusive(async () => {
        const handle = await pickProjectFolder();
        if (handle === null) return;
        const io = createFolderIo(handle);
        const session = await readFolderSession(io);
        if (!session.ok) {
          setNotice({ kind: "error", text: strings.saveErrors.folderUnavailable(strings.loadErrors["read-failed"]!) });
          return;
        }
        if (session.value.manifest !== null && !window.confirm(strings.confirm.replaceFolderProject(handle.name))) return;
        // On failure the folder does not become the target; "Save to folder…" again resumes,
        // because the files already written are picked up by readFolderSession.
        await writeFolder({ handle, io, session: session.value }, project, true);
      }),
    save() {
      if (state.target?.kind === "folder" && folder.current !== null) {
        const target = folder.current;
        void exclusive(() => writeFolder(target, project, false));
        return;
      }
      // A project opened from a legacy .gdtproj file is saved as .json.
      const fileName = state.target?.kind === "file" ? savedFileName(state.target.name) : projectFileName(project.manifest.name);
      downloadProject(project, fileName);
      folder.current = null;
      dispatch({ type: "saved", project, target: { kind: "file", name: fileName } });
      setNotice({ kind: "info", text: strings.status.savedFile(fileName) });
    },
    downloadCopy() {
      const fileName = projectFileName(project.manifest.name);
      downloadProject(project, fileName);
      setNotice({ kind: "info", text: strings.status.downloaded(fileName) });
    },
    undo: () => dispatch({ type: "undo" }),
    redo: () => dispatch({ type: "redo" }),
    add(asset: Asset) {
      commitChange(addAsset(project, asset));
      setSelectedId(asset.id);
    },
    /** A production chain on the project's Items/Recipes tables, created with them if missing. */
    addProduction() {
      const existing = findProductionTables(project);
      if (existing !== null) {
        const graph = createProductionGraph(newId, strings.untitledProduction, existing);
        commitChange(addAsset(project, graph));
        setSelectedId(graph.id);
        return;
      }
      const tables = createProductionTables(newId, strings.productionTableNames);
      const graph = createProductionGraph(newId, strings.productionTableNames.graph, tables);
      commitChange(addAssets(project, [tables.items, tables.machines, tables.recipes, graph], "add-production-graph"));
      setSelectedId(graph.id);
    },
    addExample() {
      const { tables, graph } = createProductionSample(newId, strings.exampleProductionNames);
      commitChange(addAssets(project, [tables.items, tables.machines, tables.recipes, graph], "add-production-graph"));
      setSelectedId(graph.id);
    },
    remove(asset: Asset) {
      const refs = index.incomingCount(asset);
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
    if (busy.current || !confirmDiscard()) return;
    setRecovery(null);
    const loaded = loadProject(entry.text);
    if (!loaded.ok) {
      void clearRecovery(entry.projectId);
      setNotice({ kind: "error", text: strings.openFailed(strings.loadErrors[loaded.error.code] ?? loaded.error.code) });
      return;
    }
    folder.current = null;
    dispatch({ type: "replace", project: loaded.value.project, target: null, saved: false });
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
  const statusText = saving
    ? strings.status.saving
    : dirty
      ? strings.status.unsaved
      : state.target === null
        ? strings.status.neverSaved
        : strings.status.saved;
  const inFolder = state.target?.kind === "folder";
  const formatTime = (ms: number) => new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(ms);

  return (
    <div className="shell">
      <a className="skip-link" href="#main">
        {strings.skipToContent}
      </a>
      <header className="shell-header">
        <h1 className="shell-title">{strings.appName}</h1>
        <div className="toolbar" role="group" aria-label={t.label}>
          <button type="button" onClick={actions.newProject} disabled={saving}>
            {t.new}
          </button>
          <button type="button" onClick={() => void actions.open()} title={t.withShortcut(t.open, `${MOD}O`)} disabled={saving}>
            {t.open}
          </button>
          {folderMode && (
            <button type="button" onClick={() => void actions.openFolder()} title={t.folderHint} disabled={saving}>
              {t.openFolder}
            </button>
          )}
          <button type="button" onClick={actions.save} title={t.withShortcut(t.save, `${MOD}S`)} disabled={saving}>
            {t.save}
          </button>
          {folderMode && (
            <button type="button" onClick={() => void actions.saveToFolder()} title={t.folderHint} disabled={saving}>
              {t.saveToFolder}
            </button>
          )}
          {inFolder && (
            <button type="button" onClick={actions.downloadCopy} title={t.downloadCopyHint}>
              {t.downloadCopy}
            </button>
          )}
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
            <button type="button" className="primary" onClick={() => restoreRecovery(recovery)} disabled={saving}>
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
            <button type="button" onClick={actions.addProduction}>
              {strings.assets.addProduction}
            </button>
            <button type="button" onClick={actions.addExample}>
              {strings.assets.addExample}
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
              selectOnMove={false}
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
            <>
              <AssetPanel
                strings={strings}
                asset={selected}
                referenceCount={referenceCount}
                onRename={(name) => commitChange(renameAsset(project, selected.id, name))}
                onDelete={() => actions.remove(selected)}
                onBack={() => setSelectedId(null)}
              />
              {selected.kind === "table" && (
                <TableEditor
                  key={selected.id}
                  strings={strings}
                  project={project}
                  index={index}
                  table={selected}
                  formulas={formulas}
                  newId={newId}
                  commit={commitChange}
                  saveFile={downloadText}
                  pickTextFile={pickTextFile}
                  notify={(text, kind) => setNotice({ text, kind })}
                />
              )}
              {selected.kind === "production-graph" && (
                <ProductionEditor key={selected.id} strings={strings} project={project} graph={selected} newId={newId} commit={commitChange} simulation={simulation} />
              )}
            </>
          ) : (
            <ProjectPanel
              strings={strings}
              project={project}
              target={state.target}
              issues={issues}
              newId={newId}
              commit={commitChange}
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
