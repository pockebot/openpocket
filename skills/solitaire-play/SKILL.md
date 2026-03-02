---
name: solitaire-play
description: Play Klondike Solitaire in mobile solitaire apps. Use when the user asks to play/solve/win solitaire, needs move-by-move card decisions, or asks for solitaire operation guidance on phone UI (tap, swipe-based drag, stock cycling, and foundation strategy).
---

# Solitaire Play

Use this skill to play standard **Klondike Solitaire** in mobile apps with deterministic and low-risk moves.

## Preconditions

- Confirm the game screen is visible (tableau columns, stock/waste, foundations).
- Dismiss popups, ads, tutorials, and rate dialogs first.
- Detect whether the app is **Draw-1** or **Draw-3** by tapping stock once and observing waste behavior.

## Rules Primer (Klondike)

- Goal: move all cards to 4 foundations (A -> K by suit).
- Tableau build rule: descending rank with alternating colors (e.g., red 9 on black 10).
- Only Kings (or King-led stacks) can move to empty tableau columns.
- Face-down cards in tableau are revealed when the covering face-up card(s) are moved away.
- Stock/Waste:
  - Draw-1: one card enters waste per stock tap.
  - Draw-3: three cards cycle per stock tap; only top waste card is playable.

## Operation Mapping on Phone

Use available phone actions to emulate card interactions:

- Single-card quick move:
  - Prefer `tap` on card if app supports auto-move to foundation/tableau.
- Precise move (card/stack relocation):
  - Use `swipe(x1, y1, x2, y2, durationMs)` as drag.
  - Recommended `durationMs`: `250-450`.
- Long press (if app requires hold before drag):
  - Use `swipe(x, y, x, y, 600)` first, then drag with another `swipe`.
- Scrolling within menus/history:
  - Use `swipe` with long vertical distance.
- Never rely on random gestures. Keep start/end points centered on visible card bodies.

## Move Priority (Default Heuristic)

Apply this priority order each turn:

1. Safe foundation moves:
   - Move Aces and Twos to foundation immediately.
   - Move higher cards to foundation when it does not block revealing facedown tableau cards.
2. Reveal facedown cards:
   - Prefer tableau moves that uncover hidden cards over cosmetic rearrangement.
3. Build/merge tableau stacks:
   - Create longer alternating descending stacks only when it enables future reveals or king placement.
4. Use empty columns correctly:
   - Move a King (or King-led stack) to empty tableau columns when it helps reveal cards.
5. Play waste efficiently:
   - Try waste top card to tableau first, then to foundation.
6. Draw from stock:
   - Draw only when no productive tableau/foundation move exists.

## Procedure

1. Observe state:
   - Identify all playable face-up tableau tails.
   - Check waste top card and foundation tops.
2. Execute one highest-priority legal move.
3. Re-evaluate board after every move (never assume expected outcome).
4. If no move exists, tap stock once and repeat evaluation.
5. If stock recycle/reset is available, recycle and continue.
6. Stop when either:
   - all cards reach foundation (win), or
   - no legal moves remain after full stock cycle (stalled/loss state).

## Failure Handling

- If drag misses target:
  - Retry once with more centered coordinates and slightly longer duration (`+100ms`).
- If app does not support tap auto-move:
  - Switch to explicit drag-only flow using `swipe`.
- If animation blocks actions:
  - Use a short `wait` before next move.
- If board recognition is uncertain (overlap, tiny cards, occlusion):
  - Avoid risky multi-card drags; prefer reversible moves or stock draw.

## Completion Criteria

- Success: all four foundations are complete from Ace to King.
- Partial completion report:
  - include draw mode (Draw-1/Draw-3),
  - number of foundations completed,
  - whether the run is solvable/stalled from current state.
