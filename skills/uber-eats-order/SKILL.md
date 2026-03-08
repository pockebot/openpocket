---
name: uber-eats-order
description: Order food or groceries end-to-end in the Uber Eats consumer app. Use when the user asks to open Uber Eats, browse merchants, add items, customize options, apply promos, choose delivery or pickup, place an order, or track order progress.
metadata: {"openclaw":{"triggers":{"any":["uber eats","ubereats","uber eats app","order food","food delivery","takeout","delivery order","com.ubercab.eats","\u70b9\u5916\u5356","\u53eb\u5916\u5356"]}}}
---

# Uber Eats Order

Use this skill to complete Uber Eats ordering flows with high reliability and low spend risk.

This skill is aligned with Uber Eats official help flows:
- place order path (`View cart` -> `Go to checkout` -> `Place order`)
- cancellation behavior (free before merchant accepts; possible charges after acceptance)
- post-order tracking and support entry points.

## Preconditions

- Confirm Uber Eats app is in foreground (`com.ubercab.eats`).
- If app is not installed, install and open it first.
- If login/sign-up is required, trigger `request_human_auth(oauth)`.
- If payment verification (card CVC, bank OTP, 3DS) appears, use `request_human_auth(payment)` and/or `request_human_auth(sms-2fa)`.

## Canonical Ordering Flow

Follow this baseline sequence unless the current screen requires a detour:

1. Choose merchant.
2. Add item(s) to cart.
3. Tap `View cart`, then `Go to checkout`.
4. Review delivery details and payment.
5. Tap `Place order`.
6. Track order status.

## UI Anchors (Common)

Treat labels as variants; exact wording may differ by locale/A-B test.

- Bottom tabs: `Home`, `Search`, `Cart`, `Account`.
- Entry controls: `Delivery` / `Pickup`, `ASAP` / `Schedule`, address chip near top.
- Item actions: `Add to cart`, `Customize`, `Required`, `Optional`, `Add`.
- Cart/checkout actions: `View cart`, `Go to checkout`, `Checkout`, `Place order`.
- Order status actions: `Cancel order`, `Help`, contact courier/support.

## Execution Procedure

### 1) Set fulfillment context first

- Confirm fulfillment mode with user intent: `Delivery` vs `Pickup`.
- Confirm destination/address before selecting items.
- If scheduling is requested, set `Schedule` before checkout.

### 2) Find the right merchant

- Prefer `Search` tab for deterministic lookup by merchant/dish.
- If user gave constraints (budget, ETA, cuisine, rating), apply them before opening merchant page.
- Avoid random browsing loops; open one candidate merchant and proceed.

### 3) Add items with correct modifiers

- Open item detail page and resolve all required modifier groups.
- Only submit `Add to cart` after required options are complete.
- For multi-quantity, prefer explicit quantity control in cart over repeated back-and-forth on menu cards.

### 4) Cart review before checkout

- Open `View cart` and verify:
  - item list and quantities
  - required modifiers were applied
  - promo/coupon status (if user asked)
- Then proceed via `Go to checkout` (or equivalent checkout CTA).

### 5) Checkout verification

Before final submit, verify all high-impact fields:

- fulfillment mode (`Delivery` or `Pickup`)
- delivery address / pickup store
- time (`ASAP` vs scheduled)
- payment method
- tip amount (if visible)
- final payable total (items + fees + taxes + tip)

If user asked for constraints (for example max total), enforce them here.

### 6) Final confirmation gate (mandatory)

- If user explicitly requested immediate purchase (for example “place it now”), proceed to `Place order`.
- Otherwise, pause at checkout and ask via `request_user_decision` before tapping `Place order`.
- Never silently submit an order when user intent is ambiguous.

### 7) After placing the order

- Stay on tracking screen and report key status:
  - accepted/preparing
  - courier matched / en route
  - ETA updates
- Keep notification-sensitive actions minimal unless user asks for changes.

## Safety Guardrails

- Never add Uber One subscription or any upsell without explicit request.
- Never change payment method to new credentials without human auth.
- Never place duplicate orders to “retry” without explicit user confirmation.
- If checkout total materially exceeds user expectation, stop and ask before placing.

## Changes and Cancellation Handling

Use Uber’s policy-aware behavior:

- Before merchant accepts:
  - cancellation is typically free; cancel and reorder if major edits are needed.
- After merchant accepts:
  - cancellation may incur charges.
  - do not cancel automatically; ask user first unless explicitly instructed.
- If item change is blocked after acceptance:
  - use in-app `Help` / support path and report constraints to user.

## Tooling Guidance

- Prefer `tap_element` when reliable UI candidates are present.
- Use `batch_actions` for short, deterministic same-screen edits (for example quantity +/- and confirm).
- Use `swipe` to browse long menus and cart sections.
- Use `launch_app` to recover quickly from background/app switch issues.
- If two similar taps fail to change state, switch target (row body vs button) instead of repeating.

## Completion Report

When finishing, include:

- whether order was placed or stopped at checkout
- merchant name
- fulfillment mode (`Delivery` or `Pickup`)
- scheduled time or ASAP
- final total observed
- latest order status (if placed)
- any unresolved blocker requiring user input
