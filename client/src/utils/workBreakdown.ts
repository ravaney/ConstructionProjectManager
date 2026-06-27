import type { Task } from "../types/models";

function sortNodes(tasks: Task[]): Task[] {
  return [...tasks].sort((left, right) => {
    const orderDiff = left.sortOrder - right.sortOrder;
    if (orderDiff !== 0) {
      return orderDiff;
    }

    return left.title.localeCompare(right.title);
  });
}

export function getPhaseNodes(tasks: Task[]): Task[] {
  return sortNodes(tasks.filter((task) => task.nodeType === "PHASE"));
}

export function getSectionsForPhase(tasks: Task[], phaseId?: string): Task[] {
  if (!phaseId) {
    return [];
  }

  return sortNodes(tasks.filter((task) => task.nodeType === "SECTION" && task.parentTaskId === phaseId));
}

export function getSubsectionsForSection(tasks: Task[], sectionId?: string): Task[] {
  if (!sectionId) {
    return [];
  }

  return sortNodes(tasks.filter((task) => task.nodeType === "TASK" && task.parentTaskId === sectionId));
}

export function getChildTasks(tasks: Task[], parentTaskId?: string): Task[] {
  if (!parentTaskId) {
    return [];
  }

  return sortNodes(tasks.filter((task) => task.parentTaskId === parentTaskId));
}

export function getTaskNode(tasks: Task[], taskId?: string): Task | undefined {
  if (!taskId) {
    return undefined;
  }

  return tasks.find((task) => task._id === taskId);
}

export function getCurrentPhase(tasks: Task[]): Task | undefined {
  return getPhaseNodes(tasks).find((phase) => phase.status !== "DONE");
}

export function getCurrentSection(tasks: Task[], phaseId?: string): Task | undefined {
  return getSectionsForPhase(tasks, phaseId).find((section) => section.status !== "DONE");
}

export function buildScopeLabel(phase?: string, section?: string, subsection?: string): string {
  const normalizedPhase = (phase ?? "").trim();
  const normalizedSection = (section ?? "").trim();
  const normalizedSubsection = (subsection ?? "").trim();

  if (normalizedPhase && normalizedSection && normalizedSubsection) {
    return `${normalizedPhase} / ${normalizedSection} / ${normalizedSubsection}`;
  }

  if (normalizedPhase && normalizedSection) {
    return `${normalizedPhase} / ${normalizedSection}`;
  }

  return normalizedPhase || normalizedSection || normalizedSubsection || "Unassigned";
}
