type BuildFlowVariant = "light" | "dark";

type BuildFlowWordmarkProps = {
  variant?: BuildFlowVariant;
  className?: string;
};

type BuildFlowMonogramProps = {
  variant?: BuildFlowVariant;
  className?: string;
};

function getWordmarkColors(variant: BuildFlowVariant) {
  if (variant === "dark") {
    return {
      buildFlow: "#F3F4F6",
      ai: "#9CA3AF"
    };
  }

  return {
    buildFlow: "#1A1A1A",
    ai: "#6B7280"
  };
}

export function BuildFlowWordmark({ variant = "light", className }: BuildFlowWordmarkProps) {
  const colors = getWordmarkColors(variant);
  return (
    <span className={`buildflow-wordmark ${className ?? ""}`.trim()} aria-label="BuildFlow AI">
      <span className="buildflow-wordmark-main" style={{ color: colors.buildFlow }}>
        BuildFlow
      </span>
      <span className="buildflow-wordmark-ai" style={{ color: colors.ai }}>
        AI
      </span>
    </span>
  );
}

export function BuildFlowMonogram({ variant = "light", className }: BuildFlowMonogramProps) {
  const colors = getWordmarkColors(variant);
  return (
    <span className={`buildflow-monogram ${className ?? ""}`.trim()} aria-label="BuildFlow monogram">
      <span style={{ color: colors.buildFlow }}>B</span>
      <span style={{ color: colors.ai }}>F</span>
    </span>
  );
}
