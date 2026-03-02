---
name: instagram-play
description: Automate Instagram interactions — browsing feed, stories, reels, DMs, posting, and story creation. Use when the user asks to use Instagram, check DMs, post content, create stories, or browse their feed on phone.
---

# Instagram Play

Use this skill to help users navigate and interact with Instagram efficiently on a mobile device.

## Core Principle

Act autonomously. Execute tasks without asking the user for confirmation at each step. Read the screen, make decisions, and proceed.

## Creating a Story

- To create a new story, go to the user's profile tab (bottom-right) and **tap the + (add) button on the profile picture at the top-left**.
- This opens the story camera/picker. Tap the gallery/album thumbnail (bottom-left) to open the photo picker. Select a photo, then tap **Next** (top-right) to proceed to the editor.
- Add text, stickers, or other overlays as requested by the user.
- Tap "Your Story" at the bottom to publish.
- Do not tap the + button in the bottom nav bar — that's for posts/reels, not stories.

## Browsing Feed

- The home tab (house icon, bottom-left) shows the main feed.
- Scroll by swiping up to see more posts.
- Double-tap a post to like it.
- Tap the comment icon (speech bubble) to open comments.
- Tap the share icon (paper plane) to send a post to someone via DM.

## Stories

- Story circles appear at the top of the home feed.
- Tap a story circle to view it. Tap the right side of the screen to skip to the next story, left side to go back.
- Swipe left to skip to the next person's story.
- To reply to a story, tap the message input at the bottom and type a response.

## Reels

- Reels tab is the play button icon in the bottom nav.
- Swipe up to see the next reel, swipe down for the previous one.
- Like by double-tapping or tapping the heart icon on the right.

## Direct Messages (DMs)

- Tap the messenger/DM icon (paper plane) at the top-right of the home feed.
- Conversations are listed — tap one to open it.
- Reply in the same language the conversation is in.
- Type in the message input at the bottom, then tap send.
- Use batch action for tap-input → type → send flow.

## Posting

- Tap the + button in the bottom center nav bar to create a new post.
- Select photo(s) from the gallery.
- Apply filters or edits if the user requests.
- Add a caption as instructed, then tap Share to publish.

## Navigation

- **Home** (house icon): main feed — bottom-left.
- **Search** (magnifying glass): explore/discover — second from left.
- **Create** (+ button): new post/reel — bottom center.
- **Reels** (play icon): short videos — second from right.
- **Profile** (avatar): user's profile — bottom-right.
- **DMs** (paper plane): top-right of home feed.
- **Back**: Android back button or top-left arrow to go back.

## Common Pitfalls

- **Story creation**: use the + on the profile picture (top-left of profile tab), not the + in the bottom nav bar.
- **Popups and notifications**: dismiss "Turn on notifications" prompts, update dialogs, and suggestion popups.
- **Keyboard blocking**: the keyboard may cover action buttons — scroll or dismiss if needed.
- **Slow media loading**: wait briefly (~500ms) after opening stories or reels before interacting, as media loads asynchronously.
- **Account switching**: if the app has multiple accounts, verify you're on the correct one before posting.

## Failure Handling

- If a post or story fails to upload, retry once. If it fails again, inform the user.
- If Instagram asks to log in or shows a session expired screen, call request_human_auth with capability=oauth.
- If the app crashes, relaunch and continue from the home tab.
