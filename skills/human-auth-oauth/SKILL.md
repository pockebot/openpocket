---
name: "human-auth-oauth"
description: "Handle account login credential delegation from Human Phone. Covers username/password entry, social sign-in walls, and multi-step login flows."
metadata: {"openclaw":{"triggers":{"any":["oauth","login","sign in","credentials","username","password","account","authentication","social login","google sign"]}}}
---

# Human Auth: OAuth / Login

Use this when an app requires the user to log in with their account credentials.

## When to Trigger

- App shows a login screen with username/email and password fields.
- App redirects to a social sign-in page (Google, Apple, Facebook, etc.).
- App requires account authentication to proceed.

## How to Call

```
request_human_auth(
  capability: "oauth",
  instruction: "Please provide your login credentials for [app/service name].",
  uiTemplate: {
    fields: [
      { id: "username", label: "Username / Email", type: "text", required: true, autocomplete: "username" },
      { id: "password", label: "Password", type: "password", required: true, autocomplete: "current-password" }
    ],
    artifactKind: "credentials",
    requireArtifactOnApprove: true,
    title: "Account Login Required",
    summary: "Enter your credentials to log in."
  }
)
```

## After You Receive the Artifact

1. **Read the artifact:** `read(<artifact_path>)` to get `username` and `password`.

2. **Check the current screen.** The login form may still be visible, or the app may have changed state during the wait.

3. **If the login form is still visible:**
   - Tap the username/email field → `type_text(<username>)`
   - Tap the password field → `type_text(<password>)`
   - Tap Sign In / Log In / Submit

4. **If the screen changed:** press `keyevent KEYCODE_BACK` to return to the login form, or re-navigate to it.

5. **Delete the artifact immediately** (contains plaintext credentials):
   ```
   exec("rm <artifact_path>")
   ```

6. Handle post-login flows (2FA prompt, terms acceptance, etc.) as needed.

## Multi-Step Login (e.g., Google)

Some services split login into two pages (email first, then password). If the login screen only shows one field:
- Type the visible field's value, tap Next.
- On the next page, call `request_human_auth` again for the password if needed, or use the already-received credentials.

## Tips

- If the app has "Sign in with Google/Apple" button, consider Remote Takeover so the human can complete the OAuth flow directly.
- Never type credentials into the wrong field. Always verify the field label before typing.
