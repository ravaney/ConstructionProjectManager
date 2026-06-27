import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AppUser, Attachment, FloorPlanMarkupPlan, FloorPlanStroke, Project, Task, TaskFocusRequest, TaskInput } from "../types/models";
import { api, resolveAssetUrl } from "../utils/api";
import { TaskBoard } from "./TaskBoard";
import { TeamManagement } from "./TeamManagement";
import { WorkerProfiles } from "./WorkerProfiles";

type ProjectManagementProps = {
  project: Project | null;
  currentUser: AppUser;
  tasks: Task[];
  canDeleteTask: boolean;
  canDeleteWorker: boolean;
  focusTaskRequest?: TaskFocusRequest | null;
  onCreateTask: (payload: TaskInput) => Promise<void>;
  onUpdateTask: (id: string, payload: Partial<TaskInput>) => Promise<void>;
  onDeleteTask: (id: string) => Promise<void>;
  onClearAllPhases: () => Promise<void>;
  onRefreshData: () => Promise<void>;
  onUpdateProject: (payload: Partial<Pick<Project, "name" | "phase" | "totalBudget" | "currency" | "notes" | "floorPlanMarkup">>) => Promise<void>;
  onTaskFocusHandled?: () => void;
};

type ManagementTab = "planner" | "people" | "floorplan";

type MarkupStroke = FloorPlanStroke;
type FloorPlanPlan = FloorPlanMarkupPlan;
const MANAGEMENT_TAB_STORAGE_KEY = "project_management_active_tab";
const managementTabs: ManagementTab[] = ["planner", "people", "floorplan"];

function isManagementTab(value: string | null): value is ManagementTab {
  if (!value) {
    return false;
  }

  return managementTabs.includes(value as ManagementTab);
}

function toPoint(event: PointerEvent | React.PointerEvent, element: HTMLElement) {
  const rect = element.getBoundingClientRect();
  const x = Math.min(1, Math.max(0, (event.clientX - rect.left) / Math.max(1, rect.width)));
  const y = Math.min(1, Math.max(0, (event.clientY - rect.top) / Math.max(1, rect.height)));
  return { x, y };
}

function getPolylinePoints(stroke: MarkupStroke): string {
  return stroke.points.map((point) => `${point.x * 100},${point.y * 100}`).join(" ");
}

function getDefaultFloorName(index: number): string {
  return `Floor ${index + 1}`;
}

function getFloorName(
  attachment: Attachment,
  index: number,
  plans: FloorPlanPlan[]
): string {
  const existing = plans.find((plan) => plan.attachmentId === attachment._id);
  if (existing?.name?.trim()) {
    return existing.name.trim();
  }

  return getDefaultFloorName(index);
}

function mergePlansWithAttachments(attachments: Attachment[], plans: FloorPlanPlan[], legacyStrokes: MarkupStroke[]): FloorPlanPlan[] {
  const normalizedPlans = plans.map((plan) => ({
    attachmentId: plan.attachmentId,
    name: plan.name.trim(),
    strokes: plan.strokes ?? []
  }));
  const normalizedByAttachment = new Map(normalizedPlans.map((plan) => [plan.attachmentId, plan]));
  const firstAttachmentId = attachments[0]?._id;

  return attachments.map((attachment, index) => {
    const existing = normalizedByAttachment.get(attachment._id);
    if (existing) {
      return {
        ...existing,
        name: existing.name || getDefaultFloorName(index)
      };
    }

    return {
      attachmentId: attachment._id,
      name: getDefaultFloorName(index),
      strokes: index === 0 && firstAttachmentId === attachment._id ? legacyStrokes : []
    };
  });
}

function normalizePlansForSave(plans: FloorPlanPlan[]): FloorPlanPlan[] {
  return plans.map((plan) => ({
    ...plan,
    name: plan.name.trim() || "Unnamed Floor"
  }));
}

function getPlansSnapshot(plans: FloorPlanPlan[]): string {
  return JSON.stringify(normalizePlansForSave(plans));
}

function renderManagementTabIcon(tab: ManagementTab) {
  const iconProps = {
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true
  };

  if (tab === "planner") {
    return (
      <svg {...iconProps}>
        <path d="M4 6h16" />
        <path d="M4 12h10" />
        <path d="M4 18h7" />
      </svg>
    );
  }

  if (tab === "people") {
    return (
      <svg {...iconProps}>
        <circle cx="9" cy="8" r="3" />
        <path d="M4 19c0-2.8 2.4-5 5-5s5 2.2 5 5" />
        <circle cx="17" cy="9" r="2" />
        <path d="M14.7 19c.1-1.9 1.6-3.5 3.3-3.9" />
      </svg>
    );
  }

  if (tab === "floorplan") {
    return (
      <svg {...iconProps}>
        <path d="M4 4h16v16H4z" />
        <path d="M10 4v8h10" />
        <path d="M4 12h6" />
      </svg>
    );
  }

  return (
    <svg {...iconProps}>
      <path d="M4 18V8" />
      <path d="M10 18V5" />
      <path d="M16 18v-6" />
      <path d="M22 18V3" />
    </svg>
  );
}

export function ProjectManagement({
  project,
  currentUser,
  tasks,
  canDeleteTask,
  canDeleteWorker,
  focusTaskRequest,
  onCreateTask,
  onUpdateTask,
  onDeleteTask,
  onClearAllPhases,
  onRefreshData,
  onUpdateProject,
  onTaskFocusHandled
}: ProjectManagementProps) {
  const [activeTab, setActiveTab] = useState<ManagementTab>(() => {
    if (typeof window === "undefined") {
      return "planner";
    }

    try {
      const storedTab = window.localStorage.getItem(MANAGEMENT_TAB_STORAGE_KEY);
      return isManagementTab(storedTab) ? storedTab : "planner";
    } catch {
      return "planner";
    }
  });
  const [projectAttachments, setProjectAttachments] = useState<Attachment[]>([]);
  const [floorPlans, setFloorPlans] = useState<FloorPlanPlan[]>([]);
  const [selectedAttachmentId, setSelectedAttachmentId] = useState("");
  const [newFloorName, setNewFloorName] = useState("");
  const [uploadingPlan, setUploadingPlan] = useState(false);
  const [floorPlanError, setFloorPlanError] = useState("");
  const [strokeColor, setStrokeColor] = useState("#ff3b30");
  const [strokeWidth, setStrokeWidth] = useState(2);
  const [zoomPercent, setZoomPercent] = useState(100);
  const [isPenEnabled, setIsPenEnabled] = useState(false);
  const [draftStroke, setDraftStroke] = useState<MarkupStroke | null>(null);
  const [isPointerDrawing, setIsPointerDrawing] = useState(false);
  const [isPanning, setIsPanning] = useState(false);
  const [savingMarkup, setSavingMarkup] = useState(false);
  const [launchCreateWorkItem, setLaunchCreateWorkItem] = useState<(() => void) | null>(null);
  const drawingSurfaceRef = useRef<HTMLDivElement | null>(null);
  const drawingCanvasRef = useRef<HTMLDivElement | null>(null);
  const panOriginRef = useRef<{ x: number; y: number; scrollLeft: number; scrollTop: number } | null>(null);
  const autosaveTimerRef = useRef<number | null>(null);
  const lastSavedPlansSnapshotRef = useRef<string>("");

  const selectedFloorPlan = useMemo(
    () => projectAttachments.find((attachment) => attachment._id === selectedAttachmentId) ?? projectAttachments[0],
    [projectAttachments, selectedAttachmentId]
  );
  const selectedFloorPlanModel = useMemo(
    () => floorPlans.find((plan) => plan.attachmentId === selectedFloorPlan?._id) ?? null,
    [floorPlans, selectedFloorPlan?._id]
  );
  const selectedFloorPlanStrokes = selectedFloorPlanModel?.strokes ?? [];
  const zoomScale = Math.max(0.4, zoomPercent / 100);

  const registerCreateWorkItemLauncher = useCallback((launch: (() => void) | null) => {
    setLaunchCreateWorkItem(() => launch);
  }, []);

  useEffect(() => {
    const plans = project?.floorPlanMarkup?.plans ?? [];
    const legacyStrokes = project?.floorPlanMarkup?.strokes ?? [];
    const merged = mergePlansWithAttachments(projectAttachments, plans, legacyStrokes);
    setFloorPlans(merged);
    lastSavedPlansSnapshotRef.current = getPlansSnapshot(merged);
  }, [project?.floorPlanMarkup?.plans, project?.floorPlanMarkup?.strokes, projectAttachments]);

  useEffect(() => {
    const projectId = project?._id;
    if (!projectId) {
      setProjectAttachments([]);
      setFloorPlans([]);
      return;
    }

    async function loadProjectAttachments() {
      try {
        setFloorPlanError("");
        const response = await api.getAttachments("project", projectId);
        const images = response.attachments.filter((attachment) => attachment.mimeType.startsWith("image/"));
        setProjectAttachments(images);
      } catch (requestError) {
        setFloorPlanError(requestError instanceof Error ? requestError.message : "Could not load floor plan files");
      }
    }

    loadProjectAttachments().catch(() => {
      // State already handled.
    });
  }, [project?._id]);

  useEffect(() => {
    if (!selectedFloorPlan && projectAttachments.length > 0) {
      setSelectedAttachmentId(projectAttachments[0]._id);
      return;
    }

    if (selectedFloorPlan && !projectAttachments.some((attachment) => attachment._id === selectedFloorPlan._id)) {
      setSelectedAttachmentId(projectAttachments[0]?._id ?? "");
    }
  }, [projectAttachments, selectedFloorPlan]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    try {
      window.localStorage.setItem(MANAGEMENT_TAB_STORAGE_KEY, activeTab);
    } catch {
      // Ignore localStorage write issues.
    }
  }, [activeTab]);

  useEffect(() => {
    if (!focusTaskRequest) {
      return;
    }

    setActiveTab("planner");
  }, [focusTaskRequest?.requestKey]);

  useEffect(() => {
    setZoomPercent(100);
    setDraftStroke(null);
    setIsPointerDrawing(false);
    setIsPanning(false);
  }, [selectedAttachmentId]);

  useEffect(() => {
    if (!project?._id) {
      return;
    }

    const nextSnapshot = getPlansSnapshot(floorPlans);
    if (nextSnapshot === lastSavedPlansSnapshotRef.current) {
      return;
    }

    if (autosaveTimerRef.current !== null) {
      window.clearTimeout(autosaveTimerRef.current);
    }

    autosaveTimerRef.current = window.setTimeout(async () => {
      setSavingMarkup(true);
      setFloorPlanError("");
      try {
        const normalizedPlans = normalizePlansForSave(floorPlans);
        await onUpdateProject({
          floorPlanMarkup: {
            plans: normalizedPlans
          }
        });
        lastSavedPlansSnapshotRef.current = getPlansSnapshot(normalizedPlans);
      } catch (requestError) {
        setFloorPlanError(requestError instanceof Error ? requestError.message : "Could not autosave floor plan updates");
      } finally {
        setSavingMarkup(false);
      }
    }, 450);

    return () => {
      if (autosaveTimerRef.current !== null) {
        window.clearTimeout(autosaveTimerRef.current);
        autosaveTimerRef.current = null;
      }
    };
  }, [floorPlans, onUpdateProject, project?._id]);

  function startDraw(event: React.PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || !drawingCanvasRef.current || !selectedFloorPlan || !isPenEnabled) {
      return;
    }

    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const point = toPoint(event, event.currentTarget);
    setDraftStroke({
      color: strokeColor,
      width: strokeWidth,
      points: [point]
    });
    setIsPointerDrawing(true);
  }

  function continueDraw(event: React.PointerEvent<HTMLDivElement>) {
    if (!drawingCanvasRef.current || !draftStroke || !selectedFloorPlan || !isPointerDrawing || (event.buttons & 1) !== 1) {
      return;
    }

    event.preventDefault();
    const point = toPoint(event, event.currentTarget);
    setDraftStroke((current) => (current ? { ...current, points: [...current.points, point] } : current));
  }

  function endDraw(event?: React.PointerEvent<HTMLDivElement>) {
    if (event && event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    setIsPointerDrawing(false);
    if (!draftStroke || !selectedFloorPlan) {
      return;
    }

    if (draftStroke.points.length >= 2) {
      setFloorPlans((current) =>
        current.map((plan) =>
          plan.attachmentId === selectedFloorPlan._id ? { ...plan, strokes: [...plan.strokes, draftStroke] } : plan
        )
      );
    }
    setDraftStroke(null);
  }

  function handleSurfaceWheel(event: React.WheelEvent<HTMLDivElement>) {
    const surface = drawingSurfaceRef.current;
    if (!selectedFloorPlan || !surface) {
      return;
    }

    event.preventDefault();
    const delta = event.deltaY < 0 ? 10 : -10;
    const currentZoom = zoomPercent;
    const nextZoom = Math.max(40, Math.min(220, currentZoom + delta));
    if (nextZoom === currentZoom) {
      return;
    }

    const rect = surface.getBoundingClientRect();
    const offsetX = event.clientX - rect.left + surface.scrollLeft;
    const offsetY = event.clientY - rect.top + surface.scrollTop;
    const ratio = nextZoom / currentZoom;

    setZoomPercent(nextZoom);
    requestAnimationFrame(() => {
      surface.scrollLeft = offsetX * ratio - (event.clientX - rect.left);
      surface.scrollTop = offsetY * ratio - (event.clientY - rect.top);
    });
  }

  function startPan(event: React.PointerEvent<HTMLDivElement>) {
    if (isPenEnabled || event.button !== 0) {
      return;
    }

    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    panOriginRef.current = {
      x: event.clientX,
      y: event.clientY,
      scrollLeft: event.currentTarget.scrollLeft,
      scrollTop: event.currentTarget.scrollTop
    };
    setIsPanning(true);
  }

  function continuePan(event: React.PointerEvent<HTMLDivElement>) {
    if (!isPanning || !panOriginRef.current) {
      return;
    }

    event.preventDefault();
    const deltaX = event.clientX - panOriginRef.current.x;
    const deltaY = event.clientY - panOriginRef.current.y;
    event.currentTarget.scrollLeft = panOriginRef.current.scrollLeft - deltaX;
    event.currentTarget.scrollTop = panOriginRef.current.scrollTop - deltaY;
  }

  function endPan(event: React.PointerEvent<HTMLDivElement>) {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }

    panOriginRef.current = null;
    setIsPanning(false);
  }

  async function uploadFloorPlan(file: File, floorName: string) {
    if (!project?._id) {
      return;
    }

    setUploadingPlan(true);
    setFloorPlanError("");
    try {
      await api.uploadAttachment({ entityType: "project", entityId: project._id, file });
      const response = await api.getAttachments("project", project._id);
      const images = response.attachments.filter((attachment) => attachment.mimeType.startsWith("image/"));
      setProjectAttachments(images);
      if (images.length > 0) {
        const latest = images[0];
        const defaultName = getDefaultFloorName(images.length - 1);
        const resolvedName = floorName.trim() || defaultName;
        const nextPlans = mergePlansWithAttachments(images, floorPlans, project.floorPlanMarkup?.strokes ?? []).map((plan) =>
          plan.attachmentId === latest._id ? { ...plan, name: resolvedName } : plan
        );

        setFloorPlans(nextPlans);
        setSelectedAttachmentId(latest._id);
        await onUpdateProject({
          floorPlanMarkup: {
            plans: nextPlans
          }
        });
        lastSavedPlansSnapshotRef.current = getPlansSnapshot(nextPlans);
      }
    } catch (requestError) {
      setFloorPlanError(requestError instanceof Error ? requestError.message : "Floor plan upload failed");
    } finally {
      setUploadingPlan(false);
      setNewFloorName("");
    }
  }

  async function removeSelectedFloorPlan() {
    if (!selectedFloorPlan) {
      return;
    }

    setFloorPlanError("");
    try {
      await api.deleteAttachment(selectedFloorPlan._id);
      const remainingAttachments = projectAttachments.filter((attachment) => attachment._id !== selectedFloorPlan._id);
      const nextPlans = floorPlans.filter((plan) => plan.attachmentId !== selectedFloorPlan._id);
      setProjectAttachments(remainingAttachments);
      setFloorPlans(nextPlans);
      setSelectedAttachmentId(remainingAttachments[0]?._id ?? "");
      await onUpdateProject({
        floorPlanMarkup: {
          plans: nextPlans
        }
      });
      lastSavedPlansSnapshotRef.current = getPlansSnapshot(nextPlans);
    } catch (requestError) {
      setFloorPlanError(requestError instanceof Error ? requestError.message : "Could not remove floor plan");
    }
  }

  function renameSelectedFloorPlan(name: string) {
    if (!selectedFloorPlan) {
      return;
    }

    setFloorPlans((current) =>
      current.map((plan) =>
        plan.attachmentId === selectedFloorPlan._id
          ? {
              ...plan,
              name: name.trimStart()
            }
          : plan
      )
    );
  }

  return (
    <section className="stack-lg project-management-page">
      <div className="panel project-management-shell">
        <div className="project-management-top">
          <div className="project-management-heading">
            <p className="eyebrow">Project Management</p>
            <h3>Build Execution Workspace</h3>
          </div>
          <div className="project-management-toolbar-actions">
            <div className="project-management-tabs project-management-tabs-icons">
              {([
                { key: "planner", label: "Phase Planner" },
                { key: "people", label: "Team & Workers" },
                { key: "floorplan", label: "Floor Plan" }
              ] as Array<{ key: ManagementTab; label: string }>).map((tab) => (
                <button
                  key={tab.key}
                  type="button"
                  className={activeTab === tab.key ? "active" : ""}
                  onClick={() => setActiveTab(tab.key)}
                  title={tab.label}
                  aria-label={tab.label}
                >
                  {renderManagementTabIcon(tab.key)}
                </button>
              ))}
            </div>
            {activeTab === "planner" && (
              <button
                className="project-management-icon-action"
                type="button"
                onClick={() => launchCreateWorkItem?.()}
                disabled={!launchCreateWorkItem}
                title="Create Work Item"
                aria-label="Create Work Item"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M12 5v14" />
                  <path d="M5 12h14" />
                </svg>
              </button>
            )}
          </div>
        </div>
      </div>

        {activeTab === "planner" && (
          <TaskBoard
            tasks={tasks}
            canDeleteTask={canDeleteTask}
            focusTaskRequest={focusTaskRequest}
            onCreateTask={onCreateTask}
            onUpdateTask={onUpdateTask}
            onDeleteTask={onDeleteTask}
            onClearAllPhases={onClearAllPhases}
            onRefreshData={onRefreshData}
            onRegisterCreateLauncher={registerCreateWorkItemLauncher}
            onTaskFocusHandled={onTaskFocusHandled}
          />
        )}

        {activeTab === "people" && (
          <div className="stack-lg team-workers-layout">
            <WorkerProfiles canDelete={canDeleteWorker} />
            <TeamManagement currentUser={currentUser} />
          </div>
        )}

        {activeTab === "floorplan" && (
          <div className="panel floor-plan-layout">
            <aside className="floor-plan-sidebar stack-sm">
              <div>
                <h3>Floor Plan Viewer</h3>
                <p className="muted">Upload named floors, switch between them, zoom in, and draw markup per floor.</p>
              </div>

              <div className="floor-plan-upload-bar">
                <label className="floor-plan-upload-name">
                  Floor Name
                  <input
                    value={newFloorName}
                    placeholder={`e.g. ${getDefaultFloorName(projectAttachments.length)}`}
                    onChange={(event) => setNewFloorName(event.target.value)}
                  />
                </label>
                <label className="btn ghost" style={{ cursor: "pointer" }}>
                  {uploadingPlan ? "Uploading..." : "Upload Floor"}
                  <input
                    type="file"
                    accept="image/*"
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      if (file) {
                        uploadFloorPlan(file, newFloorName).catch(() => {
                          // State already handled.
                        });
                      }
                      event.target.value = "";
                    }}
                    style={{ display: "none" }}
                  />
                </label>
              </div>

              {projectAttachments.length > 0 && (
                <div className="floor-plan-selector-panel">
                  <span className="floor-plan-section-label">Floors</span>
                  <div className="floor-plan-selector-menu" role="tablist" aria-label="Select floor plan">
                    {projectAttachments.map((attachment, index) => {
                      const isActive = attachment._id === selectedFloorPlan?._id;
                      return (
                        <button
                          key={attachment._id}
                          type="button"
                          role="tab"
                          aria-selected={isActive}
                          className={isActive ? "active" : ""}
                          onClick={() => setSelectedAttachmentId(attachment._id)}
                          title={attachment.fileName}
                        >
                          {getFloorName(attachment, index, floorPlans)}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {selectedFloorPlan ? (
                <>
                  <div className="floor-plan-controls">
                    <label className="floor-plan-name-edit">
                      Plan Name
                      <input
                        value={selectedFloorPlanModel?.name ?? ""}
                        onChange={(event) => renameSelectedFloorPlan(event.target.value)}
                      />
                    </label>
                  </div>

                  <div className="floor-plan-action-row">
                    <button className="btn ghost" type="button" onClick={() => removeSelectedFloorPlan()} disabled={savingMarkup}>
                      Remove Floor
                    </button>
                  </div>
                </>
              ) : (
                <p className="muted">No floor plan uploaded yet.</p>
              )}

              {floorPlanError && <p className="error-text">{floorPlanError}</p>}
            </aside>

            <div className="floor-plan-stage">
              {selectedFloorPlan ? (
                <>
                  <div className="floor-plan-canvas-toolbar" onPointerDown={(event) => event.stopPropagation()}>
                    <button
                      className={`floor-plan-tool-icon ${isPenEnabled ? "active" : ""}`}
                      type="button"
                      title={isPenEnabled ? "Disable Pencil" : "Enable Pencil"}
                      aria-label={isPenEnabled ? "Disable Pencil" : "Enable Pencil"}
                      onClick={() => setIsPenEnabled((current) => !current)}
                    >
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M12 20h9" />
                        <path d="m16.5 3.5 4 4L7 21H3v-4Z" />
                      </svg>
                    </button>
                    <button
                      className="floor-plan-tool-icon"
                      type="button"
                      title="Undo"
                      aria-label="Undo"
                      onClick={() =>
                        setFloorPlans((current) =>
                          current.map((plan) =>
                            plan.attachmentId === selectedFloorPlan._id ? { ...plan, strokes: plan.strokes.slice(0, -1) } : plan
                          )
                        )
                      }
                      disabled={selectedFloorPlanStrokes.length === 0}
                    >
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M9 14 4 9l5-5" />
                        <path d="M4 9h10a6 6 0 1 1 0 12h-1" />
                      </svg>
                    </button>
                    <button
                      className="floor-plan-tool-icon"
                      type="button"
                      title="Clear"
                      aria-label="Clear"
                      onClick={() =>
                        setFloorPlans((current) =>
                          current.map((plan) => (plan.attachmentId === selectedFloorPlan._id ? { ...plan, strokes: [] } : plan))
                        )
                      }
                      disabled={selectedFloorPlanStrokes.length === 0}
                    >
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M3 6h18" />
                        <path d="M8 6V4h8v2" />
                        <path d="m19 6-1 14H6L5 6" />
                      </svg>
                    </button>
                    <label className="floor-plan-tool-icon floor-plan-tool-color" title="Pen Color" aria-label="Pen Color">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M12 3v18" />
                        <path d="M3 12h18" />
                      </svg>
                      <input type="color" value={strokeColor} onChange={(event) => setStrokeColor(event.target.value)} />
                    </label>
                    <label className="floor-plan-tool-icon floor-plan-tool-width" title="Pen Width" aria-label="Pen Width">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M4 12h16" />
                        <path d="M8 8h8" />
                        <path d="M6 16h12" />
                      </svg>
                      <input
                        type="number"
                        min={1}
                        max={32}
                        step={1}
                        value={strokeWidth}
                        onChange={(event) => {
                          const next = Number(event.target.value);
                          if (!Number.isFinite(next)) {
                            return;
                          }
                          setStrokeWidth(Math.max(1, Math.min(32, next)));
                        }}
                      />
                    </label>
                    <span className="floor-plan-tool-zoom">{zoomPercent}%</span>
                  </div>
                  <div
                    className={`floor-plan-surface ${isPenEnabled ? "pen-mode" : "pan-mode"} ${isPanning ? "is-panning" : ""}`}
                    ref={drawingSurfaceRef}
                    onWheel={handleSurfaceWheel}
                    onPointerDown={startPan}
                    onPointerMove={continuePan}
                    onPointerUp={endPan}
                    onPointerCancel={endPan}
                    onPointerLeave={endPan}
                  >
                    <div
                      className={`floor-plan-canvas ${isPenEnabled ? "pen-enabled" : ""}`}
                      ref={drawingCanvasRef}
                      style={{ width: `${zoomPercent}%` }}
                      onPointerDown={startDraw}
                      onPointerMove={continueDraw}
                      onPointerUp={endDraw}
                      onPointerCancel={endDraw}
                      onPointerLeave={endDraw}
                    >
                      <img
                        src={resolveAssetUrl(selectedFloorPlan.url)}
                        alt={selectedFloorPlan.fileName}
                        draggable={false}
                        onDragStart={(event) => event.preventDefault()}
                      />
                      <svg className="floor-plan-markup-layer" viewBox="0 0 100 100" preserveAspectRatio="none">
                        {selectedFloorPlanStrokes.map((stroke, index) => (
                          <polyline
                            key={`stroke-${index}`}
                            fill="none"
                            stroke={stroke.color}
                            strokeWidth={((stroke.width / 400) * 100) / zoomScale}
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            points={getPolylinePoints(stroke)}
                          />
                        ))}
                        {draftStroke && (
                          <polyline
                            fill="none"
                            stroke={draftStroke.color}
                            strokeWidth={((draftStroke.width / 400) * 100) / zoomScale}
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            points={getPolylinePoints(draftStroke)}
                          />
                        )}
                      </svg>
                    </div>
                    {savingMarkup && (
                      <div className="floor-plan-autosave-indicator" aria-live="polite">
                        <span className="spinner" aria-hidden="true" />
                        Autosaving...
                      </div>
                    )}
                  </div>
                </>
              ) : (
                <div className="floor-plan-empty">
                  <p className="muted">No floor plan uploaded yet.</p>
                </div>
              )}
            </div>
          </div>
        )}
    </section>
  );
}
