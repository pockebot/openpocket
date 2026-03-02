---
name: clash-of-clans-play
description: Play Clash of Clans on mobile with autonomous tactical decisions. Use when the user asks to attack, farm resources, push trophies/rank, run Builder Base attacks, collect rewards, or manage daily village upgrades in Clash of Clans.
---

# Clash of Clans Play

Use this skill to run Clash of Clans gameplay loops efficiently on phone with minimal risk.

## Core Principle

- Act autonomously: read the board, choose the best legal action, execute.
- Optimize for user intent:
  - `farm` -> maximize safe loot per minute.
  - `push` -> maximize stars and trophy/rank gain.
  - `builder-base` -> maximize star reward efficiency.
- Protect account assets: avoid irreversible spending/actions unless user explicitly asks.

## Mode Primer

- Home Village has two battle paths:
  - `Regular Battles` (TH2+): unlimited attacks and no trophy loss on defeat.
  - `Ranked Battles` (TH7+): up to 6 attacks/day in ranked seasons.
- Builder Base (versus mode) grants rewards by Bronze/Silver star milestones and from both attack and defense results.

## Rules Primer

### Home Village Battle Win Conditions

- Star rules (standard Home Village):
  - `1 star` at 50% destruction.
  - `1 star` for destroying Town Hall.
  - `1 star` for 100% destruction.
- Maximum is 3 stars.
- End battle manually when further gains are unlikely and the target objective is already secured.

### Builder Base Star Rewards

- Each versus battle can earn up to 6 stars across Stage 1 and Stage 2.
- Resource rewards are tied to Bronze and Silver star milestone progress.

## Phone Operation Mapping

- `tap`: select troop/spell/hero, deploy a unit, activate hero ability, claim reward, confirm dialogs.
- `drag` / `long_press_drag`: precise deployment line or camera repositioning.
- `swipe`: pan map, open side panels, browse event/task lists.
- Keep deployment taps inside legal deploy zones; do not spam random edge taps.

## Home Village Attack Workflow

1. **Scout before deploy**
- Identify Town Hall position, major splash defenses, and likely trap zones.
- Decide objective: safe 1-2 star, or full 3-star attempt.

2. **Create funnel**
- Remove outer buildings on both sides of entry lane first.
- Avoid dropping core troops before funnel exists.

3. **Main push**
- Deploy tank/frontline, then core DPS and support.
- Use spells reactively on high-value defense clusters and choke points.

4. **Hero timing**
- Trigger hero abilities when entering core pressure, saving key troops, or finishing core defenses.

5. **Cleanup discipline**
- Preserve 1-2 cleanup units for edge buildings.
- If objective is met and extra value is low, end battle to save time.

## Builder Base Workflow

1. Scout Stage 1 and choose a side with best pathing value.
2. Secure Stage 1 stars first; if Stage 2 unlocks, reassess remaining army before overcommitting.
3. Prefer consistent 3-4 star style over high-variance all-in attempts unless user asks high risk.
4. Continue until daily star reward objective is met, then stop unnecessary attacks.

## Daily Management Workflow

1. Collect resources and free rewards (chest/events/season UI if visible).
2. Keep builders and laboratory busy (no idle builder/lab time unless user requests save strategy).
3. Prioritize upgrades by user goal:
- `push`: offense first (army camps, key troops/spells/heroes, key offensive buildings).
- `farm`: economy plus efficient offense upgrades.
4. Train/queue army only if the current game version still requires it for the chosen mode.

## Hard Guardrails

- Never spend gems, raid medals, league medals, or paid shop items without explicit user instruction.
- Never start/opt-in/opt-out Clan War, CWL, or clan governance actions unless user asks.
- Never permanently alter base layout strategy unless user asks for base editing.
- If login/security/payment dialogs appear, use human-auth flow instead of guessing credentials.

## Failure Handling

- If deployment misses due to bad coordinate, re-center and retry once with controlled tap timing.
- If popup interrupts battle flow, close popup first and re-validate current mode/screen.
- If battle outcome is clearly lost for the target objective, cut losses early and continue next cycle.

## Completion Report

After a run, summarize:
- Mode(s) played (`regular`, `ranked`, `builder-base`).
- Number of attacks and average stars.
- Resource gain and trophy/rank delta.
- Upgrades started/queued.
- Any consumables or premium currency spent (should be `none` unless explicitly requested).
