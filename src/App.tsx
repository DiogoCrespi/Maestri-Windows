import React, { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { CanvasWorkspace } from "./components/CanvasWorkspace";
import { AppContextMenu } from "./components/AppContextMenu";
import { ProjectManagerModal } from "./components/ProjectManagerModal";
import { Sidebar } from "./components/Sidebar";
import { desktopBridge } from "./lib/desktopBridge";
import testWorkspaceData from "./model/TestWorkspace.json";
import { parseWorkspaceDocument } from "./model/workspace";
import {
  projectDirectoryFromWorkspacePath,
  projectNameFromPath,
  readRecentProjects,
  rememberRecentProject,
  removeRecentProject,
  validateRecentProjects,
  workspacePathForProject,
  writeRecentProjects,
  normalizeProjectPath,
  type RecentProject,
} from "./projectManager";
import { useWorkspaceStore } from "./store/workspaceStore";

export const DEFAULT_WORKSPACE_PATH = "workspace.json";
const DISCARD_CHANGES_MESSAGE = "Há alterações não salvas. Deseja descartá-las?";

const LAST_WORKSPACE_KEY = "maestri-last-workspace-path";
const AUTOSAVE_DEBOUNCE_MS = 1500;

export function readRememberedWorkspacePath(storage: Pick<Storage, "getItem">): string {
  return storage.getItem(LAST_WORKSPACE_KEY)?.trim() ?? "";
}

export function rememberWorkspacePath(storage: Pick<Storage, "setItem">, workspacePath: string): void {
  const normalized = workspacePath.trim();
  if (normalized) storage.setItem(LAST_WORKSPACE_KEY, normalized);
}

export function workspaceFingerprint(document: ReturnType<typeof parseWorkspaceDocument>): string {
  return JSON.stringify({
    ...document,
    payload: { ...document.payload, lastModifiedAt: "" },
  });
}

export interface SaveSnapshotState {
  savedPath: string;
  currentPath: string;
  savedWorkspaceId: string;
  currentWorkspaceId?: string;
  savedRevision: number;
  currentRevision: number;
  savedFingerprint: string;
  currentFingerprint: string;
}

export function canMarkCleanAfterSave(state: SaveSnapshotState): boolean {
  return state.savedPath === state.currentPath
    && state.savedWorkspaceId === state.currentWorkspaceId
    && state.savedRevision === state.currentRevision
    && state.savedFingerprint === state.currentFingerprint;
}

export function shouldAutosave(isDirty: boolean, isHydrating: boolean, confirmedPath: string): boolean {
  return isDirty && !isHydrating && Boolean(confirmedPath.trim());
}

export function createProjectWorkspaceDocument(projectName: string, projectPath: string): ReturnType<typeof parseWorkspaceDocument> {
  const now = new Date().toISOString();
  const template = parseWorkspaceDocument(testWorkspaceData);
  return {
    schemaVersion: 2,
    type: "workspace",
    payload: {
      ...template.payload,
      id: crypto.randomUUID(),
      name: projectName.trim(),
      workingDirectory: projectPath,
      canvasOrigin: { x: 0, y: 0 },
      canvasZoom: 1,
      nodes: [],
      connections: [],
      noteConnections: [],
      portalConnections: [],
      portalToPortalConnections: [],
      noteToNoteConnections: [],
      crossFloorConnections: [],
      floors: [],
      drawings: [],
      createdAt: now,
      lastModifiedAt: now,
    },
  };
}

export const App: React.FC = () => {
  const loadWorkspace = useWorkspaceStore((state) => state.loadWorkspace);
  const serializeWorkspace = useWorkspaceStore((state) => state.serializeWorkspace);
  const markClean = useWorkspaceStore((state) => state.markClean);
  const isDirty = useWorkspaceStore((state) => state.isDirty);
  const currentDocument = useWorkspaceStore((state) => state.currentDocument);
  const nodes = useWorkspaceStore((state) => state.nodes);
  const edges = useWorkspaceStore((state) => state.edges);

  const [path, setPath] = useState("");
  const [confirmedPath, setConfirmedPath] = useState("");
  const [status, setStatus] = useState("Iniciando...");
  const [busy, setBusy] = useState(false);
  const [projectManagerOpen, setProjectManagerOpen] = useState(true);
  const [projectManagerError, setProjectManagerError] = useState<string | null>(null);
  const [recentProjects, setRecentProjects] = useState<RecentProject[]>([]);
  const [newProjectName, setNewProjectName] = useState("Meu projeto");
  const isDirtyRef = useRef(isDirty);
  const allowCloseRef = useRef(false);
  const isHydratingRef = useRef(true);
  const hydrationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const confirmedPathRef = useRef(confirmedPath);
  const currentFingerprint = currentDocument
    ? workspaceFingerprint(serializeWorkspace())
    : "";
  const workspaceRevisionRef = useRef(0);
  const previousFingerprintRef = useRef(currentFingerprint);

  useEffect(() => {
    confirmedPathRef.current = confirmedPath;
  }, [confirmedPath]);

  useEffect(() => {
    if (currentFingerprint !== previousFingerprintRef.current) {
      workspaceRevisionRef.current += 1;
      previousFingerprintRef.current = currentFingerprint;
    }
  }, [currentFingerprint]);

  useEffect(() => {
    isDirtyRef.current = isDirty;
  }, [isDirty]);

  // Startup only validates the project history. The project manager remains
  // blocking until the user chooses a real project; no fixture is loaded here.
  useEffect(() => {
    let active = true;
    isHydratingRef.current = true;
    const initializeProjectManager = async () => {
      setProjectManagerOpen(true);
      setProjectManagerError(null);
      setBusy(true);
      const rememberedPath = readRememberedWorkspacePath(window.localStorage);
      const rememberedProjectPath = projectDirectoryFromWorkspacePath(rememberedPath);
      const storedProjects = readRecentProjects(window.localStorage);
      const candidates = rememberedProjectPath && !storedProjects.some((project) => project.path.toLowerCase() === rememberedProjectPath.toLowerCase())
        ? [...storedProjects, { name: projectNameFromPath(rememberedProjectPath), path: rememberedProjectPath, lastOpenedAt: new Date().toISOString() }]
        : storedProjects;
      try {
        const validProjects = await validateRecentProjects(candidates, (workspacePath) => desktopBridge.loadWorkspace(workspacePath));
        if (!active) return;
        setRecentProjects(writeRecentProjects(window.localStorage, validProjects));
        setStatus(validProjects.length > 0 ? "Escolha um projeto recente ou abra/crie outro" : "Crie ou abra um projeto para começar");
      } catch (error) {
        if (active) {
          setProjectManagerError(`Não foi possível validar os projetos recentes: ${String(error)}`);
          setStatus("Escolha um projeto para começar");
        }
      } finally {
        if (active) {
          setBusy(false);
          isHydratingRef.current = false;
        }
      }
    };

    void initializeProjectManager();
    return () => {
      active = false;
      if (hydrationTimerRef.current) clearTimeout(hydrationTimerRef.current);
      hydrationTimerRef.current = null;
    };
  }, [loadWorkspace]);

  // Debounced autosave uses only a path confirmed by a successful open/save.
  // The fingerprint dependency reschedules after edits even while isDirty
  // remains true.
  useEffect(() => {
    const savePath = confirmedPath.trim();
    if (!shouldAutosave(isDirty, isHydratingRef.current, savePath) || !currentDocument) return;

    const timer = setTimeout(async () => {
      try {
        const doc = serializeWorkspace();
        const snapshot = {
          path: savePath,
          workspaceId: doc.payload.id,
          revision: workspaceRevisionRef.current,
          fingerprint: workspaceFingerprint(doc),
        };
        await desktopBridge.saveWorkspace(savePath, doc);
        const currentDoc = useWorkspaceStore.getState().currentDocument;
        const currentDocFingerprint = workspaceFingerprint(serializeWorkspace());
        const canClean = canMarkCleanAfterSave({
          savedPath: snapshot.path,
          currentPath: confirmedPathRef.current.trim(),
          savedWorkspaceId: snapshot.workspaceId,
          currentWorkspaceId: currentDoc?.payload.id,
          savedRevision: snapshot.revision,
          currentRevision: workspaceRevisionRef.current,
          savedFingerprint: snapshot.fingerprint,
          currentFingerprint: currentDocFingerprint,
        });
        if (canClean) {
          markClean();
          setStatus(`Autosalvo: ${savePath}`);
        } else {
          setStatus(`Autosalvo concluído; novas alterações permanecem pendentes: ${savePath}`);
        }
      } catch (err) {
        setStatus(`Erro no autosave — arquivo preservado: ${String(err)}`);
      }
    }, AUTOSAVE_DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [currentDocument, currentFingerprint, confirmedPath, edges, isDirty, markClean, nodes, serializeWorkspace]);

  const confirmDiscardChanges = useCallback(() => {
    return !isDirty || window.confirm(DISCARD_CHANGES_MESSAGE);
  }, [isDirty]);

  // Protect both browser refresh/navigation and the native Tauri close action.
  // The ref keeps the native listener current without re-registering it for
  // every canvas edit.
  useEffect(() => {
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!isDirtyRef.current) return;
      event.preventDefault();
      event.returnValue = "";
    };

    window.addEventListener("beforeunload", handleBeforeUnload);

    if (!desktopBridge.isNative) {
      return () => window.removeEventListener("beforeunload", handleBeforeUnload);
    }

    let mounted = true;
    let unlisten: (() => void) | undefined;
    const currentWindow = getCurrentWindow();
    const closeRequested = currentWindow.onCloseRequested(async (event) => {
      if (allowCloseRef.current || !isDirtyRef.current) return;

      event.preventDefault();
      if (!window.confirm(DISCARD_CHANGES_MESSAGE)) return;

      allowCloseRef.current = true;
      await currentWindow.close();
    });

    void closeRequested
      .then((cleanup) => {
        if (mounted) unlisten = cleanup;
        else cleanup();
      })
      .catch(() => {
        // The browser beforeunload guard remains active if Tauri is unavailable.
      });

    return () => {
      mounted = false;
      window.removeEventListener("beforeunload", handleBeforeUnload);
      unlisten?.();
    };
  }, []);

  const activateProject = useCallback((projectPath: string, workspacePath: string, document: ReturnType<typeof parseWorkspaceDocument>) => {
    isHydratingRef.current = true;
    loadWorkspace(document);
    setPath(workspacePath);
    setConfirmedPath(workspacePath);
    rememberWorkspacePath(window.localStorage, workspacePath);
    setRecentProjects(rememberRecentProject(window.localStorage, {
      name: document.payload.name || projectNameFromPath(projectPath),
      path: projectPath,
    }));
    setProjectManagerOpen(false);
    setProjectManagerError(null);
    setStatus(`Projeto ativo: ${document.payload.name || projectPath}`);
    if (hydrationTimerRef.current) clearTimeout(hydrationTimerRef.current);
    hydrationTimerRef.current = setTimeout(() => {
      hydrationTimerRef.current = null;
      isHydratingRef.current = false;
    }, 100);
  }, [loadWorkspace]);

  const openProjectDirectory = useCallback(async (selectedProjectPath: string) => {
    const projectPath = normalizeProjectPath(selectedProjectPath);
    if (!projectPath) {
      setProjectManagerError("A pasta escolhida precisa ser um caminho absoluto válido.");
      return;
    }
    const workspacePath = workspacePathForProject(projectPath);
    if (confirmedPathRef.current && confirmedPathRef.current.toLowerCase() === workspacePath.toLowerCase()) {
      setProjectManagerOpen(false);
      setStatus(`Projeto já está ativo: ${projectPath}`);
      return;
    }
    if (!confirmDiscardChanges()) return;
    setBusy(true);
    setProjectManagerError(null);
    setStatus(`Abrindo projeto: ${projectPath}`);
    try {
      const workspacePath = workspacePathForProject(projectPath);
      const document = await desktopBridge.loadWorkspace(workspacePath);
      activateProject(projectPath, workspacePath, document);
    } catch (error) {
      setProjectManagerError(`Não foi possível abrir o projeto: ${String(error)}`);
      setStatus("Falha ao abrir projeto — tente novamente ou escolha outra pasta");
    } finally {
      setBusy(false);
    }
  }, [activateProject, confirmDiscardChanges]);

  const createProject = useCallback(async () => {
    if (!confirmDiscardChanges()) return;
    setBusy(true);
    setProjectManagerError(null);
    setStatus("Escolha a pasta do novo projeto…");
    try {
      const selected = await desktopBridge.chooseProjectDirectory();
      if (!selected) {
        setStatus("Criação cancelada");
        return;
      }
      const projectPath = normalizeProjectPath(selected);
      if (!projectPath) throw new Error("A pasta escolhida precisa ser um caminho absoluto válido");
      const name = newProjectName.trim() || projectNameFromPath(projectPath);
      const workspacePath = workspacePathForProject(projectPath);
      if (await desktopBridge.workspacePathExists(workspacePath)) {
        throw new Error("esta pasta já contém workspace.json; use Abrir projeto para preservar seus dados");
      }
      const document = createProjectWorkspaceDocument(name, projectPath);
      await desktopBridge.saveWorkspace(workspacePath, document);
      const loaded = await desktopBridge.loadWorkspace(workspacePath);
      activateProject(projectPath, workspacePath, loaded);
    } catch (error) {
      setProjectManagerError(`Não foi possível criar o projeto: ${String(error)}`);
      setStatus("Falha ao criar projeto — tente novamente");
    } finally {
      setBusy(false);
    }
  }, [activateProject, confirmDiscardChanges, newProjectName]);

  const chooseAndOpenProject = useCallback(async () => {
    setBusy(true);
    setProjectManagerError(null);
    try {
      const selected = await desktopBridge.chooseProjectDirectory();
      if (selected) await openProjectDirectory(selected);
      else setStatus("Abertura cancelada");
    } catch (error) {
      setProjectManagerError(`Falha ao selecionar projeto: ${String(error)}`);
    } finally {
      setBusy(false);
    }
  }, [openProjectDirectory]);

  const openRecentProject = useCallback((project: RecentProject) => {
    void openProjectDirectory(project.path);
  }, [openProjectDirectory]);

  const removeRecent = useCallback((project: RecentProject) => {
    setRecentProjects(removeRecentProject(window.localStorage, project.path));
  }, []);

  const retryProjectHistory = useCallback(async () => {
    setBusy(true);
    setProjectManagerError(null);
    try {
      const validProjects = await validateRecentProjects(readRecentProjects(window.localStorage), (workspacePath) => desktopBridge.loadWorkspace(workspacePath));
      setRecentProjects(writeRecentProjects(window.localStorage, validProjects));
      setStatus(validProjects.length ? "Escolha um projeto recente ou abra/crie outro" : "Crie ou abra um projeto para começar");
    } catch (error) {
      setProjectManagerError(`Não foi possível validar os projetos recentes: ${String(error)}`);
    } finally {
      setBusy(false);
    }
  }, []);

  const newWorkspace = () => {
    if (!confirmDiscardChanges()) return;
    setProjectManagerError(null);
    setProjectManagerOpen(true);
    setStatus("Crie ou abra um novo projeto");
  };

  const openWorkspace = async (selectedPath?: string, skipConfirmation = false) => {
    if (!skipConfirmation && !confirmDiscardChanges()) return;
    const workspacePath = selectedPath?.trim() || path.trim();
    if (!workspacePath) {
      setStatus("Informe um caminho de workspace ou use Abrir…");
      return;
    }
    setBusy(true);
    setStatus(`Abrindo: ${workspacePath}`);
    try {
      const document = await desktopBridge.loadWorkspace(workspacePath);
      loadWorkspace(document);
      setPath(workspacePath);
      setConfirmedPath(workspacePath);
      rememberWorkspacePath(window.localStorage, workspacePath);
      const projectPath = projectDirectoryFromWorkspacePath(workspacePath);
      if (projectPath) {
        setRecentProjects(rememberRecentProject(window.localStorage, {
          name: document.payload.name || projectNameFromPath(projectPath),
          path: projectPath,
        }));
      }
      setProjectManagerOpen(false);
      setStatus(`Aberto: ${workspacePath}`);
    } catch (error) {
      setStatus(`Falha ao abrir: ${String(error)}`);
    } finally {
      setBusy(false);
    }
  };

  const chooseAndOpenWorkspace = async () => {
    if (!confirmDiscardChanges()) return;
    setStatus("Escolha um workspace para abrir…");
    try {
      const selected = await desktopBridge.chooseWorkspaceToOpen();
      if (selected) {
        await openWorkspace(selected, true);
      } else {
        setStatus("Abertura cancelada");
      }
    } catch (error) {
      setStatus(`Falha ao selecionar workspace: ${String(error)}`);
    }
  };

  const saveWorkspace = async () => {
    const workspacePath = path.trim();
    if (!workspacePath) {
      setStatus("Escolha um caminho com Salvar como…");
      return;
    }
    setBusy(true);
    setStatus(`Salvando: ${workspacePath}`);
    try {
      const savedDocument = serializeWorkspace();
      const savedRevision = workspaceRevisionRef.current;
      await desktopBridge.saveWorkspace(workspacePath, savedDocument);
      const currentState = useWorkspaceStore.getState();
      const currentDoc = currentState.currentDocument;
      const canClean = !currentState.isDirty || canMarkCleanAfterSave({
        savedPath: workspacePath,
        currentPath: workspacePath,
        savedWorkspaceId: savedDocument.payload.id,
        currentWorkspaceId: currentDoc?.payload.id,
        savedRevision,
        currentRevision: workspaceRevisionRef.current,
        savedFingerprint: workspaceFingerprint(savedDocument),
        currentFingerprint: workspaceFingerprint(serializeWorkspace()),
      });
      setConfirmedPath(workspacePath);
      rememberWorkspacePath(window.localStorage, workspacePath);
      if (canClean) markClean();
      setStatus(canClean
        ? `Salvo: ${workspacePath}`
        : `Salvo; novas alterações permanecem pendentes: ${workspacePath}`);
    } catch (error) {
      setStatus(`Falha ao salvar: ${String(error)}`);
    } finally {
      setBusy(false);
    }
  };

  const saveWorkspaceAs = async () => {
    setStatus("Escolha onde salvar o workspace…");
    try {
      const selected = await desktopBridge.chooseWorkspaceToSave(path.trim() || DEFAULT_WORKSPACE_PATH);
      if (!selected) {
        setStatus("Salvamento cancelado");
        return;
      }
      setBusy(true);
      setStatus(`Salvando como: ${selected}`);
      const savedDocument = serializeWorkspace();
      const savedRevision = workspaceRevisionRef.current;
      await desktopBridge.saveWorkspace(selected, savedDocument);
      setPath(selected);
      setConfirmedPath(selected);
      rememberWorkspacePath(window.localStorage, selected);
      const projectPath = projectDirectoryFromWorkspacePath(selected);
      if (projectPath) {
        setRecentProjects(rememberRecentProject(window.localStorage, {
          name: savedDocument.payload.name || projectNameFromPath(projectPath),
          path: projectPath,
        }));
      }
      const currentState = useWorkspaceStore.getState();
      const currentDoc = currentState.currentDocument;
      const canClean = !currentState.isDirty || canMarkCleanAfterSave({
        savedPath: selected,
        currentPath: selected,
        savedWorkspaceId: savedDocument.payload.id,
        currentWorkspaceId: currentDoc?.payload.id,
        savedRevision,
        currentRevision: workspaceRevisionRef.current,
        savedFingerprint: workspaceFingerprint(savedDocument),
        currentFingerprint: workspaceFingerprint(serializeWorkspace()),
      });
      if (canClean) markClean();
      setStatus(canClean ? `Salvo: ${selected}` : `Salvo; novas alterações permanecem pendentes: ${selected}`);
    } catch (error) {
      setStatus(`Falha ao salvar: ${String(error)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="app-container" style={{ width: "100vw", height: "100vh", backgroundColor: "#09090b", overflow: "hidden" }}>
      <Sidebar
        path={path}
        confirmedPath={confirmedPath}
        isDirty={isDirty}
        status={status}
        busy={busy}
        recentProjects={recentProjects}
        onPathChange={setPath}
        onOpenWorkspacePath={() => void openWorkspace()}
        onNewWorkspace={newWorkspace}
        onChooseAndOpenWorkspace={() => void chooseAndOpenWorkspace()}
        onSaveWorkspace={() => void saveWorkspace()}
        onSaveWorkspaceAs={() => void saveWorkspaceAs()}
        onOpenProject={(projectPath) => void openProjectDirectory(projectPath)}
        onRemoveRecentProject={(projectPath) => removeRecent({ name: "", path: projectPath, lastOpenedAt: "" })}
        onOpenProjectManager={() => setProjectManagerOpen(true)}
      />
      {projectManagerOpen && (
        <ProjectManagerModal
          projects={recentProjects}
          projectName={newProjectName}
          busy={busy}
          error={projectManagerError}
          onProjectNameChange={setNewProjectName}
          onCreate={() => void createProject()}
          onOpen={() => void chooseAndOpenProject()}
          onOpenRecent={openRecentProject}
          onRemoveRecent={removeRecent}
          onRetry={() => void retryProjectHistory()}
          onCancel={confirmedPath ? () => setProjectManagerOpen(false) : undefined}
        />
      )}
      <CanvasWorkspace workspacePath={confirmedPath || undefined} />
      <AppContextMenu />
    </div>
  );
};

export default App;
