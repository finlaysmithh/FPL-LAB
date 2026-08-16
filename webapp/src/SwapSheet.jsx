import React from "react";
import { POS_LABEL } from "./logic.js";
import { MarketPanel } from "./MarketPanel.jsx";

/**
 * Mobile presentation of the transfer market. On a phone there is no room to
 * show the pitch and the market side by side, so the market comes up as a
 * sheet — but it is the same component, with the same explicit swap button,
 * so the interaction never changes shape between breakpoints.
 */
export function SwapSheet({ open, pos, setPos, current, squad, gi, onPick, onClose }) {
  if (!open) return null;
  return (
    <div className="sheet-veil" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet" role="dialog"
        aria-label={current != null ? "Swap a player" : `Add a ${POS_LABEL[pos]}`}>
        <div className="sheet-grab" />
        <button className="sheet-close" onClick={onClose} aria-label="Close">✕</button>
        <MarketPanel
          squad={squad} gi={gi} out={current} pos={pos} setPos={setPos}
          onSwapIn={onPick} onCancel={onClose} />
      </div>
    </div>
  );
}
