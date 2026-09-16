'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import type { Classification, GraphData } from '@/lib/types';
import { cn } from '@/lib/utils';

const WIDTH = 940;
const HEIGHT_MIN = 420;
/** Vertical room per node in the densest layer (circle + two label lines). */
const LAYER_ROOM = 92;
const MARGIN_X = 90;
const MARGIN_Y = 70;

const STROKE: Record<Classification, string> = {
  SAFE: '#34d399',
  WARNING: '#fbbf24',
  BREAKING: '#f87171',
  UNKNOWN: '#c084fc',
};

interface Positioned {
  id: string;
  org: string;
  project: string;
  base: string;
  version: string;
  consumers: number;
  verdict?: Classification;
  level: number;
  x: number;
  y: number;
}

/**
 * Deterministic layered layout: level(n) = 0 when the contract has no
 * in-graph dependencies, else 1 + max(level of dependencies). Foundational
 * contracts sit on the left; top-level consumers on the right. Nodes are
 * sized by direct consumer count. The canvas height adapts to the densest
 * layer so wide graphs don't crush labels together.
 */
function layout(data: GraphData): { positioned: Positioned[]; height: number } {
  const deps = new Map<string, string[]>();
  const consumersOf = new Map<string, number>();
  for (const e of data.edges) {
    deps.set(e.from, [...(deps.get(e.from) ?? []), e.to]);
    consumersOf.set(e.to, (consumersOf.get(e.to) ?? 0) + 1);
  }
  const ids = data.nodes.map((n) => n.id);
  const idSet = new Set(ids);

  const levelCache = new Map<string, number>();
  const levelOf = (id: string, seen: Set<string>): number => {
    if (levelCache.has(id)) return levelCache.get(id)!;
    if (seen.has(id)) return 0; // cycle guard
    seen.add(id);
    const ds = (deps.get(id) ?? []).filter((d) => idSet.has(d));
    const level = ds.length === 0 ? 0 : 1 + Math.max(...ds.map((d) => levelOf(d, seen)));
    levelCache.set(id, level);
    return level;
  };

  const nodes = data.nodes.map((n) => ({
    ...n,
    level: levelOf(n.id, new Set()),
  }));

  const maxLevel = Math.max(0, ...nodes.map((n) => n.level));
  const layers: (typeof nodes)[] = Array.from({ length: maxLevel + 1 }, () => []);
  for (const n of nodes) layers[n.level].push(n);

  const densest = Math.max(1, ...layers.map((l) => l.length));
  const height = Math.max(HEIGHT_MIN, densest * LAYER_ROOM + 2 * MARGIN_Y);

  const positioned: Positioned[] = [];
  for (let l = 0; l <= maxLevel; l += 1) {
    const layer = layers[l].sort((a, b) => (a.id < b.id ? -1 : 1));
    const x = MARGIN_X + (l * (WIDTH - 2 * MARGIN_X)) / Math.max(1, maxLevel);
    layer.forEach((n, i) => {
      const y =
        layer.length === 1
          ? height / 2
          : MARGIN_Y + (i * (height - 2 * MARGIN_Y)) / (layer.length - 1);
      positioned.push({ ...n, x, y });
    });
  }
  return { positioned, height };
}

export function CompatGraph({ data }: { data: GraphData }) {
  const router = useRouter();
  const [hovered, setHovered] = React.useState<string | null>(null);

  const { positioned: nodes, height } = React.useMemo(() => layout(data), [data]);
  const byId = React.useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);

  const radiusOf = (consumers: number) => Math.min(26, 14 + consumers * 5);

  const isConnected = (edge: { from: string; to: string }) =>
    hovered !== null && (edge.from === hovered || edge.to === hovered);

  if (nodes.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-border p-10 text-center text-sm text-muted-foreground">
        No contracts in this scope.
      </p>
    );
  }

  return (
    // Horizontal scroll container: the diagram keeps a legible minimum width
    // instead of shrinking to ~5px labels on narrow viewports.
    <div className="w-full overflow-x-auto">
      <svg
        viewBox={`0 0 ${WIDTH} ${height}`}
        className="h-auto w-full min-w-[860px] select-none"
        role="group"
        aria-label="Contract dependency graph. Nodes are contracts sized by consumer count; edges are import dependencies."
      >
      <defs>
        <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M 0 1 L 9 5 L 0 9" fill="none" className="stroke-zinc-500" strokeWidth="1.6" />
        </marker>
        <marker id="arrow-hot" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M 0 1 L 9 5 L 0 9" fill="none" className="stroke-primary" strokeWidth="1.6" />
        </marker>
      </defs>

      {/* Edges */}
      {data.edges.map((e) => {
        const a = byId.get(e.from);
        const b = byId.get(e.to);
        if (!a || !b) return null;
        const hot = isConnected(e);
        const dim = hovered !== null && !hot;
        const x1 = a.x + radiusOf(a.consumers);
        const x2 = b.x - radiusOf(b.consumers) - 4;
        const mid = (x1 + x2) / 2;
        return (
          <path
            key={`${e.from}->${e.to}`}
            d={`M ${x1} ${a.y} C ${mid} ${a.y}, ${mid} ${b.y}, ${x2} ${b.y}`}
            fill="none"
            markerEnd={hot ? 'url(#arrow-hot)' : 'url(#arrow)'}
            className={cn(
              'transition-opacity',
              hot ? 'stroke-primary' : 'stroke-zinc-500',
            )}
            strokeWidth={hot ? 2 : 1.2}
            opacity={dim ? 0.15 : 1}
          />
        );
      })}

      {/* Nodes */}
      {nodes.map((n) => {
        const r = radiusOf(n.consumers);
        const hot = hovered === n.id;
        const linked =
          hovered !== null &&
          data.edges.some((e) => (e.from === hovered && e.to === n.id) || (e.to === hovered && e.from === n.id));
        const dim = hovered !== null && !hot && !linked;
        const ring = n.verdict ? STROKE[n.verdict] : '#71717a';
        return (
          <g
            key={n.id}
            tabIndex={0}
            role="link"
            aria-label={`${n.base} at ${n.version}, ${n.consumers} consumers${n.verdict ? `, latest diff verdict: ${n.verdict}` : ""}. Open contract page.`}
            className="cursor-pointer focus:outline-none"
            onMouseEnter={() => setHovered(n.id)}
            onMouseLeave={() => setHovered(null)}
            onFocus={() => setHovered(n.id)}
            onBlur={() => setHovered(null)}
            onClick={() => router.push(`/contracts/${n.org}/${n.project}/${n.base}`)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') router.push(`/contracts/${n.org}/${n.project}/${n.base}`);
            }}
            opacity={dim ? 0.25 : 1}
          >
            <circle
              cx={n.x}
              cy={n.y}
              r={r + (hot ? 4 : 0)}
              fill={hot ? 'rgba(52, 211, 153, 0.08)' : 'transparent'}
              stroke={hot ? '#34d399' : 'transparent'}
              strokeWidth={1.5}
            />
            <circle cx={n.x} cy={n.y} r={r} fill="#131316" stroke={ring} strokeWidth={2} />
            <text
              x={n.x}
              y={n.y + 4}
              textAnchor="middle"
              className="fill-zinc-200 font-mono"
              fontSize={13}
            >
              {n.consumers}
            </text>
            <text
              x={n.x}
              y={n.y + r + 16}
              textAnchor="middle"
              className="fill-zinc-300 font-mono"
              fontSize={12.5}
            >
              {n.base}
            </text>
            <text
              x={n.x}
              y={n.y + r + 30}
              textAnchor="middle"
              className="fill-zinc-400 font-mono"
              fontSize={10}
            >
              {n.version}
            </text>
          </g>
        );
      })}
      </svg>
    </div>
  );
}

export function GraphLegend() {
  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-xs text-muted-foreground">
      <span className="flex items-center gap-2">
        <svg width="34" height="20" aria-hidden="true">
          <circle cx="17" cy="10" r="8" fill="#131316" stroke="#71717a" strokeWidth="2" />
        </svg>
        node size = direct consumers
      </span>
      <span className="flex items-center gap-2">
        <svg width="34" height="20" aria-hidden="true">
          <circle cx="17" cy="10" r="8" fill="#131316" stroke="#f87171" strokeWidth="2" />
        </svg>
        ring = latest diff verdict
      </span>
      <span className="flex items-center gap-2">
        <svg width="34" height="12" aria-hidden="true">
          <path d="M2 6 H26" stroke="#71717a" strokeWidth="1.5" markerEnd="" />
          <path d="M26 2 L32 6 L26 10" fill="none" stroke="#71717a" strokeWidth="1.5" />
        </svg>
        edge = imports (consumer → dependency)
      </span>
      <span className="flex items-center gap-2">
        <span className="font-mono text-zinc-300">N</span> inside node = consumer count
      </span>
    </div>
  );
}
