import React from "react";

export type WorkspaceLocationType = "local" | "ssh";

export interface LocationBadgeProps {
  locationType?: string | null;
  host?: string | null;
  className?: string;
  style?: React.CSSProperties;
}

export const LocationBadge: React.FC<LocationBadgeProps> = ({
  locationType = "local",
  host,
  className = "",
  style = {},
}) => {
  const normalizedType = (locationType || "local").toLowerCase();
  const isSsh = normalizedType === "ssh";

  const labelText = isSsh ? `SSH ${host ? `(${host})` : ""}` : "LOCAL";
  const ariaLabel = `Ambiente de Execução: ${isSsh ? "SSH Remote" : "Local"}`;

  return (
    <span
      className={`location-badge ${isSsh ? "location-badge-ssh" : "location-badge-local"} ${className}`.trim()}
      role="status"
      aria-label={ariaLabel}
      title={isSsh ? `Execução remota via SSH ${host ? `(${host})` : ""}` : "Execução local no ambiente do host"}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "4px",
        fontSize: "11px",
        fontWeight: 600,
        padding: "2px 6px",
        borderRadius: "4px",
        userSelect: "none",
        letterSpacing: "0.02em",
        backgroundColor: isSsh ? "rgba(6, 182, 212, 0.15)" : "rgba(113, 113, 122, 0.15)",
        color: isSsh ? "#22d3ee" : "#a1a1aa",
        border: `1px solid ${isSsh ? "rgba(6, 182, 212, 0.3)" : "rgba(113, 113, 122, 0.3)"}`,
        ...style,
      }}
    >
      <span style={{ fontSize: "10px", lineHeight: 1 }}>{isSsh ? "🌐" : "💻"}</span>
      <span>{labelText}</span>
    </span>
  );
};
