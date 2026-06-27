import { env } from "../env.js";

export type GeneratedPlanTaskDraft = {
  title: string;
  description?: string;
  status?: "PLANNED" | "IN_PROGRESS" | "BLOCKED" | "DONE";
  priority?: "LOW" | "MEDIUM" | "HIGH";
  estimateAmount?: number;
  resources?: string[];
  wbsId?: string;
  predecessor?: string;
  deliverable?: string;
};

export type GeneratedPlanSectionDraft = {
  title: string;
  description?: string;
  status?: "PLANNED" | "IN_PROGRESS" | "BLOCKED" | "DONE";
  owner?: string;
  resources?: string[];
  estimateAmount?: number;
  tasks: GeneratedPlanTaskDraft[];
};

export type GeneratedPlanPhaseDraft = {
  title: string;
  description?: string;
  status?: "PLANNED" | "IN_PROGRESS" | "BLOCKED" | "DONE";
  owner?: string;
  resources?: string[];
  priority?: "LOW" | "MEDIUM" | "HIGH";
  plannedStartDate?: string;
  plannedEndDate?: string;
  dueDate?: string;
  estimateAmount?: number;
  wbsId?: string;
  sections: GeneratedPlanSectionDraft[];
};

export type GeneratedTaskPlanDraft = {
  phases: GeneratedPlanPhaseDraft[];
  assumptions: string[];
  verificationQuestions: string[];
};

const statusValues = new Set(["PLANNED", "IN_PROGRESS", "BLOCKED", "DONE"]);
const priorityValues = new Set(["LOW", "MEDIUM", "HIGH"]);

const defaultPhaseTitles = [
  "Site Preparation",
  "Foundation",
  "Structure",
  "MEP Rough-In",
  "Interior Finishes",
  "Final Fixes & Handover"
];

function sanitizeText(value: unknown, fallback = ""): string {
  if (typeof value !== "string") {
    return fallback;
  }

  return value.trim();
}

function sanitizeNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || Number.isNaN(value) || value < 0) {
    return undefined;
  }

  return Number(value.toFixed(2));
}

function sanitizeStatus(value: unknown): GeneratedPlanTaskDraft["status"] | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim().toUpperCase();
  return statusValues.has(normalized) ? (normalized as GeneratedPlanTaskDraft["status"]) : undefined;
}

function sanitizePriority(value: unknown): GeneratedPlanTaskDraft["priority"] | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim().toUpperCase();
  return priorityValues.has(normalized) ? (normalized as GeneratedPlanTaskDraft["priority"]) : undefined;
}

function sanitizeDate(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  if (!normalized) {
    return undefined;
  }

  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) {
    return undefined;
  }

  return date.toISOString().slice(0, 10);
}

function sanitizeWbsCode(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim().replace(/\s+/g, "");
  if (!normalized) {
    return undefined;
  }

  return normalized.slice(0, 16);
}

function sanitizeResourceList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const item of value) {
    if (typeof item !== "string") {
      continue;
    }

    const resource = item.trim();
    if (!resource) {
      continue;
    }

    const key = resource.toLowerCase();
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    normalized.push(resource);
  }

  return normalized.length > 0 ? normalized : undefined;
}

function phaseSectionTemplate(phaseTitle: string): GeneratedPlanSectionDraft[] {
  const lowered = phaseTitle.toLowerCase();
  if (lowered.includes("foundation")) {
    return [
      {
        title: "Excavation & Base",
        description: "Prepare trenches, compaction, and base setup.",
        tasks: [
          {
            title: "Mark foundation lines",
            priority: "MEDIUM",
            deliverable: "Approved setout lines"
          },
          {
            title: "Excavate to required depth",
            priority: "MEDIUM",
            deliverable: "Excavated foundation footprint"
          },
          {
            title: "Compact base and blinding",
            priority: "MEDIUM",
            deliverable: "Compacted base ready for reinforcement"
          }
        ]
      },
      {
        title: "Rebar & Formwork",
        description: "Install steel and shuttering prior to pour.",
        tasks: [
          {
            title: "Install rebar cage",
            priority: "HIGH",
            deliverable: "Reinforcement installed to drawings"
          },
          {
            title: "Set formwork and levels",
            priority: "HIGH",
            deliverable: "Levelled forms ready for inspection"
          }
        ]
      },
      {
        title: "Concrete Pour",
        description: "Pour, vibrate, and cure foundation concrete.",
        tasks: [
          {
            title: "Schedule pour crew and pump",
            priority: "HIGH",
            deliverable: "Confirmed pour window and crew"
          },
          {
            title: "Pour and vibrate concrete",
            priority: "HIGH",
            deliverable: "Poured and consolidated foundation concrete"
          },
          {
            title: "Curing and quality checks",
            priority: "MEDIUM",
            deliverable: "Cured concrete with inspection records"
          }
        ]
      }
    ];
  }

  if (lowered.includes("structure")) {
    return [
      {
        title: "Block/Wall Work",
        tasks: [
          { title: "Set out wall lines", priority: "MEDIUM" },
          { title: "Lay blocks and lintels", priority: "HIGH" }
        ]
      },
      {
        title: "Slab/Decking",
        tasks: [
          { title: "Install slab formwork", priority: "HIGH" },
          { title: "Place reinforcement", priority: "HIGH" },
          { title: "Pour structural slab", priority: "HIGH" }
        ]
      },
      {
        title: "Roof Structure",
        tasks: [
          { title: "Install trusses/roof frame", priority: "MEDIUM" },
          { title: "Fix roofing sheets/tiles", priority: "MEDIUM" }
        ]
      }
    ];
  }

  if (lowered.includes("mep")) {
    return [
      {
        title: "Electrical",
        tasks: [
          { title: "Conduits and junction boxes", priority: "HIGH" },
          { title: "Panel and circuit setup", priority: "MEDIUM" }
        ]
      },
      {
        title: "Plumbing",
        tasks: [
          { title: "Water and waste rough-in", priority: "HIGH" },
          { title: "Pressure/leak testing", priority: "MEDIUM" }
        ]
      },
      {
        title: "HVAC / Ventilation",
        tasks: [
          { title: "Duct and equipment rough-in", priority: "MEDIUM" },
          { title: "Service access checks", priority: "LOW" }
        ]
      }
    ];
  }

  if (lowered.includes("interior")) {
    return [
      {
        title: "Flooring",
        tasks: [
          { title: "Leveling and screed", priority: "MEDIUM" },
          { title: "Install final floor finish", priority: "MEDIUM" }
        ]
      },
      {
        title: "Ceiling & Paint",
        tasks: [
          { title: "Ceiling board installation", priority: "MEDIUM" },
          { title: "Prime and paint surfaces", priority: "MEDIUM" }
        ]
      },
      {
        title: "Joinery & Fixtures",
        tasks: [
          { title: "Install doors and cabinets", priority: "MEDIUM" },
          { title: "Install sanitary fixtures", priority: "MEDIUM" }
        ]
      }
    ];
  }

  return [
    {
      title: "Planning & Setup",
      tasks: [
        { title: "Define detailed scope", priority: "MEDIUM" },
        { title: "Assign owner and resources", priority: "MEDIUM" }
      ]
    },
    {
      title: "Execution",
      tasks: [
        { title: "Execute core activities", priority: "HIGH" },
        { title: "Track progress and issues", priority: "MEDIUM" }
      ]
    },
    {
      title: "Quality & Closeout",
      tasks: [
        { title: "Quality inspection", priority: "MEDIUM" },
        { title: "Close section and handoff", priority: "LOW" }
      ]
    }
  ];
}

function buildVerificationQuestions(phases: GeneratedPlanPhaseDraft[]): string[] {
  const firstPhase = phases[0]?.title ?? "Phase 1";
  return [
    `Does ${firstPhase} start with the correct construction sequence for your site?`,
    "Are the listed sections complete for each phase (no major work area missing)?",
    "Do the scope notes match how your crew actually executes this build?",
    "Are the phase and section estimates realistic for your local costs?",
    "Should any section be split into additional tasks for better tracking?",
    "Are owners, dates, and statuses correct before building this into live tasks?"
  ];
}

type ScopeCoverage = {
  hasDimensions: boolean;
  hasExecutionStructure: boolean;
  hasBudget: boolean;
  hasTimeline: boolean;
  hasWorkScope: boolean;
  hasConstraints: boolean;
  allowsPlannerAssumptions: boolean;
};

function extractScopeSignalText(prompt: string): string {
  const originalScopeMatch = prompt.match(/Original build scope:\s*([\s\S]*?)\n\s*Current plan summary:/i);
  const revisionScopeMatch = prompt.match(
    /Clarifications and revisions from user:\s*([\s\S]*?)\n\s*Regenerate the construction plan\./i
  );

  const segments = [originalScopeMatch?.[1], revisionScopeMatch?.[1]]
    .map((segment) => (typeof segment === "string" ? segment.trim() : ""))
    .filter((segment) => segment.length > 0);

  if (segments.length > 0) {
    return segments.join("\n");
  }

  return prompt;
}

function evaluateScopeCoverage(prompt: string): ScopeCoverage {
  const normalized = extractScopeSignalText(prompt).toLowerCase();

  return {
    hasDimensions: /(\d+\s*(ft|feet|m|meter|metre)|footprint|width|length|area|sq\.?\s*(ft|m)|floor\s*\d)/i.test(normalized),
    hasExecutionStructure: /(phase|section|subsection|sequence|order|after|before|in sections|floor by floor)/i.test(normalized),
    hasBudget: /(budget|\$|jmd|usd|cost|estimate|price|allowance)/i.test(normalized),
    hasTimeline: /(date|timeline|week|month|deadline|duration|finish|milestone|start)/i.test(normalized),
    hasWorkScope: /(foundation|roof|plumbing|electrical|concrete|block|steel|mep|flooring|masonry|excavat|utility)/i.test(normalized),
    hasConstraints: /(permit|approval|parish|utility|site|access|rain|weather|occupied|logistics|inspection)/i.test(normalized),
    allowsPlannerAssumptions: /(assume|use your best estimate|best estimate|fill in missing|you decide|reasonable default|tbd|not sure)/i.test(
      normalized
    )
  };
}

function countClarificationResponses(prompt: string): number {
  const priorClarificationsMatch = prompt.match(
    /Prior clarification answers from user:\s*([\s\S]*?)\n\s*Clarifications and revisions from user:/i
  );
  const latestClarificationMatch = prompt.match(
    /Clarifications and revisions from user:\s*([\s\S]*?)\n\s*Regenerate the construction plan\./i
  );

  const segments = [priorClarificationsMatch?.[1], latestClarificationMatch?.[1]]
    .map((segment) => (typeof segment === "string" ? segment.trim() : ""))
    .filter((segment) => segment.length > 0);

  if (segments.length === 0) {
    return 0;
  }

  return segments
    .flatMap((segment) =>
      segment
        .split(/\r?\n|[.;]/)
        .map((part) => part.replace(/^\s*\d+[\).\s:-]*/, "").trim())
        .filter((part) => part.length >= 8)
    )
    .length;
}

function buildClarificationQuestions(prompt: string): string[] {
  const coverage = evaluateScopeCoverage(prompt);
  const questions: string[] = [];

  if (!coverage.hasExecutionStructure) {
    questions.push("What execution sequence do you want (phase-by-phase, section-by-section, or mixed)?");
  }
  if (!coverage.hasDimensions) {
    questions.push("What footprint/dimensions should this scope cover (width, length, area, or floors)?");
  }
  if (!coverage.hasWorkScope) {
    questions.push("Which exact work scopes must be included (foundation, structure, MEP, finishes, etc.)?");
  }
  if (!coverage.hasTimeline) {
    questions.push("What timeline constraints should I plan against (start, finish, duration, milestones)?");
  }
  if (!coverage.hasBudget) {
    questions.push("What budget or target cost range should I use?");
  }
  if (!coverage.hasConstraints) {
    questions.push("Any site constraints, permits, utility conditions, or weather/logistics limits to account for?");
  }

  if (questions.length > 0) {
    return questions.slice(0, 8);
  }

  return [
    "Do you want me to generate the phase/section/task plan now with the details provided?",
    "Any final corrections before I build the plan?"
  ];
}

function hasSufficientScopeDetail(prompt: string): boolean {
  const sourceText = extractScopeSignalText(prompt);
  const coverage = evaluateScopeCoverage(sourceText);
  const clarificationResponseCount = countClarificationResponses(prompt);
  const score = [
    coverage.hasDimensions,
    coverage.hasExecutionStructure,
    coverage.hasBudget,
    coverage.hasTimeline,
    coverage.hasWorkScope,
    coverage.hasConstraints
  ].filter(Boolean).length;

  if (sourceText.trim().length < 60 && clarificationResponseCount < 2) {
    return false;
  }

  if (!coverage.hasWorkScope) {
    return false;
  }

  if (!coverage.hasExecutionStructure && clarificationResponseCount < 2) {
    return false;
  }

  if (coverage.allowsPlannerAssumptions) {
    return score >= 3;
  }

  if (clarificationResponseCount >= 2) {
    return score >= 4;
  }

  return score >= 5;
}

function buildClarificationPlan(prompt: string): GeneratedTaskPlanDraft {
  const missingCount = buildClarificationQuestions(prompt).length;
  return {
    phases: [],
    assumptions: [
      `Scope detail is incomplete. Please answer the clarification questions so the generated plan is accurate (${missingCount} item${
        missingCount === 1 ? "" : "s"
      }).`
    ],
    verificationQuestions: buildClarificationQuestions(prompt)
  };
}

function applyWbsMetadata(phases: GeneratedPlanPhaseDraft[]): GeneratedPlanPhaseDraft[] {
  return phases.map((phase, phaseIndex) => {
    const phaseBase = phase.wbsId ?? `${phaseIndex + 1}.0`;
    let taskCursor = 1;
    let previousTaskWbs = `${Math.max(0, phaseIndex)}.0`;

    const sections = phase.sections.map((section) => {
      const tasks = section.tasks.map((task) => {
        const wbsId = task.wbsId ?? `${phaseIndex + 1}.${taskCursor}`;
        const normalizedPredecessor = task.predecessor ?? previousTaskWbs;
        previousTaskWbs = wbsId;
        taskCursor += 1;

        return {
          ...task,
          wbsId,
          predecessor: normalizedPredecessor,
          deliverable: task.deliverable ?? "Defined deliverable pending review"
        };
      });

      return { ...section, tasks };
    });

    return {
      ...phase,
      wbsId: phaseBase,
      sections
    };
  });
}

function buildFallbackPlan(prompt: string, maxPhases: number): GeneratedTaskPlanDraft {
  if (!hasSufficientScopeDetail(prompt)) {
    return buildClarificationPlan(prompt);
  }

  const explicitPhases = Array.from(prompt.matchAll(/phase\s*\d+\s*[:\-]\s*([^\n\r]+)/gi))
    .map((match) => sanitizeText(match[1]))
    .filter((title) => title.length > 0);

  const phaseTitles = (explicitPhases.length > 0 ? explicitPhases : defaultPhaseTitles).slice(0, Math.max(1, maxPhases));
  const phases = phaseTitles.map((title, phaseIndex) => ({
    title,
    description: `Generated baseline scope for ${title}.`,
    status: "PLANNED" as const,
    priority: "MEDIUM" as const,
    wbsId: `${phaseIndex + 1}.0`,
    sections: phaseSectionTemplate(title)
  }));

  const assumptions = [
    "Baseline plan generated from prompt with construction defaults.",
    "Adjust owners, dates, and estimates per local crew and market rates."
  ];

  const phasesWithWbs = applyWbsMetadata(phases);
  return { phases: phasesWithWbs, assumptions, verificationQuestions: buildVerificationQuestions(phasesWithWbs) };
}

function normalizePlanCandidate(candidate: unknown, fallbackPrompt: string, maxPhases: number): GeneratedTaskPlanDraft {
  if (!candidate || typeof candidate !== "object") {
    return buildFallbackPlan(fallbackPrompt, maxPhases);
  }

  const maybePlan = candidate as { phases?: unknown; assumptions?: unknown; verificationQuestions?: unknown };
  const phaseCandidates = Array.isArray(maybePlan.phases) ? maybePlan.phases : [];
  const phases: GeneratedPlanPhaseDraft[] = [];

  for (const phase of phaseCandidates) {
    if (phases.length >= Math.max(1, maxPhases)) {
      break;
    }

    const phaseRecord = phase as Record<string, unknown>;
    const title = sanitizeText(phaseRecord.title);
    if (!title) {
      continue;
    }

    const sections: GeneratedPlanSectionDraft[] = [];
    const sectionCandidates = Array.isArray(phaseRecord.sections) ? phaseRecord.sections : [];

    for (const section of sectionCandidates) {
      const sectionRecord = section as Record<string, unknown>;
      const sectionTitle = sanitizeText(sectionRecord.title);
      if (!sectionTitle) {
        continue;
      }

      const tasks: GeneratedPlanTaskDraft[] = [];
      const taskCandidates = Array.isArray(sectionRecord.tasks) ? sectionRecord.tasks : [];
      for (const task of taskCandidates) {
        const taskRecord = task as Record<string, unknown>;
        const taskTitle = sanitizeText(taskRecord.title);
        if (!taskTitle) {
          continue;
        }

        tasks.push({
          title: taskTitle,
          description: sanitizeText(taskRecord.description) || undefined,
          status: sanitizeStatus(taskRecord.status),
          priority: sanitizePriority(taskRecord.priority),
          estimateAmount: sanitizeNumber(taskRecord.estimateAmount),
          resources: sanitizeResourceList(taskRecord.resources),
          wbsId: sanitizeWbsCode(taskRecord.wbsId),
          predecessor: sanitizeWbsCode(taskRecord.predecessor),
          deliverable: sanitizeText(taskRecord.deliverable) || undefined
        });
      }

      sections.push({
        title: sectionTitle,
        description: sanitizeText(sectionRecord.description) || undefined,
        status: sanitizeStatus(sectionRecord.status),
        owner: sanitizeText(sectionRecord.owner) || undefined,
        resources: sanitizeResourceList(sectionRecord.resources),
        estimateAmount: sanitizeNumber(sectionRecord.estimateAmount),
        tasks
      });
    }

    phases.push({
      title,
      description: sanitizeText(phaseRecord.description) || undefined,
      status: sanitizeStatus(phaseRecord.status),
      owner: sanitizeText(phaseRecord.owner) || undefined,
      resources: sanitizeResourceList(phaseRecord.resources),
      priority: sanitizePriority(phaseRecord.priority),
      plannedStartDate: sanitizeDate(phaseRecord.plannedStartDate),
      plannedEndDate: sanitizeDate(phaseRecord.plannedEndDate),
      dueDate: sanitizeDate(phaseRecord.dueDate),
      estimateAmount: sanitizeNumber(phaseRecord.estimateAmount),
      wbsId: sanitizeWbsCode(phaseRecord.wbsId),
      sections: sections.length > 0 ? sections : phaseSectionTemplate(title)
    });
  }

  const assumptions =
    Array.isArray(maybePlan.assumptions) && maybePlan.assumptions.length > 0
      ? maybePlan.assumptions
          .map((value) => sanitizeText(value))
          .filter((value) => value.length > 0)
      : ["Generated from your prompt. Review assumptions before building."];

  const verificationQuestions =
    Array.isArray(maybePlan.verificationQuestions) && maybePlan.verificationQuestions.length > 0
      ? maybePlan.verificationQuestions
          .map((value) => sanitizeText(value))
          .filter((value) => value.length > 0)
      : phases.length > 0
        ? buildVerificationQuestions(phases)
        : buildClarificationQuestions(fallbackPrompt);

  if (phases.length === 0) {
    if (hasSufficientScopeDetail(fallbackPrompt)) {
      const fallbackPlan = buildFallbackPlan(fallbackPrompt, maxPhases);
      return {
        ...fallbackPlan,
        assumptions: [
          ...fallbackPlan.assumptions,
          "AI requested additional clarification, so a baseline phase/section/task plan was generated from your supplied details."
        ]
      };
    }

    return {
      phases: [],
      assumptions:
        assumptions.length > 0
          ? assumptions
          : ["Need additional scope details before generating phases and task rows."],
      verificationQuestions
    };
  }

  const phasesWithWbs = applyWbsMetadata(phases);
  return { phases: phasesWithWbs, assumptions, verificationQuestions };
}

function extractJsonString(rawText: string): string {
  const fencedMatch = rawText.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fencedMatch?.[1]) {
    return fencedMatch[1].trim();
  }

  return rawText.trim();
}

export async function generatePhasePlanFromPrompt(
  prompt: string,
  maxPhases: number
): Promise<{ plan: GeneratedTaskPlanDraft; provider: "openai" | "fallback"; warning?: string }> {
  if (!env.OPENAI_API_KEY) {
    return {
      plan: buildFallbackPlan(prompt, maxPhases),
      provider: "fallback",
      warning: "OPENAI_API_KEY is not configured. Returned a local baseline plan."
    };
  }

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: env.OPENAI_MODEL,
        temperature: 0.2,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              "You are a construction project planner. Return strict JSON with keys: phases (array), assumptions (array), verificationQuestions (array). " +
              "Each phase: wbsId, title, description, status, owner, resources[], priority, plannedStartDate, plannedEndDate, dueDate, estimateAmount, sections[]. " +
              "Each section: title, description, status, owner, resources[], estimateAmount, tasks[]. " +
              "Each task: wbsId, title, predecessor, deliverable, description, status, priority, estimateAmount, resources[]. " +
              "Use a WBS style appropriate for construction sequencing (example phase 1.0 then tasks 1.1, 1.2...). " +
              "Predecessor should reference prior WBS where applicable. " +
              "If scope is incomplete or ambiguous, return phases as an empty array and put 4-8 clarification questions in verificationQuestions. " +
              "Do not fabricate a full phase plan until clarifications are provided. " +
              "verificationQuestions must be 4-8 concise review questions the user should verify before building. " +
              "Use ISO date strings (YYYY-MM-DD). Keep output practical and concise."
          },
          {
            role: "user",
            content:
              `Build a construction plan from this request: ${prompt}\n` +
              `Limit to at most ${Math.max(1, maxPhases)} phases and include actionable sections/tasks.\n` +
              "Return tasks in a table-friendly WBS style with columns: WBS ID, Task Name, Predecessor, Deliverable.\n" +
              "If key details are missing, ask clarification questions first by returning phases: []."
          }
        ]
      })
    });

    if (!response.ok) {
      const message = await response.text();
      throw new Error(message || `OpenAI request failed with ${response.status}`);
    }

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string | Array<{ text?: string }> } }>;
    };

    const content = payload.choices?.[0]?.message?.content;
    const rawText =
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("")
          : "";

    if (!rawText) {
      throw new Error("Model response was empty");
    }

    const parsed = JSON.parse(extractJsonString(rawText)) as unknown;
    const plan = normalizePlanCandidate(parsed, prompt, maxPhases);

    if (!hasSufficientScopeDetail(prompt) && plan.phases.length > 0) {
      return { plan: buildClarificationPlan(prompt), provider: "openai" };
    }

    return { plan, provider: "openai" };
  } catch (error) {
    return {
      plan: buildFallbackPlan(prompt, maxPhases),
      provider: "fallback",
      warning: error instanceof Error ? error.message : "AI generation failed; returned local baseline plan."
    };
  }
}
