import HomeTimeZoneScreen from '../src/features/home-time-zone/home-time-zone-screen';
import { productionHomeTimeZoneAdapters } from '../src/features/home-time-zone/home-time-zone-production-adapters';

export default function Index() {
  return <HomeTimeZoneScreen adapters={productionHomeTimeZoneAdapters} />;
}
