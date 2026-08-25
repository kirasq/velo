import { useMemo } from "react";
import { X, Plus } from "lucide-react";
import {
  parseQueryToConditions,
  buildQueryFromConditions,
  type Condition,
  type ConditionType,
  visualQueryBuilderOrder,
} from "@/services/search/visualQueryBuilder";
import { t, useLang } from "@/i18n";

interface SmartFolderQueryBuilderProps {
  value: string;
  onChange: (query: string) => void;
  mode?: "visual" | "raw";
  onModeChange?: (mode: "visual" | "raw") => void;
}

export function SmartFolderQueryBuilder({
  value,
  onChange,
  mode = "visual",
  onModeChange,
}: SmartFolderQueryBuilderProps) {
  useLang();
  const conditions = useMemo(() => parseQueryToConditions(value), [value]);

  const typeLabels: Record<ConditionType, string> = {
    keywords: t("smartFolder.condition.keywords"),
    from: t("smartFolder.condition.from"),
    to: t("smartFolder.condition.to"),
    subject: t("smartFolder.condition.subject"),
    is: t("smartFolder.condition.status"),
    hasAttachment: t("smartFolder.condition.hasAttachment"),
    after: t("smartFolder.condition.after"),
    before: t("smartFolder.condition.before"),
    label: t("smartFolder.condition.label"),
  };
  const conditionTypeOrder = visualQueryBuilderOrder as ConditionType[];

  const statusOptions = [
    { value: "unread", label: t("smartFolder.status.unread") },
    { value: "read", label: t("smartFolder.status.read") },
    { value: "starred", label: t("smartFolder.status.starred") },
  ];

  function updateConditions(next: Condition[]) {
    onChange(buildQueryFromConditions(next));
  }

  function addCondition(type: ConditionType = "keywords") {
    const newCondition: Condition = {
      id: `cond-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      type,
      value: type === "hasAttachment" ? "attachment" : "",
    };
    updateConditions([...conditions, newCondition]);
  }

  function removeCondition(id: string) {
    updateConditions(conditions.filter((c) => c.id !== id));
  }

  function updateCondition(id: string, patch: Partial<Condition>) {
    updateConditions(
      conditions.map((c) => {
        if (c.id !== id) return c;
        const next = { ...c, ...patch };
        if (patch.type === "hasAttachment") next.value = "attachment";
        return next;
      }),
    );
  }

  const inputClass =
    "px-2.5 py-1.5 bg-bg-tertiary border border-border-primary rounded text-sm text-text-primary outline-none focus:border-accent min-w-0";

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <label className="text-xs text-text-secondary">
          {t("sidebar.smartFolderQuery")}
        </label>
        <button
          type="button"
          onClick={() => onModeChange?.(mode === "visual" ? "raw" : "visual")}
          className="text-xs text-accent hover:text-accent-hover"
        >
          {mode === "visual" ? t("smartFolder.modeRaw") : t("smartFolder.modeVisual")}
        </button>
      </div>

      {mode === "visual" ? (
        <div className="space-y-2">
          {conditions.length === 0 && (
            <div className="text-xs text-text-tertiary py-2">
              {t("smartFolder.emptyConditions")}
            </div>
          )}

          {conditions.map((condition) => (
            <div key={condition.id} className="flex items-start gap-2">
              <select
                value={condition.type}
                onChange={(e) =>
                  updateCondition(condition.id, { type: e.target.value as ConditionType })
                }
                className={`${inputClass} shrink-0 w-[110px]`}
              >
                {conditionTypeOrder.map((type) => (
                  <option key={type} value={type}>
                    {typeLabels[type]}
                  </option>
                ))}
              </select>

              {condition.type === "is" ? (
                <select
                  value={condition.value || "unread"}
                  onChange={(e) => updateCondition(condition.id, { value: e.target.value })}
                  className={`${inputClass} flex-1`}
                >
                  {statusOptions.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              ) : condition.type === "hasAttachment" ? (
                <div className={`${inputClass} flex-1 text-text-secondary`}>
                  {t("smartFolder.hasAttachmentValue")}
                </div>
              ) : condition.type === "after" || condition.type === "before" ? (
                <input
                  type="date"
                  value={
                    condition.value
                      ? condition.value.replace(/\//g, "-")
                      : ""
                  }
                  onChange={(e) => {
                    const raw = e.target.value; // YYYY-MM-DD
                    if (!raw) {
                      updateCondition(condition.id, { value: "" });
                      return;
                    }
                    const [y, m, d] = raw.split("-");
                    updateCondition(condition.id, {
                      value: `${y}/${m}/${d}`,
                    });
                  }}
                  className={`${inputClass} flex-1`}
                />
              ) : (
                <input
                  type="text"
                  value={condition.value}
                  onChange={(e) =>
                    updateCondition(condition.id, { value: e.target.value })
                  }
                  placeholder={
                    condition.type === "keywords"
                      ? t("smartFolder.placeholder.keywords")
                      : condition.type === "label"
                        ? t("smartFolder.placeholder.label")
                        : t("smartFolder.placeholder.default")
                  }
                  className={`${inputClass} flex-1`}
                />
              )}

              <button
                type="button"
                onClick={() => removeCondition(condition.id)}
                className="p-1.5 text-text-tertiary hover:text-danger rounded"
                title={t("smartFolder.removeCondition")}
              >
                <X size={14} />
              </button>
            </div>
          ))}

          <div className="flex flex-wrap gap-2 pt-1">
            {conditionTypeOrder.map((type) => (
              <button
                key={type}
                type="button"
                onClick={() => addCondition(type)}
                className="inline-flex items-center gap-1 px-2 py-1 text-xs text-text-secondary bg-bg-secondary hover:bg-bg-tertiary border border-border-primary rounded transition-colors"
              >
                <Plus size={12} />
                {typeLabels[type]}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          <input
            type="text"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={t("sidebar.smartFolderQueryPlaceholder")}
            className="w-full px-3 py-1.5 bg-bg-tertiary border border-border-primary rounded text-sm text-text-primary outline-none focus:border-accent font-mono"
          />
          <p className="text-[0.625rem] text-text-tertiary">
            {t("smartFolder.rawHint")}
          </p>
        </div>
      )}

      <div className="text-xs text-text-tertiary bg-bg-secondary rounded px-2.5 py-1.5 break-all">
        <span className="text-text-secondary">{t("smartFolder.preview")}: </span>
        {value.trim() || t("smartFolder.emptyPreview")}
      </div>
    </div>
  );
}
