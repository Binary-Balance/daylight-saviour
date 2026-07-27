import HomeTimeZoneScreen from '../src/features/home-time-zone/home-time-zone-screen';
import { productionHomeTimeZoneAdapters } from '../src/features/home-time-zone/home-time-zone-production-adapters';
import { useProductionChangeReminderTap } from '../src/features/change-reminders/change-reminder-notifications';

export default function Index() {
  const notification = useProductionChangeReminderTap();
  return (
    <HomeTimeZoneScreen
      adapters={productionHomeTimeZoneAdapters}
      notificationTap={notification.tap}
    />
  );
}
