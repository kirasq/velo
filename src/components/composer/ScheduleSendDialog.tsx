import { DateTimePickerDialog } from "@/components/ui/DateTimePickerDialog";
import { t } from "@/i18n";

interface ScheduleSendDialogProps {
  onSchedule: (timestamp: number) => void;
  onClose: () => void;
}

function getSchedulePresets(): { label: string; detail: string; timestamp: number }[] {
  const now = new Date();
  const today = new Date(now);

  // Tomorrow morning 9am
  const tomorrowMorning = new Date(today);
  tomorrowMorning.setDate(tomorrowMorning.getDate() + 1);
  tomorrowMorning.setHours(9, 0, 0, 0);

  // Tomorrow afternoon 1pm
  const tomorrowAfternoon = new Date(today);
  tomorrowAfternoon.setDate(tomorrowAfternoon.getDate() + 1);
  tomorrowAfternoon.setHours(13, 0, 0, 0);

  // Monday morning 9am
  const monday = new Date(today);
  const dayOfWeek = monday.getDay();
  const daysUntilMonday = (1 - dayOfWeek + 7) % 7 || 7;
  monday.setDate(monday.getDate() + daysUntilMonday);
  monday.setHours(9, 0, 0, 0);

  return [
    {
      label: t("composer.schedule.tomorrowMorning"),
      detail: tomorrowMorning.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }) + " 9:00 AM",
      timestamp: Math.floor(tomorrowMorning.getTime() / 1000),
    },
    {
      label: t("composer.schedule.tomorrowAfternoon"),
      detail: tomorrowAfternoon.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }) + " 1:00 PM",
      timestamp: Math.floor(tomorrowAfternoon.getTime() / 1000),
    },
    {
      label: t("composer.schedule.mondayMorning"),
      detail: monday.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }) + " 9:00 AM",
      timestamp: Math.floor(monday.getTime() / 1000),
    },
  ];
}

export function ScheduleSendDialog({ onSchedule, onClose }: ScheduleSendDialogProps) {
  const presets = getSchedulePresets();

  return (
    <DateTimePickerDialog
      isOpen={true}
      onClose={onClose}
      title={t("composer.schedule.title")}
      presets={presets}
      onSelect={onSchedule}
      submitLabel={t("composer.schedule.submit")}
      zIndex="z-[60]"
    />
  );
}
