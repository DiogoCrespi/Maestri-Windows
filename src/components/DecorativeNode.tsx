import React from "react";
import { Handle, NodeResizer, Position, type NodeProps } from "@xyflow/react";
import "./DecorativeNode.css";

export type DecorativeContent = Record<string, unknown>;

export interface DecorativeNodeData {
  content?: DecorativeContent;
  contentVariant?: string;
  onChangeContent?: (content: DecorativeContent) => void;
  onClose?: () => void;
  [key: string]: unknown;
}

const KNOWN_VARIANTS = new Set(["text", "shape", "stroke", "freehand", "drawing"]);

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function boundedNumber(value: unknown, fallback: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, finiteNumber(value, fallback)));
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value)
    ? value
    : fallback;
}

function colorValue(value: unknown, fallback: string): string {
  const color = stringValue(value, fallback);
  return /^[#a-zA-Z0-9(),.%\s-]+$/.test(color) ? color : fallback;
}

export function normalizeDecorativeVariant(value: unknown): string {
  const variant = typeof value === "string" && value.trim() ? value.trim() : "unknown";
  return KNOWN_VARIANTS.has(variant) ? variant : "unknown";
}

export function finitePoints(value: unknown): Array<{ x: number; y: number }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((point) => {
    if (Array.isArray(point) && point.length >= 2) {
      const x = finiteNumber(point[0], Number.NaN);
      const y = finiteNumber(point[1], Number.NaN);
      return Number.isFinite(x) && Number.isFinite(y) ? [{ x, y }] : [];
    }
    const candidate = recordValue(point);
    const x = finiteNumber(candidate.x, Number.NaN);
    const y = finiteNumber(candidate.y, Number.NaN);
    return Number.isFinite(x) && Number.isFinite(y) ? [{ x, y }] : [];
  });
}

function svgPoints(points: Array<{ x: number; y: number }>): string {
  return points.map((point) => `${point.x},${point.y}`).join(" ");
}

function strokeDash(style: unknown): string | undefined {
  if (style === "dashed") return "8 6";
  if (style === "dotted") return "2 5";
  return undefined;
}

function ShapeSvg({ content, width, height, nodeId }: {
  content: DecorativeContent;
  width: number;
  height: number;
  nodeId: string;
}) {
  const shapeType = content.shapeType === "ellipse" || content.shapeType === "diamond"
    ? content.shapeType
    : "rect";
  const fillStyle = content.fillStyle;
  const fill = fillStyle === "none" ? "transparent" : fillStyle === "hatched" || fillStyle === "crossHatched"
    ? `url(#decorative-${nodeId.replace(/[^a-zA-Z0-9_-]/g, "") || "shape"})`
    : colorValue(content.fillColor, "#dbeafe");
  const stroke = colorValue(content.strokeColor, "#2563eb");
  const strokeWidth = boundedNumber(content.strokeWidth, 2, 0.5, 24);
  const dash = strokeDash(content.strokeStyle);
  const patternId = `decorative-${nodeId.replace(/[^a-zA-Z0-9_-]/g, "") || "shape"}`;
  const inset = Math.max(2, strokeWidth);
  const shape = shapeType === "ellipse"
    ? <ellipse cx={width / 2} cy={height / 2} rx={Math.max(1, width / 2 - inset)} ry={Math.max(1, height / 2 - inset)} />
    : shapeType === "diamond"
      ? <polygon points={`${width / 2},${inset} ${width - inset},${height / 2} ${width / 2},${height - inset} ${inset},${height / 2}`} />
      : <rect x={inset} y={inset} width={Math.max(1, width - inset * 2)} height={Math.max(1, height - inset * 2)} rx={8} />;

  return (
    <svg className="decorative-node__svg" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${shapeType} shape`}>
      <defs>
        <pattern id={patternId} width="12" height="12" patternUnits="userSpaceOnUse">
          <path d={fillStyle === "crossHatched" ? "M0 0L12 12M12 0L0 12" : "M-3 12L12 -3M3 15L15 3"} stroke={stroke} strokeWidth="1" opacity="0.45" />
        </pattern>
      </defs>
      <g fill={fill} stroke={stroke} strokeWidth={strokeWidth} strokeDasharray={dash}>
        {shape}
      </g>
    </svg>
  );
}

function StrokeSvg({ content, width, height }: { content: DecorativeContent; width: number; height: number }) {
  const start = recordValue(content.startPoint);
  const end = recordValue(content.endPoint);
  const control = recordValue(content.controlPoint);
  const x1 = finiteNumber(start.x, 0);
  const y1 = finiteNumber(start.y, 0);
  const x2 = finiteNumber(end.x, width);
  const y2 = finiteNumber(end.y, height);
  const hasControl = Number.isFinite(control.x) && Number.isFinite(control.y);
  const path = hasControl
    ? `M ${x1} ${y1} Q ${control.x} ${control.y} ${x2} ${y2}`
    : `M ${x1} ${y1} L ${x2} ${y2}`;
  const stroke = colorValue(content.strokeColor, "#a855f7");
  const strokeWidth = boundedNumber(content.strokeWidth, 3, 0.5, 24);
  const markerId = `arrow-${Math.abs(Math.round(x1 + y1 + x2 + y2))}`;
  return (
    <svg className="decorative-node__svg" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="canvas stroke">
      <defs>
        <marker id={markerId} markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto" markerUnits="strokeWidth">
          <path d="M0,0 L8,4 L0,8 z" fill={stroke} />
        </marker>
      </defs>
      <path d={path} fill="none" stroke={stroke} strokeWidth={strokeWidth} strokeDasharray={strokeDash(content.strokeStyle)} strokeLinecap="round" markerEnd={content.strokeType === "arrow" ? `url(#${markerId})` : undefined} />
    </svg>
  );
}

function FreehandSvg({ content, width, height }: { content: DecorativeContent; width: number; height: number }) {
  const points = finitePoints(content.points);
  const stroke = colorValue(content.strokeColor, "#f97316");
  const strokeWidth = boundedNumber(content.strokeWidth, 4, 0.5, 32);
  const opacity = boundedNumber(content.opacity, content.freehandType === "highlighter" ? 0.35 : 1, 0, 1);
  return (
    <svg className="decorative-node__svg" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="freehand drawing">
      {points.length > 1 ? (
        <polyline points={svgPoints(points)} fill="none" stroke={stroke} strokeWidth={strokeWidth} opacity={opacity} strokeLinecap="round" strokeLinejoin="round" />
      ) : (
        <text x="50%" y="50%" textAnchor="middle" className="decorative-node__empty">Desenho vazio</text>
      )}
    </svg>
  );
}

function TextEditor({ content, onChange }: { content: DecorativeContent; onChange?: (content: DecorativeContent) => void }) {
  const text = stringValue(content.text, "");
  return (
    <textarea
      className="decorative-node__text-editor nodrag nowheel"
      value={text}
      onChange={(event) => onChange?.({ ...content, text: event.target.value })}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      aria-label="Texto do canvas"
      spellCheck={false}
    />
  );
}

export const DecorativeNode: React.FC<NodeProps> = ({ id, selected, data, width, height }) => {
  const nodeData = data as unknown as DecorativeNodeData;
  const content = recordValue(nodeData.content);
  const variant = normalizeDecorativeVariant(nodeData.contentVariant);
  const safeWidth = Math.max(40, boundedNumber(width, 280, 40, 4000));
  const safeHeight = Math.max(40, boundedNumber(height, 180, 40, 4000));
  const label = variant === "unknown" ? stringValue(nodeData.contentVariant, "unknown") : variant;
  const textColor = colorValue(content.color, "#18181b");
  const fontSize = boundedNumber(content.fontSize, 18, 8, 96);

  let body: React.ReactNode;
  if (variant === "text") {
    body = (
      <div className="decorative-node__text" style={{ color: textColor, fontSize, fontWeight: stringValue(content.fontWeight, "400"), textAlign: stringValue(content.alignment, "left") as React.CSSProperties["textAlign"], fontFamily: stringValue(content.fontFamily, "inherit") }}>
        <TextEditor content={content} onChange={nodeData.onChangeContent} />
      </div>
    );
  } else if (variant === "shape") {
    body = (
      <div className="decorative-node__drawing-body">
        <ShapeSvg content={content} width={safeWidth} height={safeHeight} nodeId={id} />
        <input
          className="decorative-node__shape-label nodrag nowheel"
          value={stringValue(content.text, "")}
          onChange={(event) => nodeData.onChangeContent?.({ ...content, text: event.target.value })}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
          aria-label="Texto da forma"
          placeholder="Texto"
        />
      </div>
    );
  } else if (variant === "stroke") {
    body = <StrokeSvg content={content} width={safeWidth} height={safeHeight} />;
  } else if (variant === "freehand" || variant === "drawing") {
    body = <FreehandSvg content={content} width={safeWidth} height={safeHeight} />;
  } else {
    const unknownPoints = finitePoints(content.points);
    body = unknownPoints.length > 1
      ? <FreehandSvg content={{ ...content, points: unknownPoints }} width={safeWidth} height={safeHeight} />
      : <div className="decorative-node__fallback"><strong>Conteúdo preservado</strong><span>Variante não suportada: {label}</span></div>;
  }

  return (
    <div className={`decorative-node ${selected ? "is-selected" : ""}`}>
      <NodeResizer
        minWidth={40}
        minHeight={40}
        isVisible={selected}
        lineStyle={{ borderColor: "#a855f7", borderWidth: 1 }}
        handleStyle={{ width: 8, height: 8, backgroundColor: "#a855f7", borderRadius: 2 }}
      />
      <Handle type="target" position={Position.Top} className="decorative-node__handle" />
      <Handle type="source" position={Position.Bottom} className="decorative-node__handle" />
      <div className="decorative-node__header drag-handle">
        <span>{label}</span>
        {nodeData.onClose && <button type="button" className="decorative-node__close nodrag nowheel" onClick={nodeData.onClose} aria-label="Fechar conteúdo decorativo">×</button>}
      </div>
      <div className="decorative-node__body">{body}</div>
    </div>
  );
};

export default DecorativeNode;
