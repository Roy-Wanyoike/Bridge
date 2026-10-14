import { TableSkeleton } from '@/components/skeletons';

export default function Loading() {
  return <TableSkeleton label="Loading audit log" cols={6} />;
}
