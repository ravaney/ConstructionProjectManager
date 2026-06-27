import type { TaskStatus } from "../types/models";

export const taskStatuses: TaskStatus[] = ["PLANNED", "IN_PROGRESS", "BLOCKED", "DONE"];

export function getTaskStatusLabel(status: TaskStatus): string {
  switch (status) {
    case "PLANNED":
      return "Planned";
    case "IN_PROGRESS":
      return "In Progress";
    case "BLOCKED":
      return "Blocked";
    case "DONE":
      return "Completed";
    default:
      return status;
  }
}
