/**
 * Demo dataset for the BRIDGE dashboard.
 *
 * Seeded with realistic contracts derived from the repository examples
 * (payments, orders, catalog, billing, store, plus risk/compute consumers)
 * so the console is fully browsable with zero backend. Designed to
 * showcase every classification the compatibility engine emits:
 *
 * - payments v2 -> v3  BREAKING (Payment.currency removed)
 * - billing  v1 -> v2  UNKNOWN  (int64 amount -> arbitrary-precision json)
 * - orders   v1 -> v2  WARNING  (int32 -> int64 widening, enum value added)
 * - catalog  v1 -> v2  SAFE     (optional field + new type)
 *
 * All timestamps, hashes and ids are fixed strings: rendering is fully
 * deterministic and safe to prerender.
 */

import type {
  AffectedConsumer,
  AuditEntry,
  Classification,
  ContractSummary,
  ConsumerRef,
  DiffReport,
  GraphData,
  Language,
  OrgInfo,
  OverviewData,
  SchemaSummary,
  VersionDetail,
  VersionMeta,
} from './types';
import { shortHash } from './format';

interface DemoVersion {
  version: string;
  hash: string;
  publishedAt: string;
  publisher: string;
  languages: Language[];
  imports: string[];
  schema: SchemaSummary;
}

interface DemoContract {
  org: string;
  project: string;
  base: string;
  owner: string;
  description: string;
  repository: string;
  versions: DemoVersion[];
}

const DEMO_CONTRACTS: DemoContract[] = [
  {
    org: 'acme',
    project: 'payments',
    base: 'payments',
    owner: 'team-payments',
    description: 'Core payment lifecycle: creation, capture, refunds and status tracking.',
    repository: 'github.com/acme/payments',
    versions: [
      {
        version: 'v1',
        hash: '35b333676c86d2806710453e3acb40ef6f0e99c31d7f60d52099a2aaa259e5f2',
        publishedAt: '2026-06-14T09:24:11Z',
        publisher: 'maya@acme.dev',
        languages: ['typescript', 'go'],
        imports: [],
        schema: {
          types: ['Money', 'Payment', 'CreatePaymentRequest', 'GetPaymentRequest'],
          enums: ['PaymentStatus'],
          services: ['Payments'],
          events: [],
          aliases: [],
        },
      },
      {
        version: 'v2',
        hash: '81160cd5a2397ea4cc21d2ab633b8e1f8d67752f869abe8d8759a0252109aa0e',
        publishedAt: '2026-07-30T14:05:47Z',
        publisher: 'maya@acme.dev',
        languages: ['typescript', 'go', 'rust', 'python'],
        imports: [],
        schema: {
          types: ['Money', 'Payment', 'CreatePaymentRequest', 'GetPaymentRequest'],
          enums: ['PaymentStatus'],
          services: ['Payments'],
          events: [],
          aliases: [],
        },
      },
      {
        version: 'v3',
        hash: 'ff04c6d644fd1df6cc80a4fa19ee1e910810d0d334d649707a275a92e7e21f80',
        publishedAt: '2026-08-21T11:42:30Z',
        publisher: 'jonas@acme.dev',
        languages: ['typescript', 'go', 'rust', 'python'],
        imports: [],
        schema: {
          types: ['Money', 'Payment', 'CreatePaymentRequest', 'GetPaymentRequest'],
          enums: ['PaymentStatus'],
          services: ['Payments'],
          events: [],
          aliases: [],
        },
      },
    ],
  },
  {
    org: 'acme',
    project: 'payments',
    base: 'fraud',
    owner: 'team-risk',
    description: 'Payment fraud screening: checks, verdicts and reviewer hand-off.',
    repository: 'github.com/acme/risk',
    versions: [
      {
        version: 'v1',
        hash: '0455dd8fac8e1bc38dfe847e2907a8168f226a8d359aa36943278b49ed4318b1',
        publishedAt: '2026-06-28T16:10:02Z',
        publisher: 'priya@acme.dev',
        languages: ['typescript', 'go'],
        imports: ['payments.v1'],
        schema: {
          types: ['FraudCheck', 'FraudVerdict', 'ReviewTicket'],
          enums: ['Verdict'],
          services: ['Fraud'],
          events: [],
          aliases: [],
        },
      },
      {
        version: 'v2',
        hash: 'c9386a36b4359c76d0ca2bdbcaf246318009b18ccb7b78797a79fa3d171d70f9',
        publishedAt: '2026-08-05T10:17:38Z',
        publisher: 'priya@acme.dev',
        languages: ['typescript', 'go', 'rust', 'python'],
        imports: ['payments.v1'],
        schema: {
          types: ['FraudCheck', 'FraudVerdict', 'ReviewTicket'],
          enums: ['Verdict'],
          services: ['Fraud'],
          events: [],
          aliases: [],
        },
      },
    ],
  },
  {
    org: 'acme',
    project: 'payments',
    base: 'risk-engine',
    owner: 'team-risk',
    description: 'Assembles payment and fraud signals into automated risk decisions.',
    repository: 'github.com/acme/risk',
    versions: [
      {
        version: 'v1',
        hash: 'eef062e3b2c6b1d187a2594f2f00fd45d5ba0d7117340bc65f0641d381d4a379',
        publishedAt: '2026-07-12T08:55:19Z',
        publisher: 'jonas@acme.dev',
        languages: ['typescript', 'go'],
        imports: ['payments.v1'],
        schema: {
          types: ['RiskSignal', 'RiskDecision'],
          enums: ['RiskBand'],
          services: ['RiskEngine'],
          events: [],
          aliases: [],
        },
      },
      {
        version: 'v2',
        hash: '8a30a2e24442fae3a3b4bafbaebf3212a08d9aad020746ec1bf1615ed3a8c91b',
        publishedAt: '2026-08-28T09:03:44Z',
        publisher: 'ci-bot@acme.dev',
        languages: ['typescript', 'go', 'rust', 'python'],
        imports: ['payments.v1', 'fraud.v2'],
        schema: {
          types: ['RiskSignal', 'RiskDecision'],
          enums: ['RiskBand'],
          services: ['RiskEngine'],
          events: [],
          aliases: [],
        },
      },
    ],
  },
  {
    org: 'acme',
    project: 'commerce',
    base: 'orders',
    owner: 'team-commerce',
    description: 'Order lifecycle: quantities, fulfilment status and adjustments.',
    repository: 'github.com/acme/orders',
    versions: [
      {
        version: 'v1',
        hash: 'd3c650c0a6593187f06a2f6ca6fb76d4d74ddd5c00dd24ca45323b410ac733a6',
        publishedAt: '2026-06-20T13:31:55Z',
        publisher: 'jonas@acme.dev',
        languages: ['typescript', 'go', 'rust'],
        imports: [],
        schema: {
          types: ['Order'],
          enums: ['OrderStatus'],
          services: [],
          events: [],
          aliases: [],
        },
      },
      {
        version: 'v2',
        hash: '866eeb834448060284b3b56b518f896203d1f082f5633e1a66c4efefa2fac5dc',
        publishedAt: '2026-07-22T15:48:06Z',
        publisher: 'maya@acme.dev',
        languages: ['typescript', 'go', 'rust', 'python'],
        imports: [],
        schema: {
          types: ['Order'],
          enums: ['OrderStatus'],
          services: [],
          events: [],
          aliases: [],
        },
      },
      {
        version: 'v3',
        hash: 'a284d1f164b32d0de73dba4865e75d0e558a833d7349a019bee346173e481d6b',
        publishedAt: '2026-08-30T17:26:12Z',
        publisher: 'jonas@acme.dev',
        languages: ['typescript', 'go', 'rust', 'python'],
        imports: [],
        schema: {
          types: ['Order', 'OrderAdjustment'],
          enums: ['OrderStatus'],
          services: [],
          events: [],
          aliases: [],
        },
      },
    ],
  },
  {
    org: 'acme',
    project: 'commerce',
    base: 'catalog',
    owner: 'team-catalog',
    description: 'Product catalog: items, pricing and availability.',
    repository: 'github.com/acme/catalog',
    versions: [
      {
        version: 'v1',
        hash: '01b05afc65c0b330929aaafffcc2ddebe6fec516aa1b11fe51055a4e51fb14a9',
        publishedAt: '2026-06-11T10:02:40Z',
        publisher: 'maya@acme.dev',
        languages: ['typescript', 'go'],
        imports: [],
        schema: {
          types: ['Money', 'Product', 'GetProductRequest', 'ListProductsRequest', 'ProductList'],
          enums: ['Availability'],
          services: ['Catalog'],
          events: [],
          aliases: [],
        },
      },
      {
        version: 'v2',
        hash: '1cb7ca758aa3da10fe5ccb423500ee00ec47ae39567cf3b7d8f2a9c85e813709',
        publishedAt: '2026-07-08T12:44:23Z',
        publisher: 'maya@acme.dev',
        languages: ['typescript', 'go', 'rust', 'python'],
        imports: [],
        schema: {
          types: [
            'Money',
            'Product',
            'ProductBundle',
            'GetProductRequest',
            'ListProductsRequest',
            'ProductList',
          ],
          enums: ['Availability'],
          services: ['Catalog'],
          events: [],
          aliases: ['ProductRef'],
        },
      },
    ],
  },
  {
    org: 'acme',
    project: 'commerce',
    base: 'checkout',
    owner: 'team-commerce',
    description: 'Checkout orchestration across orders, catalog and payment initiation.',
    repository: 'github.com/acme/checkout',
    versions: [
      {
        version: 'v1',
        hash: '886b01c4ca50830b7c45675c53a8331e6aa62e00fed12b5bc2947181a2603355',
        publishedAt: '2026-08-02T09:12:57Z',
        publisher: 'jonas@acme.dev',
        languages: ['typescript', 'go', 'rust', 'python'],
        imports: ['orders.v1', 'catalog.v1'],
        schema: {
          types: ['CheckoutSession', 'PlaceOrderRequest'],
          enums: ['CheckoutState'],
          services: ['Checkout'],
          events: [],
          aliases: [],
        },
      },
    ],
  },
  {
    org: 'acme',
    project: 'commerce',
    base: 'storefront',
    owner: 'team-commerce',
    description: 'Storefront-facing product views, collections and SEO metadata.',
    repository: 'github.com/acme/storefront',
    versions: [
      {
        version: 'v1',
        hash: '22c8b1cf0db6ac0d14cb8f59aaa62328e599664e1db9f056296462ec307aa59f',
        publishedAt: '2026-06-25T14:20:33Z',
        publisher: 'maya@acme.dev',
        languages: ['typescript'],
        imports: ['catalog.v1'],
        schema: {
          types: ['StorefrontProduct', 'StorefrontCollection'],
          enums: [],
          services: ['Storefront'],
          events: [],
          aliases: [],
        },
      },
      {
        version: 'v2',
        hash: '9f7891675d4018a2beeec6ec2c1d7bf87369efbc07afa26cdb734f43429628e2',
        publishedAt: '2026-08-14T16:37:09Z',
        publisher: 'ci-bot@acme.dev',
        languages: ['typescript', 'go'],
        imports: ['catalog.v1'],
        schema: {
          types: ['StorefrontProduct', 'StorefrontCollection'],
          enums: [],
          services: ['Storefront'],
          events: [],
          aliases: [],
        },
      },
    ],
  },
  {
    org: 'acme',
    project: 'commerce',
    base: 'store',
    owner: 'team-commerce',
    description: 'Order events and order RPC over the store domain (CloudEvents envelope).',
    repository: 'github.com/acme/store',
    versions: [
      {
        version: 'v1',
        hash: '47077563b702a9baf38a6b9214cfec4d4ddb31614922947ee379fcf94251b5ce',
        publishedAt: '2026-07-01T11:09:27Z',
        publisher: 'jonas@acme.dev',
        languages: ['typescript', 'go', 'python'],
        imports: [],
        schema: {
          types: ['CreateOrderRequest', 'Order'],
          enums: [],
          services: ['Orders'],
          events: ['OrderPlaced', 'OrderShipped'],
          aliases: [],
        },
      },
      {
        version: 'v2',
        hash: 'a3389561466e10b1631d01c4dab22ce82c58245e8b80db039386444848878c9b',
        publishedAt: '2026-08-24T13:55:51Z',
        publisher: 'maya@acme.dev',
        languages: ['typescript', 'go', 'rust', 'python'],
        imports: [],
        schema: {
          types: ['CreateOrderRequest', 'Order'],
          enums: [],
          services: ['Orders'],
          events: ['OrderPlaced', 'OrderShipped', 'OrderCancelled'],
          aliases: [],
        },
      },
    ],
  },
  {
    org: 'globex',
    project: 'billing',
    base: 'billing',
    owner: 'team-billing',
    description: 'Invoicing: totals, statuses, due dates and payment terms.',
    repository: 'github.com/globex/billing',
    versions: [
      {
        version: 'v1',
        hash: 'e9ea2486a9cf9e02e286bbb61cecb3aeb206c17622bdb844f20f04a5f53812e4',
        publishedAt: '2026-06-17T08:40:14Z',
        publisher: 'elena@globex.dev',
        languages: ['typescript', 'go', 'rust'],
        imports: [],
        schema: {
          types: ['Money', 'Invoice', 'CreateInvoiceRequest'],
          enums: ['InvoiceStatus'],
          services: ['Billing'],
          events: [],
          aliases: [],
        },
      },
      {
        version: 'v2',
        hash: 'a2492a741704732684cfc2e2165634bda46f2a0d5ec6f2644b978867b846d7ff',
        publishedAt: '2026-08-11T15:29:36Z',
        publisher: 'marcus@globex.dev',
        languages: ['typescript', 'go', 'rust', 'python'],
        imports: [],
        schema: {
          types: ['Money', 'Invoice', 'CreateInvoiceRequest'],
          enums: ['InvoiceStatus'],
          services: ['Billing'],
          events: [],
          aliases: [],
        },
      },
    ],
  },
  {
    org: 'globex',
    project: 'billing',
    base: 'ledger',
    owner: 'team-finance',
    description: 'Double-entry ledger postings driven by invoice transitions.',
    repository: 'github.com/globex/ledger',
    versions: [
      {
        version: 'v1',
        hash: '007cd3b254f8f1659d669d92baa0a8ac52e0520a4ad479151fd65e55e6083144',
        publishedAt: '2026-07-19T10:47:48Z',
        publisher: 'elena@globex.dev',
        languages: ['typescript', 'go'],
        imports: ['billing.v1'],
        schema: {
          types: ['Posting', 'LedgerEntry'],
          enums: ['PostingSide'],
          services: ['Ledger'],
          events: [],
          aliases: [],
        },
      },
    ],
  },
  {
    org: 'globex',
    project: 'billing',
    base: 'reporting',
    owner: 'team-data',
    description: 'Cross-domain reporting joins over orders and billing.',
    repository: 'github.com/globex/reporting',
    versions: [
      {
        version: 'v1',
        hash: 'abddaeb2a511b5319a072035973b53ae1df48138da7d02c7109994f20186ab21',
        publishedAt: '2026-08-19T09:58:05Z',
        publisher: 'marcus@globex.dev',
        languages: ['typescript', 'python'],
        imports: ['orders.v1', 'billing.v1'],
        schema: {
          types: ['OrderBillingReport', 'ReportFilter'],
          enums: [],
          services: ['Reporting'],
          events: [],
          aliases: [],
        },
      },
    ],
  },
];

/* ------------------------------------------------------------------ */
/* Compatibility reports (classified per the @bridge/compat rules)     */
/* ------------------------------------------------------------------ */

interface DemoDiff {
  base: string;
  from: string;
  to: string;
  changes: DiffReport['changes'];
}

function countSummary(changes: DiffReport['changes']): DiffReport['summary'] {
  const summary = { safe: 0, warning: 0, breaking: 0, unknown: 0 };
  for (const c of changes) {
    if (c.classification === 'SAFE') summary.safe += 1;
    else if (c.classification === 'WARNING') summary.warning += 1;
    else if (c.classification === 'BREAKING') summary.breaking += 1;
    else summary.unknown += 1;
  }
  return summary;
}

function verdictOf(changes: DiffReport['changes']): Classification {
  if (changes.some((c) => c.classification === 'BREAKING')) return 'BREAKING';
  if (changes.some((c) => c.classification === 'UNKNOWN')) return 'UNKNOWN';
  if (changes.some((c) => c.classification === 'WARNING')) return 'WARNING';
  return 'SAFE';
}

const DEMO_DIFFS: DemoDiff[] = [
  {
    base: 'payments',
    from: 'v1',
    to: 'v2',
    changes: [
      {
        path: 'PaymentStatus.REFUNDED',
        kind: 'enum-value-added',
        classification: 'WARNING',
        message: "Enum value 'REFUNDED' added to 'PaymentStatus'. Exhaustive switches in strict consumers will fail to compile and default arms will start receiving a new payload.",
        new: 'REFUNDED',
      },
      {
        path: 'Payment.reference',
        kind: 'field-added',
        classification: 'SAFE',
        message: "Field 'reference' added as optional. Existing decoders ignore unknown keys; producers may omit it.",
        new: 'string? @length(1)',
      },
    ],
  },
  {
    base: 'payments',
    from: 'v2',
    to: 'v3',
    changes: [
      {
        path: 'Payment.currency',
        kind: 'field-removed',
        classification: 'BREAKING',
        message: "Field 'currency' removed. Every consumer decoding Payment loses a required key; generated decoders reject the new payload or read undefined.",
        old: 'string @length(3)',
      },
    ],
  },
  {
    base: 'payments',
    from: 'v1',
    to: 'v3',
    changes: [
      {
        path: 'Payment.currency',
        kind: 'field-removed',
        classification: 'BREAKING',
        message: "Field 'currency' removed. Every consumer decoding Payment loses a required key; generated decoders reject the new payload or read undefined.",
        old: 'string @length(3)',
      },
      {
        path: 'PaymentStatus.REFUNDED',
        kind: 'enum-value-added',
        classification: 'WARNING',
        message: "Enum value 'REFUNDED' added to 'PaymentStatus'. Exhaustive switches in strict consumers will fail to compile and default arms will start receiving a new payload.",
        new: 'REFUNDED',
      },
      {
        path: 'Payment.reference',
        kind: 'field-added',
        classification: 'SAFE',
        message: "Field 'reference' added as optional. Existing decoders ignore unknown keys; producers may omit it.",
        new: 'string? @length(1)',
      },
    ],
  },
  {
    base: 'orders',
    from: 'v1',
    to: 'v2',
    changes: [
      {
        path: 'Order.quantity',
        kind: 'field-type-changed',
        classification: 'WARNING',
        message: "Type of field 'quantity' widened. Widening is tolerated by every generated language; TypeScript consumers hit the documented 2^53 precision caveat.",
        old: 'int32',
        new: 'int64',
      },
      {
        path: 'Order.note',
        kind: 'field-added',
        classification: 'SAFE',
        message: "Field 'note' added as optional. Existing decoders ignore unknown keys; producers may omit it.",
        new: 'string?',
      },
    ],
  },
  {
    base: 'orders',
    from: 'v2',
    to: 'v3',
    changes: [
      {
        path: 'OrderStatus.CANCELLED',
        kind: 'enum-value-added',
        classification: 'WARNING',
        message: "Enum value 'CANCELLED' added to 'OrderStatus'. Exhaustive switches in strict consumers will fail to compile and default arms will start receiving a new payload.",
        new: 'CANCELLED',
      },
      {
        path: 'Order.discount',
        kind: 'field-added',
        classification: 'SAFE',
        message: "Field 'discount' added as optional. Existing decoders ignore unknown keys; producers may omit it.",
        new: 'Money?',
      },
    ],
  },
  {
    base: 'orders',
    from: 'v1',
    to: 'v3',
    changes: [
      {
        path: 'Order.quantity',
        kind: 'field-type-changed',
        classification: 'WARNING',
        message: "Type of field 'quantity' widened. Widening is tolerated by every generated language; TypeScript consumers hit the documented 2^53 precision caveat.",
        old: 'int32',
        new: 'int64',
      },
      {
        path: 'OrderStatus.CANCELLED',
        kind: 'enum-value-added',
        classification: 'WARNING',
        message: "Enum value 'CANCELLED' added to 'OrderStatus'. Exhaustive switches in strict consumers will fail to compile and default arms will start receiving a new payload.",
        new: 'CANCELLED',
      },
      {
        path: 'Order.note',
        kind: 'field-added',
        classification: 'SAFE',
        message: "Field 'note' added as optional. Existing decoders ignore unknown keys; producers may omit it.",
        new: 'string?',
      },
      {
        path: 'Order.discount',
        kind: 'field-added',
        classification: 'SAFE',
        message: "Field 'discount' added as optional. Existing decoders ignore unknown keys; producers may omit it.",
        new: 'Money?',
      },
    ],
  },
  {
    base: 'catalog',
    from: 'v1',
    to: 'v2',
    changes: [
      {
        path: 'Product.weight_grams',
        kind: 'field-added',
        classification: 'SAFE',
        message: "Field 'weight_grams' added as optional. Existing decoders ignore unknown keys; producers may omit it.",
        new: 'int32?',
      },
      {
        path: 'catalog.v1.ProductBundle',
        kind: 'type-added',
        classification: 'SAFE',
        message: "Type 'ProductBundle' added. Additive types do not affect existing consumers.",
      },
    ],
  },
  {
    base: 'storefront',
    from: 'v1',
    to: 'v2',
    changes: [
      {
        path: 'StorefrontProduct.seo_slug',
        kind: 'field-added',
        classification: 'SAFE',
        message: "Field 'seo_slug' added as optional. Existing decoders ignore unknown keys; producers may omit it.",
        new: 'string?',
      },
    ],
  },
  {
    base: 'store',
    from: 'v1',
    to: 'v2',
    changes: [
      {
        path: 'OrderShipped.carrier',
        kind: 'event-field-changed',
        classification: 'WARNING',
        message: "Field 'carrier' in event 'OrderShipped' gained a length constraint. Producers now reject payloads outside the constraint; loose subscribers still decode, strict validators do not.",
        old: 'string',
        new: 'string @length(1, 64)',
      },
      {
        path: 'OrderCancelled',
        kind: 'event-added',
        classification: 'SAFE',
        message: "Event 'OrderCancelled' added. New event types are additive; existing subscribers are unaffected.",
      },
    ],
  },
  {
    base: 'billing',
    from: 'v1',
    to: 'v2',
    changes: [
      {
        path: 'Invoice.total.amount',
        kind: 'field-type-changed',
        classification: 'UNKNOWN',
        message: "Amount switched to arbitrary-precision decimal (json primitive). The engine cannot prove generated-language widening safe or unsafe; treat as undecidable and review manually.",
        old: 'int64',
        new: 'json',
      },
      {
        path: 'Invoice.due_at',
        kind: 'field-deprecated',
        classification: 'WARNING',
        message: "Field 'due_at' deprecated in favor of 'terms_days'. Wire behavior is unchanged; plan removal in a future major version.",
      },
      {
        path: 'Invoice.memo',
        kind: 'field-added',
        classification: 'SAFE',
        message: "Field 'memo' added as optional. Existing decoders ignore unknown keys; producers may omit it.",
        new: 'string?',
      },
    ],
  },
];

/* ------------------------------------------------------------------ */
/* Derived indexes                                                     */
/* ------------------------------------------------------------------ */

const contractsByKey = new Map<string, DemoContract>();
for (const c of DEMO_CONTRACTS) {
  contractsByKey.set(`${c.org}/${c.project}/${c.base}`, c);
}

function versionAt(c: DemoContract, version: string): DemoVersion | undefined {
  return c.versions.find((v) => v.version === version);
}

function latestVersion(c: DemoContract): DemoVersion {
  return c.versions[c.versions.length - 1];
}

/** Direct dependents keyed by `${org}/${project}/${base}` of the provider. */
const dependentsByProvider = new Map<string, { consumer: DemoContract; version: string }[]>();
for (const c of DEMO_CONTRACTS) {
  for (const v of c.versions) {
    for (const imp of v.imports) {
      const base = imp.replace(/\.v\d+$/, '');
      for (const provider of DEMO_CONTRACTS) {
        if (provider.base === base) {
          const key = `${provider.org}/${provider.project}/${provider.base}`;
          const list = dependentsByProvider.get(key) ?? [];
          if (!list.some((x) => x.consumer.base === c.base)) {
            list.push({ consumer: c, version: v.version });
          }
          dependentsByProvider.set(key, list);
        }
      }
    }
  }
}

/** Transitive dependents via BFS over the dependents graph (contract level). */
function transitiveDependents(provider: DemoContract): { contract: DemoContract; depth: number }[] {
  const results = new Map<string, { contract: DemoContract; depth: number }>();
  let frontier: DemoContract[] = [provider];
  let depth = 0;
  const visited = new Set<string>([provider.base]);
  while (frontier.length > 0) {
    depth += 1;
    const next: DemoContract[] = [];
    for (const f of frontier) {
      const key = `${f.org}/${f.project}/${f.base}`;
      for (const { consumer } of dependentsByProvider.get(key) ?? []) {
        if (visited.has(consumer.base)) continue;
        visited.add(consumer.base);
        results.set(consumer.base, { contract: consumer, depth });
        next.push(consumer);
      }
    }
    frontier = next;
  }
  return [...results.values()].sort((a, b) => (a.contract.base < b.contract.base ? -1 : 1));
}

function adjacentDiffFor(c: DemoContract): { from: string; to: string; verdict: Classification } | undefined {
  if (c.versions.length < 2) return undefined;
  const to = latestVersion(c).version;
  const from = c.versions[c.versions.length - 2].version;
  const diff = DEMO_DIFFS.find((d) => d.base === c.base && d.from === from && d.to === to);
  return { from, to, verdict: diff ? verdictOf(diff.changes) : 'SAFE' };
}

/* ------------------------------------------------------------------ */
/* Audit log                                                           */
/* ------------------------------------------------------------------ */

function buildAuditEntries(): AuditEntry[] {
  const entries: AuditEntry[] = [];
  let n = 0;
  const nextId = () => `evt-${String(++n).padStart(4, '0')}`;

  for (const c of DEMO_CONTRACTS) {
    for (const v of c.versions) {
      entries.push({
        id: nextId(),
        at: v.publishedAt,
        actor: v.publisher,
        action: 'publish',
        org: c.org,
        project: c.project,
        contract: c.base,
        version: v.version,
        detail: `published ${c.base}.${v.version} (sha256:${shortHash(v.hash)}) via bridge-cli/0.9.2`,
      });
    }
  }

  const checks: Array<[string, string, string, string, string, Classification]> = [
    ['acme', 'payments', 'payments', 'v1', 'v2', 'WARNING'],
    ['acme', 'payments', 'payments', 'v2', 'v3', 'BREAKING'],
    ['acme', 'commerce', 'orders', 'v2', 'v3', 'WARNING'],
    ['acme', 'commerce', 'catalog', 'v1', 'v2', 'SAFE'],
    ['globex', 'billing', 'billing', 'v1', 'v2', 'UNKNOWN'],
  ];
  for (const [org, project, base, from, to, verdict] of checks) {
    const c = DEMO_CONTRACTS.find((x) => x.base === base)!;
    entries.push({
      id: nextId(),
      at: versionAt(c, to)!.publishedAt,
      actor: 'ci-bot@acme.dev',
      action: 'compat-check',
      org,
      project,
      contract: base,
      version: to,
      detail: `diff ${base}.${from} -> ${base}.${to} on pull request; gate: strict`,
      verdict,
    });
  }

  // Pull rows carry their real org/project/contract scope — the audit page
  // deep-links to `/contracts/${org}/${project}/${contract}`, so a wrong
  // project here is a broken link (they used to be mis-derived from the
  // detail string and 404'd).
  const pulls: Array<{
    at: string;
    actor: string;
    org: string;
    project: string;
    contract: string;
    version: string;
    detail: string;
  }> = [
    {
      at: '2026-08-29T06:41:00Z',
      actor: 'gen-worker@acme.dev',
      org: 'acme',
      project: 'commerce',
      contract: 'catalog',
      version: 'v2',
      detail: 'catalog.v2 for generation (typescript, go)',
    },
    {
      at: '2026-08-28T09:04:10Z',
      actor: 'gen-worker@acme.dev',
      org: 'acme',
      project: 'payments',
      contract: 'risk-engine',
      version: 'v2',
      detail: 'risk-engine.v2 for generation (typescript, go, rust, python)',
    },
    {
      at: '2026-08-26T22:12:41Z',
      actor: 'maya@acme.dev',
      org: 'acme',
      project: 'commerce',
      contract: 'store',
      version: 'v2',
      detail: 'store.v2 for local validation',
    },
    {
      at: '2026-08-25T08:15:27Z',
      actor: 'gen-worker@globex.dev',
      org: 'globex',
      project: 'billing',
      contract: 'billing',
      version: 'v2',
      detail: 'billing.v2 for generation (typescript, go, rust, python)',
    },
    {
      at: '2026-08-22T10:02:55Z',
      actor: 'jonas@acme.dev',
      org: 'acme',
      project: 'payments',
      contract: 'payments',
      version: 'v3',
      detail: 'payments.v3 for local validation',
    },
    {
      at: '2026-08-20T07:33:19Z',
      actor: 'gen-worker@globex.dev',
      org: 'globex',
      project: 'billing',
      contract: 'reporting',
      version: 'v1',
      detail: 'reporting.v1 for generation (typescript, python)',
    },
  ];
  for (const p of pulls) {
    entries.push({
      id: nextId(),
      at: p.at,
      actor: p.actor,
      action: 'pull',
      org: p.org,
      project: p.project,
      contract: p.contract,
      version: p.version,
      detail: `pulled ${p.detail}`,
    });
  }

  return entries.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.id < b.id ? 1 : -1));
}

const AUDIT_ENTRIES = buildAuditEntries();

/* ------------------------------------------------------------------ */
/* Demo client implementation helpers                                  */
/* ------------------------------------------------------------------ */

export function demoListOrgs(): OrgInfo[] {
  const orgs = new Map<string, OrgInfo>();
  for (const c of DEMO_CONTRACTS) {
    const org = orgs.get(c.org) ?? { org: c.org, projects: [] };
    if (!org.projects.includes(c.project)) org.projects.push(c.project);
    orgs.set(c.org, org);
  }
  return [...orgs.values()].sort((a, b) => (a.org < b.org ? -1 : 1));
}

export function demoContractSummary(c: DemoContract): ContractSummary {
  const latest = latestVersion(c);
  const first = c.versions[0];
  const languages = [...new Set(c.versions.flatMap((v) => v.languages))] as Language[];
  const dependents = dependentsByProvider.get(`${c.org}/${c.project}/${c.base}`) ?? [];
  const adj = adjacentDiffFor(c);
  return {
    org: c.org,
    project: c.project,
    base: c.base,
    packageName: `${c.base}.${latest.version}`,
    latestVersion: latest.version,
    latestHash: latest.hash,
    latestShortHash: shortHash(latest.hash),
    owner: c.owner,
    description: c.description,
    repository: c.repository,
    versionCount: c.versions.length,
    firstPublishedAt: first.publishedAt,
    updatedAt: latest.publishedAt,
    consumers: new Set(dependents.map((d) => d.consumer.base)).size,
    languages,
    latestVerdict: adj?.verdict,
  };
}

export function demoListContracts(org?: string, project?: string): ContractSummary[] {
  const out: ContractSummary[] = [];
  for (const c of DEMO_CONTRACTS) {
    if (org && c.org !== org) continue;
    if (project && c.project !== project) continue;
    out.push(demoContractSummary(c));
  }
  return out.sort((a, b) => (a.base < b.base ? -1 : 1));
}

export function demoGetContract(org: string, project: string, base: string): ContractSummary | null {
  const c = contractsByKey.get(`${org}/${project}/${base}`);
  return c ? demoContractSummary(c) : null;
}

export function demoListVersions(org: string, project: string, base: string): VersionMeta[] {
  const c = contractsByKey.get(`${org}/${project}/${base}`);
  if (!c) return [];
  return c.versions.map((v) => ({
    packageName: `${c.base}.${v.version}`,
    base: c.base,
    version: v.version,
    hash: v.hash,
    shortHash: shortHash(v.hash),
    imports: v.imports,
    publishedAt: v.publishedAt,
    publisher: v.publisher,
    owner: c.owner,
    repository: c.repository,
    languages: v.languages,
  }));
}

export function demoGetVersion(
  org: string,
  project: string,
  base: string,
  version: string,
): VersionDetail | null {
  const c = contractsByKey.get(`${org}/${project}/${base}`);
  if (!c) return null;
  const v = versionAt(c, version);
  if (!v) return null;
  return {
    packageName: `${c.base}.${v.version}`,
    base: c.base,
    version: v.version,
    hash: v.hash,
    shortHash: shortHash(v.hash),
    imports: v.imports,
    publishedAt: v.publishedAt,
    publisher: v.publisher,
    owner: c.owner,
    repository: c.repository,
    languages: v.languages,
    schema: v.schema,
  };
}

export function demoListConsumers(
  org: string,
  project: string,
  base: string,
  version: string,
): ConsumerRef[] {
  const c = contractsByKey.get(`${org}/${project}/${base}`);
  if (!c) return [];
  // Severity comes from the adjacent diff that produced the *requested*
  // version (falling back to the latest adjacent diff), not always the
  // latest one — the version parameter is honored.
  const requestedIdx = c.versions.findIndex((v) => v.version === version);
  const effectiveIdx = requestedIdx >= 1 ? requestedIdx : c.versions.length - 1;
  const diff = effectiveIdx >= 1
    ? DEMO_DIFFS.find(
        (d) => d.base === base && d.from === c.versions[effectiveIdx - 1].version && d.to === c.versions[effectiveIdx].version,
      )
    : undefined;
  const verdict = diff ? verdictOf(diff.changes) : 'SAFE';

  return transitiveDependents(c).map(({ contract, depth }) => {
    const latest = latestVersion(contract);
    const direct = depth === 1;
    return {
      packageName: `${contract.base}.${latest.version}`,
      base: contract.base,
      org: contract.org,
      project: contract.project,
      version: latest.version,
      owner: contract.owner,
      depth,
      // Honest severity: SAFE verdicts never fabricate reach. For non-SAFE
      // verdicts, direct consumers report the real verdict; deeper consumers
      // report WARNING (documented simplification — per-consumer type-reach
      // analysis lives in the registry's impact engine).
      severity:
        verdict === 'SAFE'
          ? ('SAFE' as Classification)
          : direct
            ? verdict
            : ('WARNING' as Classification),
    };
  });
}

export function demoGetDiff(
  org: string,
  project: string,
  base: string,
  from: string,
  to: string,
): DiffReport | null {
  const c = contractsByKey.get(`${org}/${project}/${base}`);
  if (!c) return null;
  const stored = DEMO_DIFFS.find((d) => d.base === base && d.from === from && d.to === to);
  const changes = stored ? stored.changes : [];
  const packageName = `${c.base}.${to}`;

  // Consumer impact: transitive dependents; severity propagates worst-case.
  const dependents = transitiveDependents(c);
  const verdict = verdictOf(changes);
  const affected: AffectedConsumer[] = dependents.map(({ contract, depth }) => {
    const latest = latestVersion(contract);
    const severity: Classification =
      changes.length === 0
        ? 'SAFE'
        : depth === 1
          ? verdict
          : verdict === 'BREAKING'
            ? 'BREAKING'
            : verdict === 'UNKNOWN'
              ? 'WARNING'
              : verdict === 'WARNING'
                ? 'WARNING'
                : 'SAFE';
    const viaTypes =
      changes.length === 0 || depth > 1
        ? []
        : [...new Set(changes.map((ch) => ch.path.split('.')[0]))];
    return {
      packageName: `${contract.base}.${latest.version}`,
      version: latest.version,
      org: contract.org,
      project: contract.project,
      depth,
      severity,
      reason: depth === 1 ? 'direct-type' : 'through',
      viaTypes,
      owner: contract.owner,
    };
  });

  return {
    org,
    project,
    contract: base,
    packageName,
    from,
    to,
    verdict,
    summary: countSummary(changes),
    changes,
    impact: {
      dependents: dependents.length,
      affected: affected.filter((a) => a.severity !== 'SAFE').length,
      breakingAffected: affected.filter((a) => a.severity === 'BREAKING').length,
      consumers: affected,
    },
  };
}

/**
 * Demo dependency graph. Node ids are the fully-qualified storage key
 * `org/project/base` — duplicate bases across orgs must not collide —
 * while `base` keeps the human label for display and navigation.
 */
export function demoGetGraph(org?: string): GraphData {
  const scoped = DEMO_CONTRACTS.filter((c) => !org || c.org === org);
  const keyOf = (c: DemoContract) => `${c.org}/${c.project}/${c.base}`;
  const nodes = scoped.map((c) => {
    const latest = latestVersion(c);
    const adj = adjacentDiffFor(c);
    return {
      id: keyOf(c),
      org: c.org,
      project: c.project,
      base: c.base,
      version: latest.version,
      consumers: new Set(
        (dependentsByProvider.get(`${c.org}/${c.project}/${c.base}`) ?? []).map((d) => d.consumer.base),
      ).size,
      verdict: adj?.verdict,
    };
  });
  const edges: GraphEdgeLocal[] = [];
  for (const c of scoped) {
    const latest = latestVersion(c);
    for (const imp of latest.imports) {
      const targetBase = imp.replace(/\.v\d+$/, '');
      // Imports name a bare base; resolve it to the provider contract's
      // fully-qualified key so cross-org duplicates can never be confused.
      const provider = scoped.find((p) => p.base === targetBase);
      if (provider && provider.base !== c.base) {
        edges.push({ from: keyOf(c), to: keyOf(provider) });
      }
    }
  }
  return { nodes, edges };
}
type GraphEdgeLocal = { from: string; to: string };

export function demoListAudit(filters?: {
  action?: string;
  actor?: string;
  contract?: string;
  org?: string;
}): AuditEntry[] {
  return AUDIT_ENTRIES.filter((e) => {
    if (filters?.action && e.action !== filters.action) return false;
    if (filters?.actor && e.actor !== filters.actor) return false;
    if (filters?.org && e.org !== filters.org) return false;
    if (filters?.contract) {
      const q = filters.contract.toLowerCase();
      if (!e.contract.toLowerCase().includes(q)) return false;
    }
    return true;
  });
}

export function demoGetOverview(): OverviewData {
  const all = demoListContracts();
  const versions = DEMO_CONTRACTS.reduce((n, c) => n + c.versions.length, 0);
  const projects = new Set(DEMO_CONTRACTS.map((c) => `${c.org}/${c.project}`));

  const recentPublishes = DEMO_CONTRACTS.flatMap((c) =>
    c.versions.map((v) => ({
      packageName: `${c.base}.${v.version}`,
      base: c.base,
      version: v.version,
      hash: v.hash,
      shortHash: shortHash(v.hash),
      imports: v.imports,
      publishedAt: v.publishedAt,
      publisher: v.publisher,
      owner: c.owner,
      repository: c.repository,
      languages: v.languages,
      org: c.org,
      project: c.project,
    })),
  )
    .sort((a, b) => (a.publishedAt < b.publishedAt ? 1 : -1))
    .slice(0, 8);

  const recentBreaking = DEMO_DIFFS.map((d) => {
    const c = DEMO_CONTRACTS.find((x) => x.base === d.base)!;
    return demoGetDiff(c.org, c.project, d.base, d.from, d.to)!;
  })
    .filter((r) => r.verdict === 'BREAKING' || r.verdict === 'UNKNOWN' || r.summary.warning > 0)
    .sort((a, b) => {
      const at = versionAt(contractsByKey.get(`${a.org}/${a.project}/${a.contract}`)!, a.to)!.publishedAt;
      const bt = versionAt(contractsByKey.get(`${b.org}/${b.project}/${b.contract}`)!, b.to)!.publishedAt;
      return at < bt ? 1 : -1;
    })
    .slice(0, 5);

  return {
    contracts: all.length,
    versions,
    orgs: demoListOrgs().length,
    projects: projects.size,
    consumerLinks: DEMO_CONTRACTS.flatMap((c) => latestVersion(c).imports).filter((imp) =>
      DEMO_CONTRACTS.some((c2) => c2.base === imp.replace(/\.v\d+$/, '')),
    ).length,
    latestVerdicts: all
      .filter((s) => s.latestVerdict)
      .map((s) => ({ base: s.base, org: s.org, project: s.project, verdict: s.latestVerdict! })),
    recentPublishes,
    recentBreaking,
    lastPublishAt: recentPublishes[0]?.publishedAt,
  };
}

/**
 * Publisher roll-up per contract (for the producers tab). When `version` is
 * given, only versions up to and including it are rolled up.
 */
export function demoPublishers(org: string, project: string, base: string, version?: string) {
  const c = contractsByKey.get(`${org}/${project}/${base}`);
  if (!c) return [];
  const requestedIdx = version ? c.versions.findIndex((v) => v.version === version) : -1;
  const included = requestedIdx >= 0 ? c.versions.slice(0, requestedIdx + 1) : c.versions;
  const byPublisher = new Map<string, { versions: string[]; lastAt: string }>();
  for (const v of included) {
    const entry = byPublisher.get(v.publisher) ?? { versions: [], lastAt: v.publishedAt };
    entry.versions.push(v.version);
    if (v.publishedAt > entry.lastAt) entry.lastAt = v.publishedAt;
    byPublisher.set(v.publisher, entry);
  }
  return [...byPublisher.entries()].sort((a, b) => b[1].lastAt.localeCompare(a[1].lastAt));
}

/**
 * Production builds default to LIVE mode: fabricated data must never reach
 * real users just because an env var was forgotten. `next dev` overrides the
 * unset case to demo (see `isDemoMode`), so the zero-setup clone-and-browse
 * experience is unchanged for developers.
 */
export const DEMO_MODE_DEFAULT = false;
