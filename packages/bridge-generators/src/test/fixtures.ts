/**
 * Comprehensive IR fixtures used by the generator tests.
 *
 * These are hand-written IRPackage literals exercising every part of the
 * FROZEN IR contract (packages/bridge-core/src/ir/types.ts):
 * primitives (all 13), list/set/map + nesting (map<string, list<Order>>),
 * enums, unions, aliases, optional fields, every constraint kind, defaults,
 * docs, deprecations, a service with two methods, and two events.
 */

import type { IRPackage, IRTypeDefinition } from '@bridge/core';

/** Fresh comprehensive payments.v1 package (new object every call). */
export function makePaymentsIR(): IRPackage {
  const money: IRTypeDefinition = {
    name: 'Money',
    kind: 'struct',
    docs: 'Money is a decimal amount with a currency code.',
    fields: [
      {
        name: 'amount',
        type: { kind: 'primitive', primitive: 'decimal' },
        optional: false,
        constraints: [{ kind: 'pattern', args: ['^[0-9]+\\.[0-9]{2}$'] }],
        docs: 'Monetary amount as a decimal string.',
      },
      {
        name: 'currency',
        type: { kind: 'primitive', primitive: 'string' },
        optional: false,
        constraints: [{ kind: 'length', args: ['3'] }],
        docs: 'ISO 4217 currency code.',
      },
    ],
  };

  const status: IRTypeDefinition = {
    name: 'Status',
    kind: 'enum',
    docs: 'Status is the lifecycle state of a payment.',
    variants: [
      { name: 'PENDING', docs: 'Authorized, not yet captured.' },
      { name: 'CAPTURED' },
      { name: 'REFUNDED' },
      { name: 'FAILED' },
    ],
  };

  const paymentMethod: IRTypeDefinition = {
    name: 'PaymentMethod',
    kind: 'enum',
    variants: [{ name: 'CARD' }, { name: 'BANK_TRANSFER' }, { name: 'WALLET' }],
  };

  const orderLine: IRTypeDefinition = {
    name: 'OrderLine',
    kind: 'struct',
    docs: 'OrderLine is one line item of an order.',
    fields: [
      { name: 'sku', type: { kind: 'primitive', primitive: 'string' }, optional: false, constraints: [] },
      {
        name: 'quantity',
        type: { kind: 'primitive', primitive: 'int32' },
        optional: false,
        constraints: [
          { kind: 'min', args: ['1'] },
          { kind: 'max', args: ['1000'] },
        ],
        docs: 'Number of units, between 1 and 1000.',
      },
      {
        name: 'unit_price',
        type: { kind: 'named', name: 'Money' },
        optional: false,
        constraints: [],
        docs: 'Price of a single unit.',
      },
      {
        name: 'gift_wrap',
        type: { kind: 'primitive', primitive: 'bool' },
        optional: false,
        constraints: [],
      },
      {
        name: 'weight_kg',
        type: { kind: 'primitive', primitive: 'float64' },
        optional: true,
        constraints: [{ kind: 'min', args: ['0'] }],
      },
    ],
  };

  const order: IRTypeDefinition = {
    name: 'Order',
    kind: 'struct',
    docs: 'Order is a customer order.',
    fields: [
      {
        name: 'order_id',
        type: { kind: 'primitive', primitive: 'uuid' },
        optional: false,
        constraints: [{ kind: 'uuid', args: [] }],
      },
      {
        name: 'version',
        type: { kind: 'primitive', primitive: 'uint32' },
        optional: false,
        constraints: [],
      },
      { name: 'status', type: { kind: 'named', name: 'Status' }, optional: false, constraints: [] },
      {
        name: 'amount',
        type: { kind: 'named', name: 'Money' },
        optional: false,
        constraints: [],
        docs: 'Order total.',
      },
      {
        name: 'lines',
        type: { kind: 'list', element: { kind: 'named', name: 'OrderLine' } },
        optional: false,
        constraints: [],
      },
      {
        name: 'tags',
        type: { kind: 'set', element: { kind: 'primitive', primitive: 'string' } },
        optional: true,
        constraints: [],
        docs: 'Free-form tags; a set on the wire is a JSON array.',
      },
      {
        name: 'metadata',
        type: {
          kind: 'map',
          key: { kind: 'primitive', primitive: 'string' },
          value: { kind: 'primitive', primitive: 'string' },
        },
        optional: true,
        constraints: [],
      },
      { name: 'note', type: { kind: 'primitive', primitive: 'string' }, optional: true, constraints: [] },
      {
        name: 'created_at',
        type: { kind: 'primitive', primitive: 'timestamp' },
        optional: false,
        constraints: [],
        docs: 'RFC 3339 creation timestamp.',
      },
    ],
  };

  const cart: IRTypeDefinition = {
    name: 'Cart',
    kind: 'struct',
    docs: 'Cart groups orders per warehouse; exercises map<string, list<Order>>.',
    fields: [
      {
        name: 'cart_id',
        type: { kind: 'primitive', primitive: 'uuid' },
        optional: false,
        constraints: [],
      },
      {
        name: 'orders',
        type: {
          kind: 'map',
          key: { kind: 'primitive', primitive: 'string' },
          value: { kind: 'list', element: { kind: 'named', name: 'Order' } },
        },
        optional: false,
        constraints: [],
        docs: 'Warehouse id to the orders fulfilled by it.',
      },
      {
        name: 'rating',
        type: { kind: 'primitive', primitive: 'float32' },
        optional: true,
        constraints: [],
      },
      {
        name: 'weight_limit',
        type: { kind: 'primitive', primitive: 'int64' },
        optional: true,
        constraints: [],
        docs: 'int64 exercises the TS precision caveat.',
      },
    ],
  };

  const payment: IRTypeDefinition = {
    name: 'Payment',
    kind: 'struct',
    docs: 'Payment is a captured or pending payment.',
    fields: [
      {
        name: 'payment_id',
        type: { kind: 'primitive', primitive: 'uuid' },
        optional: false,
        constraints: [{ kind: 'uuid', args: [] }],
      },
      {
        name: 'order_id',
        type: { kind: 'named', name: 'OrderId' },
        optional: false,
        constraints: [],
      },
      { name: 'amount', type: { kind: 'named', name: 'Money' }, optional: false, constraints: [] },
      { name: 'method', type: { kind: 'named', name: 'PaymentMethod' }, optional: false, constraints: [] },
      {
        name: 'type',
        type: { kind: 'primitive', primitive: 'string' },
        optional: false,
        constraints: [],
        docs: 'Reserved-word field: escaped in TS/Rust member names, wire name kept.',
      },
      {
        name: 'customer_email',
        type: { kind: 'primitive', primitive: 'string' },
        optional: false,
        constraints: [{ kind: 'email', args: [] }],
      },
      {
        name: 'receipt_url',
        type: { kind: 'primitive', primitive: 'string' },
        optional: true,
        constraints: [{ kind: 'url', args: [] }],
      },
      {
        name: 'raw',
        type: { kind: 'primitive', primitive: 'bytes' },
        optional: true,
        constraints: [],
        docs: 'Opaque processor payload.',
      },
      {
        name: 'json_payload',
        type: { kind: 'primitive', primitive: 'json' },
        optional: true,
        constraints: [],
      },
      {
        name: 'attempts',
        type: { kind: 'primitive', primitive: 'int32' },
        optional: false,
        constraints: [],
        default: '0',
      },
      {
        name: 'priority',
        type: { kind: 'primitive', primitive: 'string' },
        optional: false,
        constraints: [],
        default: 'normal',
      },
      {
        name: 'legacy_id',
        type: { kind: 'primitive', primitive: 'int64' },
        optional: true,
        constraints: [],
        deprecated: 'Use payment_id.',
      },
      {
        name: 'refund',
        type: { kind: 'named', name: 'Money' },
        optional: true,
        constraints: [],
        docs: 'Set when the payment was partially refunded.',
      },
      {
        name: 'resolution',
        type: { kind: 'named', name: 'Resolution' },
        optional: true,
        constraints: [],
      },
      {
        name: 'customer',
        type: { kind: 'named', name: 'Customer' },
        optional: false,
        constraints: [],
      },
      {
        name: 'loyalty_profile',
        type: { kind: 'named', name: 'LoyaltyProfile', package: 'loyalty.v1' },
        optional: true,
        constraints: [],
        docs: 'Cross-package reference; generated as an opaque alias.',
      },
    ],
  };

  const customer: IRTypeDefinition = {
    name: 'Customer',
    kind: 'struct',
    fields: [
      {
        name: 'customer_id',
        type: { kind: 'primitive', primitive: 'uuid' },
        optional: false,
        constraints: [{ kind: 'uuid', args: [] }],
      },
      {
        name: 'email',
        type: { kind: 'primitive', primitive: 'string' },
        optional: false,
        constraints: [{ kind: 'email', args: [] }],
      },
      {
        name: 'website',
        type: { kind: 'primitive', primitive: 'string' },
        optional: true,
        constraints: [{ kind: 'url', args: [] }],
      },
      { name: 'display_name', type: { kind: 'primitive', primitive: 'string' }, optional: false, constraints: [] },
      {
        name: 'sequence',
        type: { kind: 'primitive', primitive: 'uint64' },
        optional: true,
        constraints: [],
      },
    ],
  };

  const resolution: IRTypeDefinition = {
    name: 'Resolution',
    kind: 'union',
    docs: 'Resolution is a tagged union of possible dispute outcomes.',
    variants: [
      { name: 'refund', type: { kind: 'named', name: 'Money' }, optional: false, constraints: [] },
      { name: 'failure', type: { kind: 'primitive', primitive: 'string' }, optional: false, constraints: [] },
      { name: 'retry', type: { kind: 'primitive', primitive: 'bool' }, optional: false, constraints: [] },
    ],
  };

  const orderId: IRTypeDefinition = {
    name: 'OrderId',
    kind: 'alias',
    docs: 'OrderId aliases the uuid primitive.',
    target: { kind: 'primitive', primitive: 'uuid' },
  };

  const address: IRTypeDefinition = {
    name: 'Address',
    kind: 'struct',
    fields: [
      { name: 'line1', type: { kind: 'primitive', primitive: 'string' }, optional: false, constraints: [] },
      { name: 'city', type: { kind: 'primitive', primitive: 'string' }, optional: false, constraints: [] },
      {
        name: 'postal_code',
        type: { kind: 'primitive', primitive: 'string' },
        optional: false,
        constraints: [{ kind: 'pattern', args: ['^[0-9]{5}$'] }],
      },
      {
        name: 'country',
        type: { kind: 'primitive', primitive: 'string' },
        optional: false,
        constraints: [{ kind: 'length', args: ['2'] }],
      },
    ],
  };

  const legacyPayment: IRTypeDefinition = {
    name: 'LegacyPayment',
    kind: 'struct',
    deprecated: 'Use Payment.',
    fields: [
      { name: 'id', type: { kind: 'primitive', primitive: 'int64' }, optional: false, constraints: [] },
    ],
  };

  const createPaymentRequest: IRTypeDefinition = {
    name: 'CreatePaymentRequest',
    kind: 'struct',
    fields: [
      {
        name: 'customer_id',
        type: { kind: 'primitive', primitive: 'uuid' },
        optional: false,
        constraints: [],
      },
      { name: 'amount', type: { kind: 'named', name: 'Money' }, optional: false, constraints: [] },
      { name: 'method', type: { kind: 'named', name: 'PaymentMethod' }, optional: false, constraints: [] },
    ],
  };

  const getPaymentRequest: IRTypeDefinition = {
    name: 'GetPaymentRequest',
    kind: 'struct',
    fields: [
      {
        name: 'payment_id',
        type: { kind: 'primitive', primitive: 'uuid' },
        optional: false,
        constraints: [{ kind: 'uuid', args: [] }],
      },
    ],
  };

  const types: IRTypeDefinition[] = [
    money,
    status,
    paymentMethod,
    orderLine,
    order,
    cart,
    payment,
    customer,
    resolution,
    orderId,
    address,
    legacyPayment,
    createPaymentRequest,
    getPaymentRequest,
  ];

  return {
    name: 'payments.v1',
    imports: ['loyalty.v1'],
    types,
    services: [
      {
        name: 'Payments',
        docs: 'Payments service exposes payment operations.',
        methods: [
          {
            name: 'CreatePayment',
            input: { kind: 'named', name: 'CreatePaymentRequest' },
            output: { kind: 'named', name: 'Payment' },
            docs: 'Creates a payment.',
          },
          {
            name: 'GetPayment',
            input: { kind: 'named', name: 'GetPaymentRequest' },
            output: { kind: 'named', name: 'Payment' },
            docs: 'Fetches a payment by ID.',
          },
        ],
      },
    ],
    events: [
      {
        name: 'PaymentCaptured',
        docs: 'PaymentCaptured is emitted when a payment is captured.',
        fields: [
          { name: 'payment_id', type: { kind: 'primitive', primitive: 'uuid' }, optional: false, constraints: [] },
          { name: 'order_id', type: { kind: 'named', name: 'OrderId' }, optional: false, constraints: [] },
          { name: 'amount', type: { kind: 'named', name: 'Money' }, optional: false, constraints: [] },
          {
            name: 'captured_at',
            type: { kind: 'primitive', primitive: 'timestamp' },
            optional: false,
            constraints: [],
          },
          {
            name: 'sequence',
            type: { kind: 'primitive', primitive: 'uint64' },
            optional: false,
            constraints: [],
          },
        ],
      },
      {
        name: 'PaymentFailed',
        docs: 'PaymentFailed is emitted when a payment fails.',
        fields: [
          { name: 'payment_id', type: { kind: 'primitive', primitive: 'uuid' }, optional: false, constraints: [] },
          { name: 'reason', type: { kind: 'primitive', primitive: 'string' }, optional: false, constraints: [] },
        ],
      },
    ],
    docs: 'Payments API for the Bridge demo store.',
  };
}

/**
 * Minimal package: no services, no events, one struct — used for the
 * `generateServices: false` / `generateEvents: false` option tests.
 */
export function makeMinimalIR(): IRPackage {
  return {
    name: 'tiny.v1',
    imports: [],
    types: [
      {
        name: 'Ping',
        kind: 'struct',
        fields: [
          { name: 'message', type: { kind: 'primitive', primitive: 'string' }, optional: false, constraints: [] },
        ],
      },
    ],
    services: [],
    events: [],
  };
}

/**
 * Adversarial package for issues #44 and #116: every shape that previously
 * produced compile-breaking output in at least one backend.
 *
 * - primitive collections (list<int32>, set<boolean>, list<int64>,
 *   set<int32>) — Java fromDict/serialize used to emit List<int>/Set<int>;
 * - a keyword-named CONSTRAINED field (`type`) — Rust validate.rs used to
 *   reference self.type while types.rs declares r#type;
 * - a union whose variant names collide with Python classmethod/field
 *   names (SELF/KIND/VALUE);
 * - a union variant whose payload is a primitive alias (OrderRef = uuid)
 *   — Go used to emit the invalid composite literal `OrderRef{}`;
 * - value/obj/errors field names — TS validators used to redeclare their
 *   own locals;
 * - a service whose method input and output are CROSS-PACKAGE named refs
 *   (opaque in every backend);
 * - an enum-less package (no enum types at all) — wasm lib.rs used to
 *   declare the missing enums module unconditionally (the Filter enum below
 *   was added later for the #116 keyword-variant coverage, so this package
 *   is no longer strictly enum-less; wasm coverage lives in bridge-ffi);
 * - #116 auto-escape coverage, which must SUCCEED in every backend with
 *   the wire name preserved: a field named `class` (Java member/getter
 *   escape), fields `to_dict`/`validate` (C#/Java/Go generated-method
 *   collisions), a service method named `func` (Go keyword), and an enum
 *   variant named `pass` (Python keyword).
 */
export function makeAdversarialIR(): IRPackage {
  const tags: IRTypeDefinition = {
    name: 'Tags',
    kind: 'struct',
    fields: [
      {
        name: 'nums',
        type: { kind: 'list', element: { kind: 'primitive', primitive: 'int32' } },
        optional: false,
        constraints: [],
      },
      {
        name: 'flags',
        type: { kind: 'set', element: { kind: 'primitive', primitive: 'bool' } },
        optional: false,
        constraints: [],
      },
      {
        name: 'bigs',
        type: { kind: 'list', element: { kind: 'primitive', primitive: 'int64' } },
        optional: false,
        constraints: [],
      },
      {
        name: 'quantities',
        type: { kind: 'set', element: { kind: 'primitive', primitive: 'int32' } },
        optional: false,
        constraints: [],
      },
      {
        name: 'type',
        type: { kind: 'primitive', primitive: 'string' },
        optional: false,
        constraints: [{ kind: 'length', args: ['3'] }],
        docs: 'Keyword-named constrained field: Rust member is r#type.',
      },
    ],
  };

  const channel: IRTypeDefinition = {
    name: 'Channel',
    kind: 'union',
    docs: 'Channel collides with Python classmethod/field names.',
    variants: [
      { name: 'SELF', type: { kind: 'primitive', primitive: 'string' }, optional: false, constraints: [] },
      { name: 'KIND', type: { kind: 'primitive', primitive: 'bool' }, optional: false, constraints: [] },
      { name: 'VALUE', type: { kind: 'primitive', primitive: 'int64' }, optional: false, constraints: [] },
    ],
  };

  const orderRef: IRTypeDefinition = {
    name: 'OrderRef',
    kind: 'alias',
    docs: 'OrderRef aliases the uuid primitive.',
    target: { kind: 'primitive', primitive: 'uuid' },
  };

  const pick: IRTypeDefinition = {
    name: 'Pick',
    kind: 'union',
    docs: 'Pick carries a primitive-alias payload (Go zero-value case).',
    variants: [
      { name: 'ORDER', type: { kind: 'named', name: 'OrderRef' }, optional: false, constraints: [] },
      { name: 'NONE', type: { kind: 'primitive', primitive: 'string' }, optional: false, constraints: [] },
    ],
  };

  const filter: IRTypeDefinition = {
    name: 'Filter',
    kind: 'enum',
    docs: 'Filter carries the #116 Python-keyword variant coverage (pass).',
    variants: [{ name: 'ALL' }, { name: 'pass', docs: 'Keyword-named variant: Python member is pass_.' }],
  };

  const holder: IRTypeDefinition = {
    name: 'Holder',
    kind: 'struct',
    docs: 'Holder fields collide with TS validator locals and generated methods.',
    fields: [
      { name: 'value', type: { kind: 'primitive', primitive: 'string' }, optional: false, constraints: [] },
      { name: 'obj', type: { kind: 'named', name: 'Tags' }, optional: false, constraints: [] },
      {
        name: 'errors',
        type: { kind: 'list', element: { kind: 'primitive', primitive: 'string' } },
        optional: false,
        constraints: [],
      },
      { name: 'pick', type: { kind: 'named', name: 'Pick' }, optional: false, constraints: [] },
      { name: 'channel', type: { kind: 'named', name: 'Channel' }, optional: false, constraints: [] },
      {
        name: 'class',
        type: { kind: 'primitive', primitive: 'string' },
        optional: false,
        constraints: [],
        docs: 'Java keyword: member class_ and getter getClass_ (not Object.getClass).',
      },
      {
        name: 'to_dict',
        type: { kind: 'primitive', primitive: 'string' },
        optional: false,
        constraints: [],
        docs: 'Collides with generated toDict()/to_dict methods before escaping.',
      },
      {
        name: 'validate',
        type: { kind: 'primitive', primitive: 'string' },
        optional: false,
        constraints: [],
        docs: 'Collides with generated Validate()/validate() methods before escaping.',
      },
    ],
  };

  return {
    name: 'edge.v1',
    imports: ['loyalty.v1'],
    types: [tags, channel, orderRef, pick, filter, holder],
    services: [
      {
        name: 'Profiles',
        docs: 'Profiles exercises cross-package method signatures.',
        methods: [
          {
            name: 'Fetch',
            input: { kind: 'named', name: 'LoyaltyProfile', package: 'loyalty.v1' },
            output: { kind: 'named', name: 'LoyaltyProfile', package: 'loyalty.v1' },
            docs: 'Cross-package input AND output (opaque aliases).',
          },
          {
            name: 'func',
            input: { kind: 'named', name: 'LoyaltyProfile', package: 'loyalty.v1' },
            output: { kind: 'named', name: 'LoyaltyProfile', package: 'loyalty.v1' },
            docs: 'Go-keyword method name: Go selector is func_, the route stays /Profiles/func.',
          },
        ],
      },
    ],
    events: [],
    docs: 'Adversarial contract for generator compile-break coverage.',
  };
}
