import { useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  XCircle,
  Loader2,
  Server,
  Mail,
  Send,
  ShieldCheck,
  Clock,
} from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { insertPop3Account, updatePop3Account } from "@/services/db/accounts";
import { useAccountStore } from "@/stores/accountStore";
import { t, useLang } from "@/i18n";
import {
  type SecurityType,
} from "@/services/imap/autoDiscovery";

interface AddPop3AccountProps {
  onClose: () => void;
  onSuccess: () => void;
  onBack: () => void;
  /** When provided, the form opens in edit mode for an existing account. */
  accountId?: string;
  existing?: {
    email: string;
    displayName: string | null;
    username: string;
    pop3Host: string;
    pop3Port: number;
    pop3Security: string;
    smtpHost: string;
    smtpPort: number;
    smtpSecurity: string;
    retentionDays: number;
    acceptInvalidCerts?: boolean | number;
  };
}

type Step = "basic" | "pop3" | "smtp" | "test";
type TestState = "idle" | "testing" | "success" | "error";

interface FormState {
  email: string;
  displayName: string;
  username: string;
  pop3Host: string;
  pop3Port: number;
  pop3Security: SecurityType;
  smtpHost: string;
  smtpPort: number;
  smtpSecurity: SecurityType;
  password: string;
  smtpPassword: string;
  samePassword: boolean;
  retentionDays: number;
  acceptInvalidCerts: boolean;
}

const initialFormState: FormState = {
  email: "",
  displayName: "",
  username: "",
  pop3Host: "",
  pop3Port: 995,
  pop3Security: "ssl",
  smtpHost: "",
  smtpPort: 465,
  smtpSecurity: "ssl",
  password: "",
  smtpPassword: "",
  samePassword: true,
  retentionDays: 30,
  acceptInvalidCerts: false,
};

const steps: Step[] = ["basic", "pop3", "smtp", "test"];
const stepLabels: Record<Step, string> = {
  basic: t("pop3.step.basic"),
  pop3: t("pop3.step.pop3"),
  smtp: t("pop3.step.smtp"),
  test: t("pop3.step.test"),
};
const stepIcons: Record<Step, React.ReactNode> = {
  basic: <Mail className="w-4 h-4" />,
  pop3: <Server className="w-4 h-4" />,
  smtp: <Send className="w-4 h-4" />,
  test: <ShieldCheck className="w-4 h-4" />,
};

const inputClass =
  "w-full px-3 py-2 bg-bg-secondary border border-border-primary rounded-lg text-sm text-text-primary outline-none focus:border-accent transition-colors";
const labelClass = "block text-xs font-medium text-text-secondary mb-1";
const selectClass =
  "w-full px-3 py-2 bg-bg-secondary border border-border-primary rounded-lg text-sm text-text-primary outline-none focus:border-accent transition-colors appearance-none";

function mapSecurity(security: string): "tls" | "starttls" | "none" {
  if (security === "ssl") return "tls";
  if (security === "starttls") return "starttls";
  return "none";
}

interface TestStatus {
  state: TestState;
  message?: string;
}

export function AddPop3Account({
  onClose,
  onSuccess,
  onBack,
  accountId,
  existing,
}: AddPop3AccountProps) {
  const isEdit = !!accountId && !!existing;
  const lang = useLang();
  void lang; // re-render on language change
  const [currentStep, setCurrentStep] = useState<Step>("basic");
  const [form, setForm] = useState<FormState>(() => {
    if (!existing) return initialFormState;
    return {
      ...initialFormState,
      email: existing.email,
      displayName: existing.displayName ?? "",
      username: existing.username,
      pop3Host: existing.pop3Host,
      pop3Port: existing.pop3Port,
      pop3Security: (existing.pop3Security as SecurityType) || "ssl",
      smtpHost: existing.smtpHost,
      smtpPort: existing.smtpPort,
      smtpSecurity: (existing.smtpSecurity as SecurityType) || "ssl",
      retentionDays: existing.retentionDays,
      acceptInvalidCerts: !!existing.acceptInvalidCerts,
      // password left blank in edit mode; blank = keep existing
    };
  });
  const [pop3Test, setPop3Test] = useState<TestStatus>({ state: "idle" });
  const [smtpTest, setSmtpTest] = useState<TestStatus>({ state: "idle" });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const currentStepIndex = steps.indexOf(currentStep);
  const updateForm = useCallback(
    <K extends keyof FormState>(key: K, value: FormState[K]) => {
      setForm((prev) => ({ ...prev, [key]: value }));
    },
    [],
  );

  const next = () => {
    if (currentStepIndex < steps.length - 1) {
      setCurrentStep(steps[currentStepIndex + 1]!);
    }
  };
  const back = () => {
    if (currentStepIndex > 0) {
      setCurrentStep(steps[currentStepIndex - 1]!);
    } else {
      onBack();
    }
  };

  const testPop3Connection = async () => {
    setPop3Test({ state: "testing" });
    try {
      const result: string = await invoke("pop3_test_connection", {
        config: {
          host: form.pop3Host.trim(),
          port: form.pop3Port,
          security: mapSecurity(form.pop3Security),
          username: form.username.trim() || form.email.trim(),
          password: form.password,
          accept_invalid_certs: form.acceptInvalidCerts,
          retention_days: form.retentionDays,
        },
      });
      setPop3Test({ state: "success", message: result });
    } catch (err) {
      setPop3Test({
        state: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const testSmtpConnection = async () => {
    setSmtpTest({ state: "testing" });
    try {
      const result: { success: boolean; message: string } = await invoke(
        "smtp_test_connection",
        {
          config: {
            host: form.smtpHost.trim(),
            port: form.smtpPort,
            security: mapSecurity(form.smtpSecurity),
            username: form.username.trim() || form.email.trim(),
            password: form.samePassword ? form.password : form.smtpPassword,
            auth_method: "password",
            accept_invalid_certs: form.acceptInvalidCerts,
          },
        },
      );
      setSmtpTest({
        state: result.success ? "success" : "error",
        message: result.message,
      });
    } catch (err) {
      setSmtpTest({
        state: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const email = form.email.trim();
      const username = form.username.trim() || email;

      if (isEdit && accountId) {
        await updatePop3Account({
          id: accountId,
          email,
          displayName: form.displayName.trim() || null,
          pop3Host: form.pop3Host.trim(),
          pop3Port: form.pop3Port,
          pop3Security: form.pop3Security,
          smtpHost: form.smtpHost.trim(),
          smtpPort: form.smtpPort,
          smtpSecurity: form.smtpSecurity,
          username,
          // blank password in edit mode => keep existing stored password
          password: form.password ? form.password : null,
          retentionDays: form.retentionDays,
          acceptInvalidCerts: form.acceptInvalidCerts,
        });
      } else {
        const newId = crypto.randomUUID();
        await insertPop3Account({
          id: newId,
          email,
          displayName: form.displayName.trim() || null,
          avatarUrl: null,
          pop3Host: form.pop3Host.trim(),
          pop3Port: form.pop3Port,
          pop3Security: form.pop3Security,
          smtpHost: form.smtpHost.trim(),
          smtpPort: form.smtpPort,
          smtpSecurity: form.smtpSecurity,
          username,
          password: form.password,
          retentionDays: form.retentionDays,
          acceptInvalidCerts: form.acceptInvalidCerts,
        });

        addAccount({
          id: newId,
          email,
          displayName: form.displayName.trim() || null,
          avatarUrl: null,
          isActive: true,
        });
      }

      onSuccess();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setSaveError(message);
      setSaving(false);
    }
  };

  const addAccount = useAccountStore((s) => s.addAccount);

  const renderStepIndicator = () => (
    <div className="flex items-center justify-center gap-1 mb-6">
      {steps.map((step, i) => {
        const isActive = i === currentStepIndex;
        const isCompleted = i < currentStepIndex;
        return (
          <div key={step} className="flex items-center gap-1">
            {i > 0 && (
              <div
                className={`w-6 h-px ${isCompleted ? "bg-accent" : "bg-border-primary"}`}
              />
            )}
            <div
              className={`flex items-center gap-1.5 px-2 py-1 rounded-md text-xs font-medium transition-colors ${
                isActive
                  ? "bg-accent/10 text-accent"
                  : isCompleted
                    ? "text-accent"
                    : "text-text-tertiary"
              }`}
            >
              {stepIcons[step]}
              <span className="hidden sm:inline">{stepLabels[step]}</span>
            </div>
          </div>
        );
      })}
    </div>
  );

  const renderBasicStep = () => (
    <div className="space-y-3">
      <div>
        <label htmlFor="pop3-email" className={labelClass}>{t("pop3.email")}</label>
        <input
          id="pop3-email"
          type="email"
          value={form.email}
          onChange={(e) => updateForm("email", e.target.value)}
          placeholder={t("pop3.placeholder.email")}
          className={inputClass}
        />
      </div>
      <div>
        <label htmlFor="pop3-display" className={labelClass}>{t("pop3.displayName")}</label>
        <input
          id="pop3-display"
          type="text"
          value={form.displayName}
          onChange={(e) => updateForm("displayName", e.target.value)}
          placeholder={t("pop3.placeholder.displayName")}
          className={inputClass}
        />
      </div>
      <div>
        <label htmlFor="pop3-username" className={labelClass}>{t("pop3.username")}</label>
        <input
          id="pop3-username"
          type="text"
          value={form.username}
          onChange={(e) => updateForm("username", e.target.value)}
          placeholder={t("pop3.placeholder.email")}
          className={inputClass}
        />
      </div>
      <div>
        <label htmlFor="pop3-password" className={labelClass}>{t("pop3.password")}</label>
        <input
          id="pop3-password"
          type="password"
          value={form.password}
          onChange={(e) => updateForm("password", e.target.value)}
          placeholder={t("pop3.placeholder.password")}
          className={inputClass}
        />
        <p className="text-xs text-text-tertiary mt-1">
          {isEdit
            ? t("pop3.passwordHint.edit")
            : t("pop3.passwordHint.new")}
        </p>
      </div>
    </div>
  );

  const renderPop3Step = () => (
    <div className="space-y-3">
      <div>
        <label htmlFor="pop3-host" className={labelClass}>{t("pop3.pop3Server")}</label>
        <input
          id="pop3-host"
          type="text"
          value={form.pop3Host}
          onChange={(e) => updateForm("pop3Host", e.target.value)}
          placeholder="pop.example.com"
          className={inputClass}
        />
      </div>
      <div className="flex gap-3">
        <div className="flex-1">
          <label htmlFor="pop3-port" className={labelClass}>{t("pop3.port")}</label>
          <input
            id="pop3-port"
            type="number"
            value={form.pop3Port}
            onChange={(e) => updateForm("pop3Port", parseInt(e.target.value) || 995)}
            className={inputClass}
          />
        </div>
        <div className="flex-1">
          <label htmlFor="pop3-security" className={labelClass}>{t("pop3.security")}</label>
          <select
            id="pop3-security"
            value={form.pop3Security}
            onChange={(e) => updateForm("pop3Security", e.target.value as SecurityType)}
            className={selectClass}
          >
            <option value="ssl">SSL/TLS</option>
            <option value="starttls">STARTTLS</option>
            <option value="none">None</option>
          </select>
        </div>
      </div>
      <div>
        <label htmlFor="pop3-retention" className={labelClass}>
          {t("pop3.retention")}
        </label>
        <div className="relative">
          <Clock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-tertiary" />
          <input
            id="pop3-retention"
            type="number"
            value={form.retentionDays}
            onChange={(e) => updateForm("retentionDays", parseInt(e.target.value) || 0)}
            className={`${inputClass} pl-9`}
          />
        </div>
        <p className="text-xs text-text-tertiary mt-1">
          {t("pop3.retentionHint")}
          Set to 0 to keep them forever (POP3 default behavior is to delete on download;
          we keep them locally regardless).
        </p>
      </div>
      <label className="flex items-center gap-2 text-sm text-text-secondary cursor-pointer">
        <input
          type="checkbox"
          checked={form.acceptInvalidCerts}
          onChange={(e) => updateForm("acceptInvalidCerts", e.target.checked)}
          className="rounded border-border-primary"
        />
        {t("pop3.acceptInvalidCerts")}
      </label>
      <button
        onClick={testPop3Connection}
        className="w-full flex items-center justify-center gap-2 px-3 py-2 text-sm rounded-lg border border-border-primary bg-bg-secondary text-text-secondary hover:bg-bg-hover transition-colors"
      >
        {pop3Test.state === "testing" ? (
          <Loader2 className="w-4 h-4 animate-spin" />
        ) : (
          <Server className="w-4 h-4" />
        )}
        {t("pop3.testPop3")}
      </button>
      {pop3Test.state === "success" && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-success/10 border border-success/20 text-sm text-success">
          <CheckCircle2 className="w-4 h-4 flex-shrink-0" />
          {pop3Test.message}
        </div>
      )}
      {pop3Test.state === "error" && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-danger/10 border border-danger/20 text-sm text-danger">
          <XCircle className="w-4 h-4 flex-shrink-0" />
          {pop3Test.message}
        </div>
      )}
    </div>
  );

  const renderSmtpStep = () => (
    <div className="space-y-3">
      <label className="flex items-center gap-2 text-sm text-text-secondary cursor-pointer">
        <input
          type="checkbox"
          checked={form.samePassword}
          onChange={(e) => updateForm("samePassword", e.target.checked)}
          className="rounded border-border-primary"
        />
        {t("pop3.useSamePassword")}
      </label>
      <div>
        <label htmlFor="smtp-host" className={labelClass}>{t("pop3.smtpServer")}</label>
        <input
          id="smtp-host"
          type="text"
          value={form.smtpHost}
          onChange={(e) => updateForm("smtpHost", e.target.value)}
          placeholder="smtp.example.com"
          className={inputClass}
        />
      </div>
      <div className="flex gap-3">
        <div className="flex-1">
          <label htmlFor="smtp-port" className={labelClass}>{t("pop3.port")}</label>
          <input
            id="smtp-port"
            type="number"
            value={form.smtpPort}
            onChange={(e) => updateForm("smtpPort", parseInt(e.target.value) || 465)}
            className={inputClass}
          />
        </div>
        <div className="flex-1">
          <label htmlFor="smtp-security" className={labelClass}>{t("pop3.security")}</label>
          <select
            id="smtp-security"
            value={form.smtpSecurity}
            onChange={(e) => updateForm("smtpSecurity", e.target.value as SecurityType)}
            className={selectClass}
          >
            <option value="ssl">SSL/TLS</option>
            <option value="starttls">STARTTLS</option>
            <option value="none">None</option>
          </select>
        </div>
      </div>
      {!form.samePassword && (
        <div>
          <label htmlFor="smtp-password" className={labelClass}>{t("pop3.smtpPassword")}</label>
          <input
            id="smtp-password"
            type="password"
            value={form.smtpPassword}
            onChange={(e) => updateForm("smtpPassword", e.target.value)}
            placeholder={isEdit ? t("pop3.placeholder.smtpPasswordEdit") : t("pop3.placeholder.smtpPassword")}
            className={inputClass}
          />
        </div>
      )}
      <label className="flex items-center gap-2 text-sm text-text-secondary cursor-pointer">
        <input
          type="checkbox"
          checked={form.acceptInvalidCerts}
          onChange={(e) => updateForm("acceptInvalidCerts", e.target.checked)}
          className="rounded border-border-primary"
        />
        {t("pop3.acceptInvalidCerts")}
      </label>
      <button
        onClick={testSmtpConnection}
        className="w-full flex items-center justify-center gap-2 px-3 py-2 text-sm rounded-lg border border-border-primary bg-bg-secondary text-text-secondary hover:bg-bg-hover transition-colors"
      >
        {smtpTest.state === "testing" ? (
          <Loader2 className="w-4 h-4 animate-spin" />
        ) : (
          <Send className="w-4 h-4" />
        )}
        {t("pop3.testSmtp")}
      </button>
      {smtpTest.state === "success" && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-success/10 border border-success/20 text-sm text-success">
          <CheckCircle2 className="w-4 h-4 flex-shrink-0" />
          {smtpTest.message}
        </div>
      )}
      {smtpTest.state === "error" && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-danger/10 border border-danger/20 text-sm text-danger">
          <XCircle className="w-4 h-4 flex-shrink-0" />
          {smtpTest.message}
        </div>
      )}
    </div>
  );

  const renderTestStep = () => (
    <div className="space-y-4">
      <div className="text-sm text-text-secondary">
        {t("pop3.reviewHint")}
      </div>
      <div className="rounded-lg border border-border-primary bg-bg-secondary p-3 text-sm space-y-1">
        <div className="flex justify-between">
          <span className="text-text-tertiary">{t("pop3.email")}</span>
          <span className="text-text-primary">{form.email}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-text-tertiary">POP3</span>
          <span className="text-text-primary">{form.pop3Host}:{form.pop3Port} ({form.pop3Security})</span>
        </div>
        <div className="flex justify-between">
          <span className="text-text-tertiary">SMTP</span>
          <span className="text-text-primary">{form.smtpHost}:{form.smtpPort} ({form.smtpSecurity})</span>
        </div>
        <div className="flex justify-between">
          <span className="text-text-tertiary">{t("pop3.retention")}</span>
          <span className="text-text-primary">{form.retentionDays === 0 ? t("common.forever") : `${form.retentionDays} ${t("common.days")}`}</span>
        </div>
      </div>
      {saveError && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-danger/10 border border-danger/20 text-sm text-danger">
          <XCircle className="w-4 h-4 flex-shrink-0" />
          {saveError}
        </div>
      )}
    </div>
  );

  return (
    <Modal isOpen={true} onClose={onClose} title={isEdit ? t("pop3.editTitle") : t("pop3.addTitle")} width="w-full max-w-md">
      <div className="p-4">
        <div className="flex items-center gap-2 mb-4">
          <button
            onClick={back}
            className="p-1.5 rounded-lg hover:bg-bg-hover transition-colors text-text-secondary"
          >
            <ArrowLeft className="w-4 h-4" />
          </button>
          <div className="text-sm font-medium text-text-primary">
            {stepLabels[currentStep]}
          </div>
        </div>

        {renderStepIndicator()}

        {currentStep === "basic" && renderBasicStep()}
        {currentStep === "pop3" && renderPop3Step()}
        {currentStep === "smtp" && renderSmtpStep()}
        {currentStep === "test" && renderTestStep()}

        <div className="flex justify-between mt-6">
            <button
              onClick={back}
              className="px-4 py-2 text-sm text-text-secondary hover:text-text-primary transition-colors"
            >
              {t("common.back")}
            </button>
            {currentStep !== "test" ? (
              <button
                onClick={next}
                className="flex items-center gap-2 px-4 py-2 text-sm rounded-lg bg-accent text-white hover:opacity-90 transition-opacity"
              >
                {t("common.next")}
                <ArrowRight className="w-4 h-4" />
              </button>
            ) : (
              <button
                onClick={handleSave}
                disabled={saving}
                className="flex items-center gap-2 px-4 py-2 text-sm rounded-lg bg-accent text-white hover:opacity-90 transition-opacity disabled:opacity-50"
              >
                {saving ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <CheckCircle2 className="w-4 h-4" />
                )}
                {isEdit ? t("common.save") : t("accounts.add")}
              </button>
            )}
        </div>
      </div>
    </Modal>
  );
}
