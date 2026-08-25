import { useState, useEffect, useCallback } from "react";
import { Trash2, Pencil } from "lucide-react";
import { useAccountStore } from "@/stores/accountStore";
import {
  getSmartFolders,
  insertSmartFolder,
  updateSmartFolder,
  deleteSmartFolder,
  type DbSmartFolder,
} from "@/services/db/smartFolders";
import { useSmartFolderStore } from "@/stores/smartFolderStore";
import { SmartFolderQueryBuilder } from "./SmartFolderQueryBuilder";
import { t, useLang } from "@/i18n";

export function SmartFolderEditor() {
  useLang();
  const activeAccountId = useAccountStore((s) => s.activeAccountId);
  const reloadStore = useSmartFolderStore((s) => s.loadFolders);
  const [folders, setFolders] = useState<DbSmartFolder[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);

  // Form state
  const [name, setName] = useState("");
  const [query, setQuery] = useState("");
  const [queryMode, setQueryMode] = useState<"visual" | "raw">("visual");
  const [icon, setIcon] = useState("Search");
  const [color, setColor] = useState("");

  const loadFolders = useCallback(async () => {
    const f = await getSmartFolders(activeAccountId ?? undefined);
    setFolders(f);
  }, [activeAccountId]);

  useEffect(() => {
    loadFolders();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- loadFolders is stable, only re-run on activeAccountId change
  }, [activeAccountId]);

  const resetForm = useCallback(() => {
    setName("");
    setQuery("");
    setIcon("Search");
    setColor("");
    setEditingId(null);
    setShowForm(false);
  }, []);

  const handleSave = useCallback(async () => {
    if (!name.trim() || !query.trim()) return;

    if (editingId) {
      await updateSmartFolder(editingId, {
        name: name.trim(),
        query: query.trim(),
        icon: icon.trim() || "Search",
        color: color.trim() || undefined,
      });
    } else {
      await insertSmartFolder({
        name: name.trim(),
        query: query.trim(),
        accountId: activeAccountId ?? undefined,
        icon: icon.trim() || "Search",
        color: color.trim() || undefined,
      });
    }

    resetForm();
    await loadFolders();
    await reloadStore(activeAccountId ?? undefined);
  }, [activeAccountId, name, query, icon, color, editingId, resetForm, loadFolders, reloadStore]);

  const handleEdit = useCallback((folder: DbSmartFolder) => {
    setEditingId(folder.id);
    setName(folder.name);
    setQuery(folder.query);
    setQueryMode("visual");
    setIcon(folder.icon);
    setColor(folder.color ?? "");
    setShowForm(true);
  }, []);

  const handleDelete = useCallback(async (id: string) => {
    await deleteSmartFolder(id);
    if (editingId === id) resetForm();
    await loadFolders();
    await reloadStore(activeAccountId ?? undefined);
  }, [editingId, resetForm, loadFolders, reloadStore, activeAccountId]);

  return (
    <div className="space-y-3">
      {folders.map((folder) => (
        <div
          key={folder.id}
          className="flex items-center justify-between py-2 px-3 bg-bg-secondary rounded-md"
        >
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-text-primary flex items-center gap-2">
              {folder.name}
              {folder.is_default === 1 && (
                <span className="text-[0.625rem] bg-accent/15 text-accent px-1.5 py-0.5 rounded">
                  {t("common.default")}
                </span>
              )}
            </div>
            <div className="text-xs text-text-tertiary truncate">
              {folder.query}
            </div>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={() => handleEdit(folder)}
              className="p-1 text-text-tertiary hover:text-text-primary"
              title={t("common.edit")}
            >
              <Pencil size={13} />
            </button>
            {folder.is_default !== 1 && (
              <button
                onClick={() => handleDelete(folder.id)}
                className="p-1 text-text-tertiary hover:text-danger"
                title={t("common.delete")}
              >
                <Trash2 size={13} />
              </button>
            )}
          </div>
        </div>
      ))}

      {showForm ? (
        <div className="border border-border-primary rounded-md p-3 space-y-3">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("sidebar.smartFolderNamePlaceholder")}
            className="w-full px-3 py-1.5 bg-bg-tertiary border border-border-primary rounded text-sm text-text-primary outline-none focus:border-accent"
          />

          <SmartFolderQueryBuilder
            value={query}
            onChange={setQuery}
            mode={queryMode}
            onModeChange={setQueryMode}
          />

          <div className="flex gap-3">
            <div className="flex-1">
              <label className="text-xs text-text-secondary block mb-1">
                {t("smartFolder.iconName")}
              </label>
              <input
                type="text"
                value={icon}
                onChange={(e) => setIcon(e.target.value)}
                placeholder={t("smartFolder.iconName")}
                className="w-full px-3 py-1 bg-bg-tertiary border border-border-primary rounded text-xs text-text-primary outline-none focus:border-accent"
              />
              <p className="text-[0.625rem] text-text-tertiary mt-0.5">
                {t("smartFolder.iconHint")}
              </p>
            </div>
            <div className="flex-1">
              <label className="text-xs text-text-secondary block mb-1">
                {t("smartFolder.color")}
              </label>
              <input
                type="text"
                value={color}
                onChange={(e) => setColor(e.target.value)}
                placeholder="#6366f1"
                className="w-full px-3 py-1 bg-bg-tertiary border border-border-primary rounded text-xs text-text-primary outline-none focus:border-accent"
              />
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={handleSave}
              disabled={!name.trim() || !query.trim()}
              className="px-3 py-1.5 text-xs font-medium text-white bg-accent hover:bg-accent-hover rounded-md transition-colors disabled:opacity-50"
            >
              {editingId ? t("common.update") : t("common.save")}
            </button>
            <button
              onClick={resetForm}
              className="px-3 py-1.5 text-xs text-text-secondary hover:text-text-primary rounded-md transition-colors"
            >
              {t("common.cancel")}
            </button>
          </div>
        </div>
      ) : (
        <button
          onClick={() => setShowForm(true)}
          className="text-xs text-accent hover:text-accent-hover"
        >
          + {t("sidebar.addSmartFolder")}
        </button>
      )}
    </div>
  );
}
