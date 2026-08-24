import { describe, expect, it } from "vitest";
import {
  dedupeRecentProjects,
  normalizeProjectPath,
  readRecentProjects,
  rememberRecentProject,
  validateRecentProjects,
  workspacePathForProject,
  projectDirectoryFromWorkspacePath,
  writeRecentProjects,
} from "./projectManager";
import { createProjectWorkspaceDocument } from "./App";

function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}

describe("project manager history", () => {
  it("normalizes Windows roots without losing absolute semantics", () => {
    expect(normalizeProjectPath("C:\\")).toBe("C:\\");
    expect(normalizeProjectPath("C:/Maestri/Project/")).toBe("C:\\Maestri\\Project");
    expect(workspacePathForProject("C:\\Maestri\\Project")).toBe("C:\\Maestri\\Project\\workspace.json");
    expect(workspacePathForProject("C:\\")).toBe("C:\\workspace.json");
    expect(projectDirectoryFromWorkspacePath("C:\\workspace.json")).toBe("C:\\");
  });

  it("deduplicates paths, drops malformed entries, and keeps newest metadata", () => {
    const result = dedupeRecentProjects([
      { name: "Old", path: "C:\\Project", lastOpenedAt: "2026-01-01T00:00:00.000Z" },
      { name: "Newest", path: "c:/project/", lastOpenedAt: "2026-02-01T00:00:00.000Z" },
      { name: "bad\nname", path: "C:\\bad", lastOpenedAt: "2026-02-01T00:00:00.000Z" },
      { name: "bad path", path: "relative", lastOpenedAt: "2026-02-01T00:00:00.000Z" },
    ]);
    expect(result).toEqual([{ name: "Newest", path: "c:\\project", lastOpenedAt: "2026-02-01T00:00:00.000Z" }]);
  });

  it("removes projects whose real workspace load fails", async () => {
    const projects = [
      { name: "Valid", path: "C:\\valid", lastOpenedAt: "2026-02-01T00:00:00.000Z" },
      { name: "Missing", path: "C:\\missing", lastOpenedAt: "2026-01-01T00:00:00.000Z" },
    ];
    const valid = await validateRecentProjects(projects, async (workspacePath) => {
      if (workspacePath.includes("missing")) throw new Error("not found");
      return { schemaVersion: 2, type: "workspace" };
    });
    expect(valid.map((project) => project.name)).toEqual(["Valid"]);
  });

  it("persists only successful recent project records", () => {
    const target = storage();
    writeRecentProjects(target, []);
    const history = rememberRecentProject(target, { name: "Project", path: "C:\\Project" }, "2026-02-01T00:00:00.000Z");
    expect(history).toHaveLength(1);
    expect(readRecentProjects(target)).toEqual(history);
  });

  it("creates an empty workspace document compatible with schema v2", () => {
    const document = createProjectWorkspaceDocument("Demo", "C:\\Demo");
    expect(document.schemaVersion).toBe(2);
    expect(document.type).toBe("workspace");
    expect(document.payload.name).toBe("Demo");
    expect(document.payload.workingDirectory).toBe("C:\\Demo");
    expect(document.payload.nodes).toEqual([]);
    expect(document.payload.connections).toEqual([]);
    expect(document.payload.drawings).toEqual([]);
  });
});
