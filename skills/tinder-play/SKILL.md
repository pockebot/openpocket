---
name: tinder-play
description: Automate Tinder conversations and swiping. Use when the user asks to use Tinder, reply to matches, swipe, or manage their dating app interactions on phone.
---

# Tinder Play

Use this skill to automate Tinder interactions — swiping, messaging, and replying to matches — without asking the user for permission at each step. The goal is full automation.

## Core Principle

Act autonomously. Do not ask the user what to say or whether to swipe. Make decisions yourself — you are the autopilot. The user will intervene only if they want to override.

## Swiping

- To see detailed user info (bio, interests, basics), **tap the up arrow button** on the profile card or swipe up.
- Swipe right (like) on profiles that look genuine and have bios.
- Swipe left (pass) on empty profiles, obvious spam, or profiles with no photos.
- If a Super Like prompt or boost popup appears, dismiss it unless the user previously asked to use them.
- Do not spend time analyzing profiles deeply — keep a steady pace.

## Conversations

### What "Help Me Chat" Means

When the user asks to "help chat on Tinder" or similar, handle **both**:
1. **Your turns**: conversations where the other person sent the last message — reply to these.
2. **Never-replied matches**: new matches where no one has messaged yet — send an opener to these.

Work through both categories before finishing.

### Finding Your Turn

- Open the matches/messages tab.
- Identify conversations where **the other person sent the last message** — these are your turns to reply.
- Also identify **matches with no messages at all** — these need an opening message.
- Prioritize recent messages (within the last few hours) over older ones.
- Skip conversations where you (the user) already sent the last message — no double-texting.

### Composing Replies

- Read the conversation history on screen to understand context and tone.
- **Reply in the same language the conversation is in.** If the other person writes in Spanish, reply in Spanish. Match their language.
- Reply with natural, friendly, and engaging messages. Keep it light and conversational.
- Match the energy of the other person — if they're playful, be playful; if they're direct, be direct.
- Ask follow-up questions to keep the conversation going.
- Keep messages short — 1–3 sentences max. No essays.
- Avoid generic openers like "Hey" or "What's up" when replying mid-conversation.
- Do not use pickup lines or anything cringe. Be genuine.
- Reference something specific from their message or profile when possible.

### Opening New Matches

- For new matches with no messages yet, open with something specific to their profile (bio, photos, interests).
- If the profile has nothing to work with, a simple friendly opener is fine.

## Navigation

- **Swipe screen**: main screen — swipe right to like, left to pass.
- **Matches tab**: tap the chat bubble icon at the bottom to see matches and messages.
- **Conversation view**: tap a match to open the chat. Message input is at the bottom.
- **Back**: use the back arrow or Android back to return to the matches list.
- **Profile view**: tap the profile photo in a conversation to see their full profile for context.

## Batch Workflow

When the user says "handle my Tinder" or similar:

1. Open the messages tab.
2. Scan for conversations where it's your turn to reply.
3. Reply to each one — read context, compose, type, send.
4. After replying to all pending conversations, switch to the swipe screen.
5. Swipe through a batch of profiles (10–20).
6. Return to messages to check for any new replies that came in.
7. Call finish with a summary: number of replies sent, number of swipes, any new matches.

## Sending a Message

- Tap the text input field at the bottom of the conversation.
- Type the message using `type_text`.
- Tap the send button (arrow icon) to send.
- Use batch action for the tap-input → type → send flow.

## Common Pitfalls

- **Do not double-text.** If the user's message is the last one, move on.
- **Do not ask the user what to say.** Compose and send autonomously.
- **Popups and promotions**: Tinder frequently shows upgrade prompts, boost offers, and super-like nudges. Dismiss all of these by tapping X or "No thanks".
- **Match animations**: when a new match appears, dismiss the celebration screen to continue.
- **GIF/emoji keyboards**: if the keyboard switches to GIF or emoji mode, tap the text/ABC key to switch back before typing.
- **Read the room**: if someone seems uninterested or gives one-word replies, don't force the conversation. Move on.

## Failure Handling

- If a message fails to send, retry once. If it fails again, skip and move to the next conversation.
- If Tinder asks to verify or shows a captcha, call request_human_auth with capability=oauth.
- If the app crashes or freezes, relaunch it and continue from the messages tab.
