/**
 * A row of headline numbers: side-by-side cards from `sm` up, one compact card
 * of label/value lines on phones, where three full-width cards took a screen.
 */
export function Stats({ children }: { children: React.ReactNode }) {
  return (
    <div className="divide-y divide-line rounded-2xl border border-line bg-surface sm:grid sm:grid-cols-3 sm:gap-4 sm:divide-y-0 sm:rounded-none sm:border-0 sm:bg-transparent">
      {children}
    </div>
  );
}

export function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 px-4 py-3 sm:block sm:rounded-2xl sm:border sm:border-line sm:bg-surface sm:p-5">
      <div className="text-sm text-muted">{label}</div>
      <div className="text-right sm:text-left">
        <div className="num text-lg font-semibold sm:mt-1 sm:text-2xl">{value}</div>
        {note && <div className="num text-xs text-muted sm:mt-1 sm:text-sm">{note}</div>}
      </div>
    </div>
  );
}
