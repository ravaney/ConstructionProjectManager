export function formatCurrency(value: number, currency = "USD"): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    maximumFractionDigits: 2
  }).format(value);
}

export function parseCalendarDate(value: string | Date | undefined): Date | null {
  if (!value) {
    return null;
  }

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      return null;
    }

    return new Date(value.getFullYear(), value.getMonth(), value.getDate());
  }

  const calendarMatch = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (calendarMatch) {
    const year = Number(calendarMatch[1]);
    const monthIndex = Number(calendarMatch[2]) - 1;
    const day = Number(calendarMatch[3]);
    const parsed = new Date(year, monthIndex, day);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate());
}

export function formatCalendarDate(value: string | Date | undefined): string {
  const date = parseCalendarDate(value);
  if (!date) {
    return "-";
  }

  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric"
  });
}

export function formatDate(value: string | Date | undefined): string {
  if (!value) {
    return "-";
  }

  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) {
    return "-";
  }

  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric"
  });
}
