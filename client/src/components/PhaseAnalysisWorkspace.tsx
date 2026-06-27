import { useEffect, useMemo, useRef, useState } from "react";
import type { AppUser, PhaseAnalysisApplyResult, PhaseAnalysisOperation, PhaseAnalysisPreview, Task } from "../types/models";
import { api } from "../utils/api";
import { getTaskStatusLabel } from "../utils/taskStatus";

type PhaseAnalysisWorkspaceProps = {
  tasks: Task[];
  currentUser: AppUser;
  currentPhaseTaskId?: string;
  selectedModel?: string;
  selectedModelLabel: string;
  onProjectMutation?: () => Promise<void> | void;
};

type AnalysisLoadState = "idle" | "preview" | "apply";
type SuggestionLoadState = "idle" | "loading" | "error";

function getOperationTone(kind: PhaseAnalysisOperation["kind"]) {
  switch (kind) {
    case "CREATE_SECTION":
    case "CREATE_TASK":
      return "create";
    case "UPDATE_SECTION":
    case "UPDATE_TASK":
      return "update";
    case "MOVE_TASK":
      return "move";
    case "DELETE_SECTION":
    case "DELETE_TASK":
      return "delete";
    default:
      return "neutral";
  }
}

function getOperationLabel(kind: PhaseAnalysisOperation["kind"]) {
  switch (kind) {
    case "CREATE_SECTION":
      return "Create Section";
    case "UPDATE_SECTION":
      return "Update Section";
    case "DELETE_SECTION":
      return "Delete Section";
    case "CREATE_TASK":
      return "Create Task";
    case "UPDATE_TASK":
      return "Update Task";
    case "MOVE_TASK":
      return "Move Task";
    case "DELETE_TASK":
      return "Delete Task";
    default:
      return kind;
  }
}

function buildOperationMeta(operation: PhaseAnalysisOperation, tasksById: Map<string, Task>) {
  switch (operation.kind) {
    case "CREATE_SECTION":
      return [`New section: ${operation.title}`, operation.status ? `Status: ${getTaskStatusLabel(operation.status)}` : ""].filter(Boolean);
    case "UPDATE_SECTION": {
      const section = tasksById.get(operation.sectionTaskId);
      return [
        section ? `Section: ${section.title}` : "",
        operation.title ? `Rename to: ${operation.title}` : "",
        operation.status ? `Status: ${getTaskStatusLabel(operation.status)}` : ""
      ].filter(Boolean);
    }
    case "DELETE_SECTION": {
      const section = tasksById.get(operation.sectionTaskId);
      return [section ? `Section: ${section.title}` : "Section will be removed"];
    }
    case "CREATE_TASK":
      return [
        `New task: ${operation.title}`,
        operation.status ? `Status: ${getTaskStatusLabel(operation.status)}` : "",
        typeof operation.estimateAmount === "number" ? `Estimate: $${operation.estimateAmount.toLocaleString()}` : ""
      ].filter(Boolean);
    case "UPDATE_TASK": {
      const task = tasksById.get(operation.taskId);
      return [
        task ? `Task: ${task.wbsId ?? "--"} ${task.title}` : "",
        operation.title ? `Rename to: ${operation.title}` : "",
        operation.status ? `Status: ${getTaskStatusLabel(operation.status)}` : ""
      ].filter(Boolean);
    }
    case "MOVE_TASK": {
      const task = tasksById.get(operation.taskId);
      const targetSection = operation.targetSectionTaskId ? tasksById.get(operation.targetSectionTaskId) : null;
      return [
        task ? `Task: ${task.wbsId ?? "--"} ${task.title}` : "",
        targetSection ? `To: ${targetSection.title}` : operation.targetSectionRef ? `To new section: ${operation.targetSectionRef}` : "",
        operation.status ? `Status: ${getTaskStatusLabel(operation.status)}` : ""
      ].filter(Boolean);
    }
    case "DELETE_TASK": {
      const task = tasksById.get(operation.taskId);
      return [task ? `Task: ${task.wbsId ?? "--"} ${task.title}` : "Task will be removed"];
    }
    default:
      return [];
  }
}

export function PhaseAnalysisWorkspace({
  tasks,
  currentUser,
  currentPhaseTaskId,
  selectedModel,
  selectedModelLabel,
  onProjectMutation
}: PhaseAnalysisWorkspaceProps) {
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const phaseNodes = useMemo(
    () => tasks.filter((task) => task.nodeType === "PHASE").sort((left, right) => left.sortOrder - right.sortOrder),
    [tasks]
  );
  const tasksById = useMemo(() => new Map(tasks.map((task) => [task._id, task])), [tasks]);
  const canApply = currentUser.role === "OWNER" || currentUser.role === "CONTRACTOR";
  const [selectedPhaseTaskId, setSelectedPhaseTaskId] = useState(currentPhaseTaskId ?? phaseNodes[0]?._id ?? "");
  const [instruction, setInstruction] = useState("");
  const [preview, setPreview] = useState<PhaseAnalysisPreview | null>(null);
  const [applyResult, setApplyResult] = useState<PhaseAnalysisApplyResult | null>(null);
  const [loadState, setLoadState] = useState<AnalysisLoadState>("idle");
  const [loadStageIndex, setLoadStageIndex] = useState(0);
  const [error, setError] = useState("");
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [suggestionLoadState, setSuggestionLoadState] = useState<SuggestionLoadState>("idle");
  const [suggestionWarning, setSuggestionWarning] = useState("");
  const [suggestionRefreshKey, setSuggestionRefreshKey] = useState(0);

  useEffect(() => {
    if (selectedPhaseTaskId && phaseNodes.some((phase) => phase._id === selectedPhaseTaskId)) {
      return;
    }

    setSelectedPhaseTaskId(currentPhaseTaskId ?? phaseNodes[0]?._id ?? "");
  }, [currentPhaseTaskId, phaseNodes, selectedPhaseTaskId]);

  useEffect(() => {
    if (loadState === "idle") {
      setLoadStageIndex(0);
      return;
    }

    const timer = window.setInterval(() => {
      setLoadStageIndex((current) => current + 1);
    }, 900);

    return () => window.clearInterval(timer);
  }, [loadState]);

  useEffect(() => {
    if (!selectedPhaseTaskId) {
      setSuggestions([]);
      setSuggestionWarning("");
      setSuggestionLoadState("idle");
      return;
    }

    let cancelled = false;
    setSuggestionLoadState("loading");
    setSuggestionWarning("");

    void api
      .getPhaseAnalysisSuggestions({
        phaseTaskId: selectedPhaseTaskId,
        model: selectedModel === "auto" ? undefined : selectedModel
      })
      .then((response) => {
        if (cancelled) {
          return;
        }

        setSuggestions(response.suggestions);
        setSuggestionWarning(response.warning ?? "");
        setSuggestionLoadState("idle");
      })
      .catch((suggestionError) => {
        if (cancelled) {
          return;
        }

        setSuggestions([]);
        setSuggestionWarning(suggestionError instanceof Error ? suggestionError.message : "Could not generate phase suggestions right now.");
        setSuggestionLoadState("error");
      });

    return () => {
      cancelled = true;
    };
  }, [selectedPhaseTaskId, selectedModel, suggestionRefreshKey]);

  const selectedPhase = useMemo(
    () => phaseNodes.find((phase) => phase._id === selectedPhaseTaskId) ?? null,
    [phaseNodes, selectedPhaseTaskId]
  );

  const selectedPhaseSections = useMemo(
    () => tasks.filter((task) => task.nodeType === "SECTION" && task.phaseTaskId === selectedPhaseTaskId),
    [selectedPhaseTaskId, tasks]
  );

  const selectedPhaseTasks = useMemo(
    () => tasks.filter((task) => task.nodeType === "TASK" && task.phaseTaskId === selectedPhaseTaskId),
    [selectedPhaseTaskId, tasks]
  );

  const operationCounts = useMemo(() => {
    if (!preview) {
      return null;
    }

    return preview.operations.reduce(
      (counts, operation) => {
        switch (operation.kind) {
          case "CREATE_SECTION":
            counts.createdSections += 1;
            break;
          case "UPDATE_SECTION":
            counts.updatedSections += 1;
            break;
          case "DELETE_SECTION":
            counts.deletedSections += 1;
            break;
          case "CREATE_TASK":
            counts.createdTasks += 1;
            break;
          case "UPDATE_TASK":
            counts.updatedTasks += 1;
            break;
          case "MOVE_TASK":
            counts.movedTasks += 1;
            break;
          case "DELETE_TASK":
            counts.deletedTasks += 1;
            break;
          default:
            break;
        }

        return counts;
      },
      {
        createdSections: 0,
        updatedSections: 0,
        deletedSections: 0,
        createdTasks: 0,
        updatedTasks: 0,
        movedTasks: 0,
        deletedTasks: 0
      }
    );
  }, [preview]);

  const loadingStages = useMemo(() => {
    if (loadState === "apply") {
      return [
        "Validating the proposed phase changes",
        "Applying section and task updates",
        "Syncing hierarchy, WBS order, and linked records"
      ];
    }

    return [
      "Reading the selected phase structure",
      "Comparing sections, tasks, and naming patterns",
      `Drafting the change plan with ${selectedModel === "auto" || !selectedModel ? "the selected model" : selectedModelLabel}`
    ];
  }, [loadState, selectedModel, selectedModelLabel]);

  async function handlePreview() {
    const trimmedInstruction = instruction.trim();
    if (!selectedPhaseTaskId || !trimmedInstruction || loadState !== "idle") {
      return;
    }

    setLoadState("preview");
    setLoadStageIndex(0);
    setError("");
    setPreview(null);
    setApplyResult(null);

    try {
      const response = await api.previewPhaseAnalysis({
        phaseTaskId: selectedPhaseTaskId,
        instruction: trimmedInstruction,
        model: selectedModel === "auto" ? undefined : selectedModel
      });
      setPreview(response);
    } catch (previewError) {
      setError(previewError instanceof Error ? previewError.message : "Could not analyze this phase right now.");
    } finally {
      setLoadState("idle");
    }
  }

  async function handleApply() {
    if (!preview || preview.operations.length === 0 || loadState !== "idle" || !canApply) {
      return;
    }

    const phaseTaskId = preview.phaseTaskId;
    const phaseTitle = preview.phaseTitle;
    const appliedInstruction = preview.instruction;

    setLoadState("apply");
    setLoadStageIndex(0);
    setError("");

    try {
      const response = await api.applyPhaseAnalysis({
        phaseTaskId,
        summary: preview.summary,
        operations: preview.operations
      });

      try {
        await onProjectMutation?.();
      } catch {
        // The backend write already succeeded. We'll refresh the analysis directly from the API.
      }

      let refreshedPreview: PhaseAnalysisPreview;
      let refreshWarning = "";

      try {
        refreshedPreview = await api.previewPhaseAnalysis({
          phaseTaskId,
          instruction: appliedInstruction,
          model: selectedModel === "auto" ? undefined : selectedModel
        });
      } catch (refreshError) {
        refreshedPreview = {
          phaseTaskId,
          phaseTitle,
          instruction: appliedInstruction,
          summary: "The approved changes were applied. Run the analysis again to review any remaining work from the updated phase state.",
          notes: [],
          warnings: [],
          operations: [],
          model: selectedModel === "auto" ? selectedModelLabel : selectedModel ?? selectedModelLabel,
          usedFallback: true
        };
        refreshWarning =
          refreshError instanceof Error
            ? `Changes were applied, but the updated analysis could not be refreshed automatically: ${refreshError.message}`
            : "Changes were applied, but the updated analysis could not be refreshed automatically.";
      }

      setPreview(refreshedPreview);
      setApplyResult(response);
      setSuggestionRefreshKey((current) => current + 1);

      if (refreshWarning) {
        setError(refreshWarning);
      }
    } catch (applyError) {
      setError(applyError instanceof Error ? applyError.message : "Could not apply the proposed phase changes.");
    } finally {
      setLoadState("idle");
    }
  }

  function handleSelectSuggestion(nextInstruction: string) {
    if (loadState !== "idle") {
      return;
    }

    setInstruction(nextInstruction);
    setPreview(null);
    setApplyResult(null);
    setError("");
  }

  function handleInstructionChange(nextValue: string) {
    setInstruction(nextValue);
    setPreview(null);
    setApplyResult(null);
    setError("");
  }

  useEffect(() => {
    if (loadState === "apply" || applyResult) {
      return;
    }

    if (loadState === "idle" && !preview && !error) {
      return;
    }

    bodyRef.current?.scrollTo({ top: 0, behavior: "smooth" });
  }, [preview, applyResult, error, loadState]);

  function renderLoadingSteps() {
    return (
      <>
        <strong>{loadingStages[Math.min(loadStageIndex, loadingStages.length - 1)]}</strong>
        <div className="assistant-phase-analysis-loading-steps">
          {loadingStages.map((step, index) => (
            <div
              key={step}
              className={`assistant-phase-analysis-loading-step ${
                index < loadStageIndex ? "is-complete" : index === loadStageIndex ? "is-active" : ""
              }`}
            >
              <span className="assistant-phase-analysis-loading-dot" aria-hidden="true" />
              <span>{step}</span>
            </div>
          ))}
        </div>
      </>
    );
  }

  return (
    <section className="assistant-phase-analysis">
      <div className="assistant-phase-analysis-controls">
        <label className="assistant-phase-analysis-field">
          <span>Phase</span>
          <select
            value={selectedPhaseTaskId}
            onChange={(event) => {
              setSelectedPhaseTaskId(event.target.value);
              setPreview(null);
              setApplyResult(null);
              setError("");
            }}
            disabled={loadState !== "idle" || phaseNodes.length === 0}
          >
            {phaseNodes.map((phase) => (
              <option key={phase._id} value={phase._id}>
                {phase.title}
              </option>
            ))}
          </select>
        </label>

        {selectedPhase ? (
          <div className="assistant-phase-analysis-phase-meta">
            <span>{selectedPhaseSections.length} sections</span>
            <span>{selectedPhaseTasks.length} tasks</span>
          </div>
        ) : null}

        <p className="assistant-phase-analysis-intro-copy">
          Preview the exact CRUD changes for one phase, then confirm before anything is written.
        </p>
      </div>

      <div className="assistant-phase-analysis-body" ref={bodyRef}>
        {loadState === "preview" ? (
          <div className="assistant-phase-analysis-loading">
            {renderLoadingSteps()}
          </div>
        ) : null}

        {error ? <div className="assistant-phase-analysis-error">{error}</div> : null}

        {preview ? (
          <div className="assistant-phase-analysis-preview">
            <div className="assistant-phase-analysis-summary">
              <div>
                <strong>Proposed Changes</strong>
                <p>{preview.summary}</p>
              </div>
              {operationCounts ? (
                <div className="assistant-phase-analysis-counts">
                  <span>{preview.operations.length} total</span>
                  {operationCounts.createdSections > 0 ? <span>{operationCounts.createdSections} new sections</span> : null}
                  {operationCounts.movedTasks > 0 ? <span>{operationCounts.movedTasks} moved tasks</span> : null}
                  {operationCounts.deletedTasks + operationCounts.deletedSections > 0 ? (
                    <span>{operationCounts.deletedSections + operationCounts.deletedTasks} deletes</span>
                  ) : null}
                </div>
              ) : null}
            </div>

            {preview.notes.length > 0 ? (
              <div className="assistant-phase-analysis-notes">
                <strong>Analysis Notes</strong>
                <ul>
                  {preview.notes.map((note) => (
                    <li key={note}>{note}</li>
                  ))}
                </ul>
              </div>
            ) : null}

            {preview.warnings.length > 0 ? (
              <div className="assistant-phase-analysis-warnings">
                <strong>Review These Carefully</strong>
                <ul>
                  {preview.warnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              </div>
            ) : null}

            {preview.operations.length > 0 ? (
              <div className="assistant-phase-analysis-operations">
                {preview.operations.map((operation) => {
                  const meta = buildOperationMeta(operation, tasksById);
                  return (
                    <article key={operation.id} className="assistant-phase-analysis-operation-card">
                      <div className="assistant-phase-analysis-operation-head">
                        <span className={`assistant-phase-analysis-operation-badge ${getOperationTone(operation.kind)}`}>
                          {getOperationLabel(operation.kind)}
                        </span>
                        <strong>{operation.summary}</strong>
                      </div>
                      {meta.length > 0 ? (
                        <div className="assistant-phase-analysis-operation-meta">
                          {meta.map((value) => (
                            <span key={`${operation.id}-${value}`}>{value}</span>
                          ))}
                        </div>
                      ) : null}
                    </article>
                  );
                })}
              </div>
            ) : (
              <div className="assistant-phase-analysis-empty assistant-phase-analysis-empty-inline">
                <p>No additional CRUD changes are suggested for this instruction based on the latest phase state.</p>
              </div>
            )}
          </div>
        ) : null}

        {loadState === "apply" ? (
          <div className="assistant-phase-analysis-apply-bar is-loading">
            <div className="assistant-phase-analysis-loading assistant-phase-analysis-loading-inline">{renderLoadingSteps()}</div>
          </div>
        ) : applyResult ? (
          <div className="assistant-phase-analysis-apply-bar is-success">
            <div>
              <strong>Changes Applied</strong>
              <p>{applyResult.summary}</p>
              <small>
                {applyResult.appliedCount} changes written · {applyResult.counts.createdSections} section creates · {applyResult.counts.movedTasks} task moves
              </small>
            </div>
          </div>
        ) : preview && preview.operations.length > 0 ? (
          <div className="assistant-phase-analysis-apply-bar">
            <div>
              <strong>Confirm Before Writing</strong>
              <p>The assistant will only make these exact changes after you confirm.</p>
            </div>
            <button
              type="button"
              className="assistant-phase-analysis-apply-btn"
              onClick={() => void handleApply()}
              disabled={loadState !== "idle" || preview.operations.length === 0 || !canApply}
            >
              Yes, Apply Changes
            </button>
          </div>
        ) : null}

        {!preview && !applyResult && loadState === "idle" ? (
          <div className="assistant-phase-analysis-empty">
            <p>Use this mode when you want the assistant to reorganize one phase safely and show the exact backend changes before you approve them.</p>
          </div>
        ) : null}

        <div className="assistant-phase-analysis-composer">
          <label className="assistant-phase-analysis-field">
            <span>Instruction</span>
            <textarea
              value={instruction}
              onChange={(event) => handleInstructionChange(event.target.value)}
              placeholder="Example: Put all basement-related tasks into a new section called Basement, and keep the existing naming style."
              disabled={loadState !== "idle" || phaseNodes.length === 0}
            />
          </label>

          {suggestionLoadState === "loading" ? (
            <div className="assistant-phase-analysis-suggestions-state">Analyzing this phase for suggestion ideas...</div>
          ) : null}

          {suggestions.length > 0 ? (
            <div className="assistant-phase-analysis-suggestions">
              {suggestions.map((prompt) => (
                <button
                  key={prompt}
                  type="button"
                  onClick={() => handleSelectSuggestion(prompt)}
                  disabled={loadState !== "idle" || suggestionLoadState === "loading"}
                >
                  {prompt}
                </button>
              ))}
            </div>
          ) : null}

          {suggestionWarning ? (
            <div className="assistant-phase-analysis-note assistant-phase-analysis-suggestions-note">{suggestionWarning}</div>
          ) : null}

          <div className="assistant-phase-analysis-toolbar">
            <button
              type="button"
              className="assistant-phase-analysis-primary"
              onClick={() => void handlePreview()}
              disabled={loadState !== "idle" || !selectedPhaseTaskId || instruction.trim().length === 0 || !canApply}
            >
              {loadState === "preview" ? "Building Preview..." : "Preview Changes"}
            </button>
            {!canApply ? <span className="assistant-phase-analysis-note">Analysis changes are available to owner and contractor roles.</span> : null}
          </div>
        </div>
      </div>
    </section>
  );
}
