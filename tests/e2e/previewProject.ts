import { expect, type Page } from "@playwright/test";

export const PREVIEW_PROJECT_DIRECTORY = "C:\\Maestri-E2E";
export const PREVIEW_WORKSPACE_PATH = `${PREVIEW_PROJECT_DIRECTORY}\\workspace.json`;

const workspaceTemplate = {
  schemaVersion: 2,
  type: "workspace",
  payload: {
    id: "00000000-0000-0000-0000-000000000001",
    name: "Maestri E2E",
    icon: "folder",
    isPinned: false,
    locationType: "local",
    workingDirectory: PREVIEW_PROJECT_DIRECTORY,
    preferredIDE: "cursor",
    syncConfigFiles: false,
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
    createdAt: "2026-08-23T00:00:00.000Z",
    lastModifiedAt: "2026-08-23T00:00:00.000Z",
  },
};

export async function openPreviewProject(page: Page): Promise<void> {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.evaluate(({ template, projectDirectory, workspacePath }) => {
    window.localStorage.clear();
    const now = new Date().toISOString();
    const document = {
      ...template,
      payload: {
        ...template.payload,
        id: crypto.randomUUID(),
        name: "Maestri E2E",
        workingDirectory: projectDirectory,
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
    window.localStorage.setItem(`maestri-workspace:${workspacePath}`, JSON.stringify(document));
    window.localStorage.setItem("maestri-project-history-v1", JSON.stringify([{
      name: "Maestri E2E",
      path: projectDirectory,
      lastOpenedAt: now,
    }]));
    window.localStorage.setItem("maestri-last-workspace-path", workspacePath);
  }, {
    template: workspaceTemplate,
    projectDirectory: PREVIEW_PROJECT_DIRECTORY,
    workspacePath: PREVIEW_WORKSPACE_PATH,
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await openRecentProject(page, PREVIEW_PROJECT_DIRECTORY);
}

export async function openRecentProject(page: Page, projectDirectory: string): Promise<void> {
  const dialog = page.getByRole("dialog", { name: "Gerenciador de Projetos" });
  await expect(dialog).toBeVisible();
  const projectButton = dialog.locator("li button").filter({ hasText: projectDirectory }).first();
  await expect(projectButton).toBeVisible();
  await projectButton.click();
  await expect(dialog).toBeHidden();
}
