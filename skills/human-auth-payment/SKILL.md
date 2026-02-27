---
name: "Human Auth: Payment"
description: "Handle payment card delegation from Human Phone. Covers credit/debit card number, expiry, CVC entry in checkout flows."
metadata: {"openclaw":{"triggers":{"any":["payment","credit card","debit card","card number","checkout","pay","purchase","billing","cvc","cvv","expiry"]}}}
---

# Human Auth: Payment

Use this when an app requires payment card information for a purchase or subscription.

## When to Trigger

- App shows a payment/checkout form asking for card details.
- App requests payment method during subscription signup.

## How to Call

```
request_human_auth(
  capability: "payment",
  instruction: "Please enter your payment card details for [purchase description, amount].",
  uiTemplate: {
    fields: [
      { id: "card_number", label: "Card Number", type: "card-number", required: true },
      { id: "expiry", label: "Expiration", type: "expiry", required: true, placeholder: "MM/YY" },
      { id: "cvc", label: "Security Code", type: "cvc", required: true }
    ],
    artifactKind: "payment_card",
    requireArtifactOnApprove: true,
    title: "Payment Card Required",
    summary: "Enter your card details to complete payment."
  }
)
```

## After You Receive the Artifact

1. **Read the artifact:** `read(<artifact_path>)` to get card fields.

2. **Check the current screen.** The checkout form may still be visible.

3. **If the form is visible:** fill each field by tapping + typing (card number, expiry, CVC).

4. **If the screen changed:** navigate back to the checkout page.

5. **Tap Pay / Submit / Complete Purchase.**

6. **Delete the artifact immediately:** `exec("rm <artifact_path>")`

## Tips

- Card number fields may auto-format. Type the full number without spaces.
- Expiry format: check the placeholder (MM/YY or MMYY).
