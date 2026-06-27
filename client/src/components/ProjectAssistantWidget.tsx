import { useEffect, useMemo, useRef, useState } from "react";
import { PhaseAnalysisWorkspace } from "./PhaseAnalysisWorkspace";
import type { AssistantChatAction, AssistantChatMessage, AppUser, Task } from "../types/models";
import { getTaskStatusLabel } from "../utils/taskStatus";
import { api } from "../utils/api";

type ProjectAssistantWidgetProps = {
  activeTab: string;
  currentUser: AppUser;
  tasks: Task[];
  currentPhaseTaskId?: string;
  onOpenTask?: (taskId: string) => void;
  taskDrawerOpen?: boolean;
  onDockedLayoutChange?: (active: boolean) => void;
  onProjectMutation?: () => Promise<void> | void;
};

const ASSISTANT_MESSAGES_STORAGE_KEY = "construction_os.project_assistant.messages.v1";
const ASSISTANT_OPEN_STORAGE_KEY = "construction_os.project_assistant.open.v1";
const ASSISTANT_EXPANDED_STORAGE_KEY = "construction_os.project_assistant.expanded.v1";
const ASSISTANT_MODEL_STORAGE_KEY = "construction_os.project_assistant.model.v1";
const ASSISTANT_DOCKED_STORAGE_KEY = "construction_os.project_assistant.docked.v1";

const assistantModelOptions = [
  { value: "auto", label: "Auto" },
  { value: "gpt-5.4-mini", label: "GPT-5.4 Mini" },
  { value: "gpt-5.4", label: "GPT-5.4" },
  { value: "gpt-4.1-mini", label: "GPT-4.1 Mini" },
  { value: "gpt-4.1", label: "GPT-4.1" },
  { value: "gpt-4o-mini", label: "GPT-4o Mini" },
  { value: "gpt-4o", label: "GPT-4o" },
  { value: "qwen-plus", label: "Qwen Plus" },
  { value: "qwen-max", label: "Qwen Max" },
  { value: "qwen-turbo", label: "Qwen Turbo" },
] as const;

type AssistantModelOption = (typeof assistantModelOptions)[number]["value"];

function AssistantIcon({ name }: { name: "spark" | "close" | "clear" | "send" | "source" | "expand" | "collapse" | "settings" | "construction" | "wand" }) {
  const props = {
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true
  };

  switch (name) {
    case "spark":
      return (
        <svg {...props}>
          <path d="m12 3 1.4 4.6L18 9l-4.6 1.4L12 15l-1.4-4.6L6 9l4.6-1.4Z" />
          <path d="m19 3 .6 2 .9.3-.9.3L19 8l-.6-2-.9-.4.9-.3Z" />
          <path d="m5 14 .8 2.5L8.3 17l-2.5.5L5 20l-.8-2.5L1.7 17l2.5-.5Z" />
        </svg>
      );
    case "close":
      return (
        <svg {...props}>
          <path d="M18 6 6 18" />
          <path d="m6 6 12 12" />
        </svg>
      );
    case "clear":
      return (
        <svg {...props}>
          <path d="M3 6h18" />
          <path d="M8 6V4h8v2" />
          <path d="m8 6 1 13h6l1-13" />
          <path d="M10 10v6" />
          <path d="M14 10v6" />
        </svg>
      );
    case "send":
      return (
        <svg {...props}>
          <path d="M22 2 11 13" />
          <path d="M22 2 15 22l-4-9-9-4Z" />
        </svg>
      );
    case "source":
      return (
        <svg {...props}>
          <path d="M12 5v14" />
          <path d="M5 12h14" />
          <circle cx="12" cy="12" r="9" />
        </svg>
      );
    case "expand":
      return (
        <svg {...props}>
          <path d="M15 3h6v6" />
          <path d="M14 10 21 3" />
          <path d="M9 21H3v-6" />
          <path d="m3 21 7-7" />
        </svg>
      );
    case "collapse":
      return (
        <svg {...props}>
          <path d="M9 3H3v6" />
          <path d="M3 3 10 10" />
          <path d="M15 21h6v-6" />
          <path d="m14 14 7 7" />
        </svg>
      );
    case "settings":
      return (
        <svg {...props}>
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1 1 0 0 0 .2 1.1l.1.1a1 1 0 0 1 0 1.4l-1.3 1.3a1 1 0 0 1-1.4 0l-.1-.1a1 1 0 0 0-1.1-.2 1 1 0 0 0-.6.9V20a1 1 0 0 1-1 1h-2a1 1 0 0 1-1-1v-.2a1 1 0 0 0-.7-.9 1 1 0 0 0-1.1.2l-.1.1a1 1 0 0 1-1.4 0L4.3 17.9a1 1 0 0 1 0-1.4l.1-.1a1 1 0 0 0 .2-1.1 1 1 0 0 0-.9-.6H3.5a1 1 0 0 1-1-1v-2a1 1 0 0 1 1-1h.2a1 1 0 0 0 .9-.7 1 1 0 0 0-.2-1.1l-.1-.1a1 1 0 0 1 0-1.4l1.3-1.3a1 1 0 0 1 1.4 0l.1.1a1 1 0 0 0 1.1.2 1 1 0 0 0 .6-.9V4a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v.2a1 1 0 0 0 .7.9 1 1 0 0 0 1.1-.2l.1-.1a1 1 0 0 1 1.4 0l1.3 1.3a1 1 0 0 1 0 1.4l-.1.1a1 1 0 0 0-.2 1.1 1 1 0 0 0 .9.6h.2a1 1 0 0 1 1 1v2a1 1 0 0 1-1 1h-.2a1 1 0 0 0-.9.7" />
        </svg>
      );
    case "construction":
      return (
        <svg {...props}>
          <path d="M4 14a8 8 0 0 1 16 0" />
          <path d="M2.5 14h19" />
          <path d="M12 6v4" />
          <path d="M18 14v3a2 2 0 0 1-2 2" />
        </svg>
      );
    case "wand":
      return (
        <svg {...props}>
          <path d="m14 4 6 6" />
          <path d="m5 19 9-9" />
          <path d="m4 20 2-5 3 3-5 2Z" />
          <path d="M11 3v2" />
          <path d="M4 10H2" />
          <path d="m7 6-1-1" />
        </svg>
      );
    default:
      return null;
  }
}

function createMessage(
  role: AssistantChatMessage["role"],
  content: string,
  sources?: AssistantChatMessage["sources"],
  actions?: AssistantChatMessage["actions"]
): AssistantChatMessage {
  return {
    id: `${role}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    role,
    content,
    sources,
    actions
  };
}

function readStoredMessages(): AssistantChatMessage[] {
  if (typeof window === "undefined") {
    return [];
  }

  try {
    const raw = window.localStorage.getItem(ASSISTANT_MESSAGES_STORAGE_KEY);
    if (!raw) {
      return [];
    }

    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed.filter(
      (entry): entry is AssistantChatMessage =>
        entry &&
        typeof entry === "object" &&
        typeof entry.id === "string" &&
        (entry.role === "user" || entry.role === "assistant") &&
        typeof entry.content === "string"
    );
  } catch {
    return [];
  }
}

function readStoredOpenState(): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  return window.localStorage.getItem(ASSISTANT_OPEN_STORAGE_KEY) === "true";
}

function readStoredExpandedState(): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  return window.localStorage.getItem(ASSISTANT_EXPANDED_STORAGE_KEY) === "true";
}

function readStoredModel(): AssistantModelOption {
  if (typeof window === "undefined") {
    return "auto";
  }

  const stored = window.localStorage.getItem(ASSISTANT_MODEL_STORAGE_KEY);
  return assistantModelOptions.some((option) => option.value === stored) ? (stored as AssistantModelOption) : "auto";
}

function readStoredDockedState(): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  return window.localStorage.getItem(ASSISTANT_DOCKED_STORAGE_KEY) === "true";
}

const starterPrompts = [
  "What changed financially this week?",
  "Which tasks are overdue right now?",
  "How much have we spent on labour so far?",
  "Which invoices are still open?"
];

const ASSISTANT_INPUT_MAX_HEIGHT = 180;
const ASSISTANT_REQUEST_MESSAGE_LIMIT = 10;
const ASSISTANT_REQUEST_MESSAGE_MAX_LENGTH = 3800;
const ASSISTANT_BULLET_PATTERN = /^\s*(?:[-*•]\s+|\d+\.\s+)/;
const ASSISTANT_MONEY_PATTERN = /\b(?:USD|JMD)\s*\$?[0-9][0-9,]*(?:\.\d+)?|J\$\s?[0-9][0-9,]*(?:\.\d+)?|\$\s?[0-9][0-9,]*(?:\.\d+)?/gi;
const ASSISTANT_TASK_STATUS_PATTERN = /\b(?:IN_PROGRESS|PLANNED|BLOCKED|DONE|In Progress|Planned|Blocked|Completed)\b/gi;

const ASSISTANT_LIST_ITEM_PATTERN = /^\s*(?:[-*\u2022]\s+|\d+\.\s+)/;
const ASSISTANT_INLINE_BULLET_SPLIT_PATTERN = /\s+(?=(?:[-*\u2022]\s+|\d+\.\s+))/g;

function buildAssistantRequestMessages(messages: AssistantChatMessage[]) {
  return messages.slice(-ASSISTANT_REQUEST_MESSAGE_LIMIT).map((message) => ({
    role: message.role,
    content:
      message.content.length > ASSISTANT_REQUEST_MESSAGE_MAX_LENGTH
        ? `${message.content.slice(0, ASSISTANT_REQUEST_MESSAGE_MAX_LENGTH - 3)}...`
        : message.content
  }));
}

function getMoneyTone(text: string) {
  const line = text.toLowerCase();

  if (/(remaining budget|remaining cash|saved|under budget|available cash|unused funds|surplus)/.test(line)) {
    return "positive";
  }

  if (/(spent|spend|paid|payment|payments|cost|invoice|overdue|open balance|committed|decrease|reduced|deleted|loss)/.test(line)) {
    return "negative";
  }

  return "neutral";
}

function getTaskStatusChip(statusText: string) {
  const normalized = statusText.trim().toUpperCase().replace(/\s+/g, "_");

  switch (normalized) {
    case "PLANNED":
      return { label: getTaskStatusLabel("PLANNED"), tone: "planned" };
    case "IN_PROGRESS":
      return { label: getTaskStatusLabel("IN_PROGRESS"), tone: "in-progress" };
    case "BLOCKED":
      return { label: getTaskStatusLabel("BLOCKED"), tone: "blocked" };
    case "DONE":
    case "COMPLETED":
      return { label: getTaskStatusLabel("DONE"), tone: "done" };
    default:
      return null;
  }
}

function parseTaskBulletItem(text: string) {
  const patterns = [
    /\((IN_PROGRESS|PLANNED|BLOCKED|DONE|In Progress|Planned|Blocked|Completed)\)\s*$/i,
    /\bStatus:\s*(IN_PROGRESS|PLANNED|BLOCKED|DONE|In Progress|Planned|Blocked|Completed)\s*$/i,
    /\s[-–]\s(IN_PROGRESS|PLANNED|BLOCKED|DONE|In Progress|Planned|Blocked|Completed)\s*$/i
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match || match.index == null) {
      continue;
    }

    const statusChip = getTaskStatusChip(match[1]);
    if (!statusChip) {
      continue;
    }

    const title = text.slice(0, match.index).trim().replace(/\s+$/, "");
    return {
      title: title || text,
      statusChip
    };
  }

  return {
    title: text,
    statusChip: null
  };
}

function normalizeAssistantTaskMatchText(value: string) {
  return value
    .toLowerCase()
    .replace(/[()]/g, " ")
    .replace(/[^a-z0-9.\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function findTaskSourceForBullet(
  bulletTitle: string,
  sources: AssistantChatMessage["sources"] | undefined
) {
  if (!Array.isArray(sources) || sources.length === 0) {
    return null;
  }

  const normalizedBulletTitle = normalizeAssistantTaskMatchText(bulletTitle);
  if (!normalizedBulletTitle) {
    return null;
  }

  const taskSources = sources.filter((source) => source.kind.toLowerCase() === "task");
  for (const source of taskSources) {
    const normalizedSourceTitle = normalizeAssistantTaskMatchText(source.title);
    if (
      normalizedSourceTitle === normalizedBulletTitle ||
      normalizedSourceTitle.includes(normalizedBulletTitle) ||
      normalizedBulletTitle.includes(normalizedSourceTitle)
    ) {
      return source;
    }
  }

  return null;
}

function renderAssistantInlineText(text: string, keyPrefix: string) {
  const nodes: React.ReactNode[] = [];
  let lastIndex = 0;
  const moneyRegex = new RegExp(ASSISTANT_MONEY_PATTERN.source, "gi");
  const statusRegex = new RegExp(ASSISTANT_TASK_STATUS_PATTERN.source, "gi");

  const firstMoney = moneyRegex.exec(text);
  const firstStatus = statusRegex.exec(text);

  if (!firstMoney && !firstStatus) {
    return text;
  }

  moneyRegex.lastIndex = 0;
  statusRegex.lastIndex = 0;
  let tokenIndex = 0;

  while (lastIndex < text.length) {
    moneyRegex.lastIndex = lastIndex;
    statusRegex.lastIndex = lastIndex;

    const moneyMatch = moneyRegex.exec(text);
    const statusMatch = statusRegex.exec(text);
    const nextMatch =
      moneyMatch && statusMatch
        ? (moneyMatch.index ?? 0) <= (statusMatch.index ?? 0)
          ? { type: "money" as const, match: moneyMatch }
          : { type: "status" as const, match: statusMatch }
        : moneyMatch
          ? { type: "money" as const, match: moneyMatch }
          : statusMatch
            ? { type: "status" as const, match: statusMatch }
            : null;

    if (!nextMatch) {
      break;
    }

    const matchText = nextMatch.match[0];
    const matchIndex = nextMatch.match.index ?? lastIndex;
    if (matchIndex > lastIndex) {
      nodes.push(text.slice(lastIndex, matchIndex));
    }

    if (nextMatch.type === "money") {
      const tone = getMoneyTone(text);
      nodes.push(
        <span key={`${keyPrefix}-money-${tokenIndex}`} className={`assistant-widget-money assistant-widget-money-${tone}`}>
          {matchText}
        </span>
      );
    } else {
      const statusChip = getTaskStatusChip(matchText);
      if (statusChip) {
        nodes.push(
          <span
            key={`${keyPrefix}-status-${tokenIndex}`}
            className={`assistant-widget-status-chip assistant-widget-status-chip-${statusChip.tone}`}
          >
            {statusChip.label}
          </span>
        );
      } else {
        nodes.push(matchText);
      }
    }

    tokenIndex += 1;
    lastIndex = matchIndex + matchText.length;
  }

  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }

  return nodes;
}

function extractInlineBulletBlock(line: string) {
  const marker = line.match(/:\s+(?=(?:[-*\u2022]\s+|\d+\.\s+))/);
  if (!marker || marker.index == null) {
    return null;
  }

  const lead = line.slice(0, marker.index + 1).trim();
  const tail = line.slice(marker.index + marker[0].length).trim();
  const bullets = tail
    .split(ASSISTANT_INLINE_BULLET_SPLIT_PATTERN)
    .map((item) => item.replace(ASSISTANT_LIST_ITEM_PATTERN, "").trim())
    .filter(Boolean);

  if (bullets.length < 2) {
    return null;
  }

  return { lead, bullets };
}

function getBulletListKind(leadText: string, bullets: string[]) {
  const combined = [leadText, ...bullets].join(" ").toLowerCase();

  if (
    /(task|tasks|wbs|phase|section|subsection|overdue|in_progress|in progress|done|planned|not started|priority|actual start|actual end|due date|next tasks)/.test(
      combined
    ) ||
    bullets.some((item) => /\b\d+\.\d+(?:\.\d+)?\b/.test(item) || /\((?:in_progress|done|planned|blocked|not started)\)/i.test(item))
  ) {
    return "task";
  }

  return "default";
}

function renderAssistantContent(
  content: string,
  sources?: AssistantChatMessage["sources"],
  onOpenTask?: (taskId: string) => void
) {
  const lines = content.replace(/\r/g, "").split("\n");
  const blocks: React.ReactNode[] = [];
  let paragraphBuffer: string[] = [];
  let bulletBuffer: string[] = [];
  let bulletLead = "";
  let lastParagraphText = "";

  function flushParagraph() {
    if (paragraphBuffer.length === 0) {
      return;
    }

    const text = paragraphBuffer.join(" ");
    lastParagraphText = text;
    blocks.push(
      <p key={`p-${blocks.length}`} className="assistant-widget-paragraph">
        {renderAssistantInlineText(text, `p-${blocks.length}`)}
      </p>
    );
    paragraphBuffer = [];
  }

  function flushBullets() {
    if (bulletBuffer.length === 0) {
      return;
    }

    const listKind = getBulletListKind(bulletLead, bulletBuffer);

    blocks.push(
      <ul key={`ul-${blocks.length}`} className={`assistant-widget-bullet-list assistant-widget-bullet-list-${listKind}`}>
        {bulletBuffer.map((item, index) => {
          if (listKind === "task") {
            const parsedItem = parseTaskBulletItem(item);
            const linkedTaskSource = findTaskSourceForBullet(parsedItem.title, sources);
            const linkedTaskId = linkedTaskSource ? getTaskIdFromAssistantSourceId(linkedTaskSource.id) : null;
            return (
              <li key={`li-${blocks.length}-${index}`} className="assistant-widget-bullet-item assistant-widget-bullet-item-task">
                <span className="assistant-widget-bullet-marker assistant-widget-bullet-marker-task" aria-hidden="true">
                  <AssistantIcon name="construction" />
                </span>
                <div className="assistant-widget-task-bullet-content">
                  <div className="assistant-widget-task-bullet-title">{renderAssistantInlineText(parsedItem.title, `li-${blocks.length}-${index}-title`)}</div>
                  {parsedItem.statusChip || (linkedTaskId && onOpenTask) ? (
                    <div className="assistant-widget-task-bullet-status-row">
                      {parsedItem.statusChip ? (
                        <span className={`assistant-widget-status-chip assistant-widget-status-chip-${parsedItem.statusChip.tone}`}>
                          {parsedItem.statusChip.label}
                        </span>
                      ) : null}
                      {linkedTaskId && onOpenTask ? (
                        <button
                          type="button"
                          className="assistant-widget-task-link"
                          onClick={() => onOpenTask(linkedTaskId)}
                        >
                          Open Task
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </li>
            );
          }

          return (
            <li key={`li-${blocks.length}-${index}`} className={`assistant-widget-bullet-item assistant-widget-bullet-item-${listKind}`}>
              {renderAssistantInlineText(item, `li-${blocks.length}-${index}`)}
            </li>
          );
        })}
      </ul>
    );
    bulletBuffer = [];
    bulletLead = "";
  }

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      flushParagraph();
      flushBullets();
      continue;
    }

    if (ASSISTANT_LIST_ITEM_PATTERN.test(line)) {
      flushParagraph();
      if (!bulletLead && lastParagraphText) {
        bulletLead = lastParagraphText;
      }
      bulletBuffer.push(line.replace(ASSISTANT_LIST_ITEM_PATTERN, "").trim());
      continue;
    }

    const inlineBulletBlock = extractInlineBulletBlock(line);
    if (inlineBulletBlock) {
      flushParagraph();
      flushBullets();
      blocks.push(
        <p key={`p-${blocks.length}`} className="assistant-widget-paragraph">
          {renderAssistantInlineText(inlineBulletBlock.lead, `p-${blocks.length}`)}
        </p>
      );
      bulletLead = inlineBulletBlock.lead;
      bulletBuffer.push(...inlineBulletBlock.bullets);
      continue;
    }

    flushBullets();
    paragraphBuffer.push(line);
  }

  flushParagraph();
  flushBullets();

  if (blocks.length === 0) {
    return <p className="assistant-widget-paragraph">{content}</p>;
  }

  return <div className="assistant-widget-rich-body">{blocks}</div>;
}

function getTaskIdFromAssistantSourceId(sourceId: string) {
  return sourceId.startsWith("task.") ? sourceId.slice("task.".length) : null;
}

function buildTaskSource(task: Task) {
  return {
    id: `task.${task._id}`,
    kind: "task",
    title: `${task.wbsId ?? "--"} ${task.title}`,
    subtitle: [task.phase, task.section, getTaskStatusLabel(task.status)].filter(Boolean).join(" | ")
  };
}

export function ProjectAssistantWidget({
  activeTab,
  currentUser,
  tasks,
  currentPhaseTaskId,
  onOpenTask,
  taskDrawerOpen = false,
  onDockedLayoutChange,
  onProjectMutation
}: ProjectAssistantWidgetProps) {
  const canUsePhaseAnalysis = currentUser.role === "OWNER" || currentUser.role === "CONTRACTOR";
  const [open, setOpen] = useState(readStoredOpenState);
  const [expanded, setExpanded] = useState(readStoredExpandedState);
  const [docked, setDocked] = useState(readStoredDockedState);
  const [mode, setMode] = useState<"chat" | "analysis">("chat");
  const [messages, setMessages] = useState<AssistantChatMessage[]>(readStoredMessages);
  const [expandedSourcesByMessage, setExpandedSourcesByMessage] = useState<Record<string, boolean>>({});
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadingStageIndex, setLoadingStageIndex] = useState(0);
  const [warning, setWarning] = useState("");
  const [selectedModel, setSelectedModel] = useState<AssistantModelOption>(readStoredModel);
  const [lastResponseModel, setLastResponseModel] = useState("");
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [actionStateById, setActionStateById] = useState<Record<string, "idle" | "running" | "done" | "error">>({});
  const threadRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const modelMenuRef = useRef<HTMLDivElement | null>(null);

  function resizeTextarea() {
    if (!textareaRef.current) {
      return;
    }

    const textarea = textareaRef.current;
    textarea.style.height = "0px";
    const nextHeight = Math.min(Math.max(textarea.scrollHeight, 56), ASSISTANT_INPUT_MAX_HEIGHT);
    textarea.style.height = `${nextHeight}px`;
    textarea.style.overflowY = textarea.scrollHeight > ASSISTANT_INPUT_MAX_HEIGHT ? "auto" : "hidden";
  }

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    window.localStorage.setItem(ASSISTANT_OPEN_STORAGE_KEY, String(open));
  }, [open]);

  useEffect(() => {
    if (!open && expanded) {
      setExpanded(false);
    }
  }, [open, expanded]);

  useEffect(() => {
    if (!open && modelMenuOpen) {
      setModelMenuOpen(false);
    }
  }, [open, modelMenuOpen]);

  useEffect(() => {
    if (!taskDrawerOpen) {
      return;
    }

    setOpen(false);
    setExpanded(false);
    setModelMenuOpen(false);
  }, [taskDrawerOpen]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    window.localStorage.setItem(ASSISTANT_EXPANDED_STORAGE_KEY, String(expanded));
  }, [expanded]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    window.localStorage.setItem(ASSISTANT_MODEL_STORAGE_KEY, selectedModel);
  }, [selectedModel]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    window.localStorage.setItem(ASSISTANT_MESSAGES_STORAGE_KEY, JSON.stringify(messages.slice(-24)));
  }, [messages]);

  useEffect(() => {
    if (!threadRef.current) {
      return;
    }

    threadRef.current.scrollTop = threadRef.current.scrollHeight;
  }, [messages, loading, open]);

  useEffect(() => {
    if (!open || !textareaRef.current) {
      return;
    }

    resizeTextarea();
    textareaRef.current.focus();
  }, [open, expanded]);

  useEffect(() => {
    resizeTextarea();
  }, [input, open]);

  useEffect(() => {
    if (!modelMenuOpen) {
      return;
    }

    function handlePointerDown(event: MouseEvent) {
      if (!modelMenuRef.current?.contains(event.target as Node)) {
        setModelMenuOpen(false);
      }
    }

    window.addEventListener("mousedown", handlePointerDown);
    return () => window.removeEventListener("mousedown", handlePointerDown);
  }, [modelMenuOpen]);

  const chatMessages = useMemo(() => messages.slice(-24), [messages]);
  const selectedModelLabel = useMemo(
    () => assistantModelOptions.find((option) => option.value === selectedModel)?.label ?? "Auto",
    [selectedModel]
  );
  const loadingModelLabel = selectedModel === "auto" ? "the selected model" : selectedModelLabel;
  const loadingStages = useMemo(
    () => [
      "Reading your project data",
      "Pulling tasks, expenses, invoices, and history",
      "Selecting the most relevant records",
      `Drafting the answer with ${loadingModelLabel}`
    ],
    [loadingModelLabel]
  );
  const activeModelLabel =
    lastResponseModel ||
    (selectedModel === "auto" ? "Auto" : selectedModelLabel);
  const dockedOpen = docked && open && !expanded && !taskDrawerOpen;

  useEffect(() => {
    onDockedLayoutChange?.(dockedOpen);
  }, [dockedOpen, onDockedLayoutChange]);

  useEffect(() => {
    if (!loading) {
      setLoadingStageIndex(0);
      return;
    }

    setLoadingStageIndex(0);
    const interval = window.setInterval(() => {
      setLoadingStageIndex((current) => (current < loadingStages.length - 1 ? current + 1 : current));
    }, 900);

    return () => window.clearInterval(interval);
  }, [loading, loadingStages]);

  useEffect(() => {
    if (!expanded || !docked) {
      return;
    }

    setExpanded(false);
  }, [docked, expanded]);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    window.localStorage.setItem(ASSISTANT_DOCKED_STORAGE_KEY, String(docked));
  }, [docked]);

  async function sendMessage(content: string) {
    const trimmed = content.trim();
    if (!trimmed || loading) {
      return;
    }

    const nextUserMessage = createMessage("user", trimmed);
    const nextConversation = [...chatMessages, nextUserMessage];
    setMessages(nextConversation);
    setInput("");
    setLoadingStageIndex(0);
    setLoading(true);
    setWarning("");

    try {
      const response = await api.chatWithAssistant({
        activeTab,
        messages: buildAssistantRequestMessages(nextConversation),
        model: selectedModel === "auto" ? undefined : selectedModel
      });

      setMessages((current) => [
        ...current,
        createMessage("assistant", response.answer, response.sources, response.actions)
      ]);
      setLastResponseModel(response.model);
      setWarning(response.warning ?? (response.usedFallback ? "Running in grounded local fallback mode." : ""));
    } catch (error) {
      const message = error instanceof Error ? error.message : "The assistant could not answer right now.";
      setMessages((current) => [
        ...current,
        createMessage("assistant", `I couldn't answer that just now.\n\n${message}`)
      ]);
    } finally {
      setLoading(false);
    }
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void sendMessage(input);
    }
  }

  function handleStarterPrompt(prompt: string) {
    setOpen(true);
    void sendMessage(prompt);
  }

  function clearConversation() {
    setMessages([]);
    setExpandedSourcesByMessage({});
    setActionStateById({});
    setWarning("");
    setLastResponseModel("");
    if (typeof window !== "undefined") {
      window.localStorage.removeItem(ASSISTANT_MESSAGES_STORAGE_KEY);
    }
  }

  async function applyAssistantAction(action: AssistantChatAction) {
    if (actionStateById[action.id] === "running") {
      return;
    }

    setActionStateById((current) => ({ ...current, [action.id]: "running" }));

    try {
      let task: Task | undefined;
      if (action.kind === "CREATE_SECTION") {
        const response = await api.addTask(action.payload);
        task = response.task;
      } else {
        const response = await api.updateTask(action.taskId, action.payload);
        task = response.task;
      }

      await onProjectMutation?.();

      setActionStateById((current) => ({ ...current, [action.id]: "done" }));
      setMessages((current) => [
        ...current,
        createMessage(
          "assistant",
          `${action.summary} is complete.`,
          task ? [buildTaskSource(task)] : undefined
        )
      ]);
    } catch (error) {
      const message = error instanceof Error ? error.message : "The assistant action could not be applied.";
      setActionStateById((current) => ({ ...current, [action.id]: "error" }));
      setMessages((current) => [
        ...current,
        createMessage("assistant", `I couldn't apply that section change.\n\n${message}`)
      ]);
    }
  }

  return (
    <div className={`assistant-widget-shell ${open ? "open" : ""} ${open && expanded ? "expanded" : ""} ${dockedOpen ? "docked-open" : ""}`}>
      {open && expanded && <button className="assistant-widget-backdrop" type="button" onClick={() => setExpanded(false)} aria-label="Collapse assistant window" />}
      {open && (
        <section className={`assistant-widget-panel ${expanded ? "expanded" : ""} ${dockedOpen ? "docked" : ""} ${mode === "analysis" ? "analysis-mode" : ""}`} aria-label="Project assistant">
          <header className="assistant-widget-header">
            <div className="assistant-widget-title">
              <span className="assistant-widget-badge">
                <AssistantIcon name="spark" />
              </span>
              <div className="assistant-widget-title-copy">
                <strong>Project Assistant</strong>
                <div className="assistant-widget-title-meta">
                  <small>Grounded in project data</small>
                  <span className="assistant-widget-active-model">{activeModelLabel}</span>
                </div>
                <small>Read-only project Q&amp;A grounded in your database · {activeModelLabel}</small>
              </div>
            </div>
            <div className="assistant-widget-actions">
              <button
                className="assistant-widget-icon-btn"
                type="button"
                onClick={() => setModelMenuOpen((current) => !current)}
                aria-label="Assistant settings"
                title="Assistant settings"
              >
                <AssistantIcon name="settings" />
              </button>
              <button
                className={`assistant-widget-icon-btn ${mode === "analysis" ? "is-active" : ""}`}
                type="button"
                onClick={() => {
                  setMode((current) => (current === "analysis" ? "chat" : "analysis"));
                  setModelMenuOpen(false);
                }}
                aria-label={mode === "analysis" ? "Return to normal chat" : "Open phase analysis mode"}
                title={mode === "analysis" ? "Return to chat" : "Phase analysis mode"}
                disabled={!canUsePhaseAnalysis || loading}
              >
                <AssistantIcon name="wand" />
              </button>
              {modelMenuOpen && (
                <div className="assistant-widget-settings-menu" ref={modelMenuRef}>
                  <label className="assistant-widget-settings-field">
                    <span>Model</span>
                    <select
                      value={selectedModel}
                      onChange={(event) => {
                        setSelectedModel(event.target.value as AssistantModelOption);
                        setModelMenuOpen(false);
                      }}
                      disabled={loading}
                    >
                      {assistantModelOptions.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    type="button"
                    className={`assistant-widget-settings-toggle ${docked ? "active" : ""}`}
                    onClick={() => {
                      setDocked((current) => !current);
                      setExpanded(false);
                      setModelMenuOpen(false);
                      setOpen(true);
                    }}
                  >
                    <span>Dock to Side</span>
                    <strong>{docked ? "On" : "Off"}</strong>
                  </button>
                </div>
              )}
              {!docked && (
                <button
                  className="assistant-widget-icon-btn"
                  type="button"
                  onClick={() => setExpanded((current) => !current)}
                  aria-label={expanded ? "Collapse assistant window" : "Expand assistant window"}
                  title={expanded ? "Collapse" : "Expand"}
                >
                  <AssistantIcon name={expanded ? "collapse" : "expand"} />
                </button>
              )}
              {mode === "chat" ? (
                <button
                  className="assistant-widget-icon-btn"
                  type="button"
                  onClick={clearConversation}
                  aria-label="Clear assistant conversation"
                  title="Clear conversation"
                  disabled={loading || messages.length === 0}
                >
                  <AssistantIcon name="clear" />
                </button>
              ) : null}
              <button
                className="assistant-widget-icon-btn"
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close assistant"
                title="Close assistant"
              >
                <AssistantIcon name="close" />
              </button>
            </div>
            <div className="assistant-widget-header-subtitle">
              {mode === "analysis"
                ? "Phase Analysis Mode"
                : "Read-only project Q&A grounded in your database."}
            </div>
            <div className="assistant-widget-header-model-row">
              <span className="assistant-widget-active-model-chip">{activeModelLabel}</span>
            </div>
          </header>
          {mode === "analysis" ? (
            <PhaseAnalysisWorkspace
              tasks={tasks}
              currentUser={currentUser}
              currentPhaseTaskId={currentPhaseTaskId}
              selectedModel={selectedModel}
              selectedModelLabel={selectedModelLabel}
              onProjectMutation={onProjectMutation}
            />
          ) : (
            <>
              <div className="assistant-widget-thread" ref={threadRef}>
                {chatMessages.length === 0 ? (
                  <div className="assistant-widget-empty">
                    <p>
                      Hi {currentUser.name.split(" ")[0]}, ask me anything about your project, finances, tasks, invoices, grouped estimates, or recent history.
                    </p>
                    <div className="assistant-widget-starters">
                      {starterPrompts.map((prompt) => (
                        <button key={prompt} type="button" onClick={() => handleStarterPrompt(prompt)}>
                          {prompt}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : (
                  chatMessages.map((message) => (
                    <article key={message.id} className={`assistant-widget-message ${message.role}`}>
                      <div className="assistant-widget-message-label">{message.role === "user" ? "You" : "Assistant"}</div>
                      <div className="assistant-widget-message-body">
                        {message.role === "assistant" ? renderAssistantContent(message.content, message.sources, onOpenTask) : message.content}
                      </div>
                      {message.role === "assistant" && Array.isArray(message.sources) && message.sources.length > 0 && (
                        <div className="assistant-widget-sources">
                          <button
                            type="button"
                            className={`assistant-widget-sources-toggle ${expandedSourcesByMessage[message.id] ? "is-open" : ""}`}
                            aria-expanded={expandedSourcesByMessage[message.id] ? "true" : "false"}
                            onClick={() =>
                              setExpandedSourcesByMessage((current) => ({
                                ...current,
                                [message.id]: !current[message.id]
                              }))
                            }
                          >
                            <span className="assistant-widget-sources-toggle-label">
                              <AssistantIcon name="source" />
                              Sources
                            </span>
                            <span className="assistant-widget-sources-toggle-count">{message.sources.length}</span>
                          </button>
                          {expandedSourcesByMessage[message.id] && (
                            <div className="assistant-widget-source-list">
                              {message.sources.map((source) => {
                                const taskId = getTaskIdFromAssistantSourceId(source.id);
                                if (taskId && onOpenTask) {
                                  return (
                                    <button
                                      key={`${message.id}-${source.id}`}
                                      type="button"
                                      className="assistant-widget-source-pill assistant-widget-source-pill-action"
                                      onClick={() => onOpenTask(taskId)}
                                    >
                                      <strong>{source.kind}</strong>
                                      <span>{source.title}</span>
                                      <em>Open Task</em>
                                    </button>
                                  );
                                }

                                return (
                                  <div key={`${message.id}-${source.id}`} className="assistant-widget-source-pill">
                                    <strong>{source.kind}</strong>
                                    <span>{source.title}</span>
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      )}
                      {message.role === "assistant" && Array.isArray(message.actions) && message.actions.length > 0 && (
                        <div className="assistant-widget-action-list">
                          {message.actions.map((action) => {
                            const state = actionStateById[action.id] ?? "idle";
                            return (
                              <div key={`${message.id}-${action.id}`} className="assistant-widget-action-card">
                                <div className="assistant-widget-action-copy">
                                  <strong>{action.label}</strong>
                                  <p>{action.summary}</p>
                                </div>
                                <button
                                  type="button"
                                  className={`assistant-widget-action-btn ${state}`}
                                  disabled={state === "running" || state === "done" || !(currentUser.role === "OWNER" || currentUser.role === "CONTRACTOR")}
                                  onClick={() => void applyAssistantAction(action)}
                                >
                                  {state === "running"
                                    ? "Applying..."
                                    : state === "done"
                                      ? "Applied"
                                      : state === "error"
                                        ? "Retry"
                                        : "Apply"}
                                </button>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </article>
                  ))
                )}
                {loading && (
                  <article className="assistant-widget-message assistant pending">
                    <div className="assistant-widget-message-label">Assistant</div>
                    <div className="assistant-widget-loading">
                      <div className="assistant-widget-loading-head">
                        <strong>{loadingStages[Math.min(loadingStageIndex, loadingStages.length - 1)]}</strong>
                        <small>Checking project records and assembling the answer.</small>
                      </div>
                      <div className="assistant-widget-loading-steps">
                        {loadingStages.map((step, index) => (
                          <div
                            key={step}
                            className={`assistant-widget-loading-step ${
                              index < loadingStageIndex ? "is-complete" : index === loadingStageIndex ? "is-active" : ""
                            }`}
                          >
                            <span className="assistant-widget-loading-step-dot" aria-hidden="true" />
                            <span>{step}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  </article>
                )}
              </div>

              {warning && <div className="assistant-widget-warning">{warning}</div>}

              <footer className="assistant-widget-footer">
                <textarea
                  ref={textareaRef}
                  className="assistant-widget-input"
                  rows={1}
                  value={input}
                  onChange={(event) => {
                    setInput(event.target.value);
                  }}
                  onKeyDown={handleKeyDown}
                  placeholder="Ask about budget, invoices, labour spend, overdue tasks, or recent changes..."
                  disabled={loading}
                />
                <button
                  className="assistant-widget-send-btn"
                  type="button"
                  onClick={() => void sendMessage(input)}
                  disabled={loading || input.trim().length === 0}
                >
                  <AssistantIcon name="send" />
                  <span>{loading ? "Thinking" : "Ask"}</span>
                </button>
              </footer>
            </>
          )}
        </section>
      )}

      {!open && !taskDrawerOpen && (
        <button
          className="assistant-widget-fab"
          type="button"
          onClick={() => {
            setOpen((current) => !current);
            setExpanded(false);
          }}
          aria-expanded={open}
          aria-label={open ? "Close project assistant" : "Open project assistant"}
        >
          <span className="assistant-widget-fab-icon">
            <AssistantIcon name="spark" />
          </span>
          <span className="assistant-widget-fab-copy">
            <strong>Assistant</strong>
            <small>Ask the project</small>
          </span>
        </button>
      )}
    </div>
  );
}
