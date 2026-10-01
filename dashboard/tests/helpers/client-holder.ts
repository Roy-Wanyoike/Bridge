import type { RegistryClient } from '@/lib/types';

/**
 * Indirection used by the per-file `vi.mock('@/lib/registry-client')`
 * factories: page tests install a {@link RegistryClient} here to drive
 * empty/single-version scenarios; when nothing is installed the mock falls
 * back to the real demo provider (the default in test env), so the seeded
 * multi-version scenarios exercise the unmocked client.
 */
export const holder: { current: RegistryClient | null } = { current: null };
