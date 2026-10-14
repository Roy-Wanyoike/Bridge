import { TableSkeleton } from '@/components/skeletons';

export default function Loading() {
  return <TableSkeleton label="Loading contracts" cols={7} />;
}
