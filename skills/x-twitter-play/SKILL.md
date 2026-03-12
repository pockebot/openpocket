---
name: x-twitter-play
description: Automate X (Twitter) interactions — browsing feed, posting, replying, quoting, reposting, bookmarking, DMs, and profile management. Use when the user asks to use X/Twitter, post a tweet, reply to posts, check notifications, send DMs, or browse their timeline on phone.
metadata: {"openclaw":{"triggers":{"any":["x","twitter","tweet","post","repost","quote tweet","x.com","timeline","feed"]}}}
---

# X (Twitter) Play

Use this skill to help users navigate and interact with X (formerly Twitter) on a mobile device.

## Core Principle

Act autonomously. Execute tasks without asking the user for confirmation at each step. Read the screen, make decisions, and proceed.

## Navigation — Bottom Tab Bar

The bottom navigation bar has 5 tabs (left to right):

- **Home** (house icon): main timeline — bottom-left.
- **Search** (magnifying glass): explore/trending — second from left.
- **Grok** (Grok AI icon): AI assistant — center. On some versions this may be Communities.
- **Notifications** (bell icon): mentions, likes, reposts — second from right.
- **Messages** (envelope icon): direct messages — bottom-right.

The navigation menu is accessed via the **profile avatar** at the top-left of the Home screen.  It contains: Profile, Premium, Bookmarks, Lists, Spaces, Monetization, Settings and Privacy.

## Composing a New Post

- On **any** screen with the bottom tab bar visible, tap the **blue floating action button (FAB)** in the **bottom-right corner** (circle with a quill/+ icon).  This opens the full-screen post composer.
- Type the post text in the input area (up to 280 chars, or 4 000 for Premium).
- Attach media using the icon row at the bottom of the composer: photo (gallery icon), GIF, poll, location, schedule (calendar icon).
- Tap **Post** (top-right) to publish.
- To save a draft instead, tap the **X** (close) icon at the top-left, then select **Save**.

### Threads

To create a multi-post thread:

1. Type the first post in the composer.
2. Tap the **+** button that appears at the bottom-right of the text area to add a second post.
3. Repeat for additional posts.
4. Tap **Post all** to publish the entire thread at once.

## Feed & Timeline

- The Home tab shows two sub-tabs at the top: **For You** (algorithmic) and **Following** (chronological).  Swipe left/right or tap the tab name to switch.
- Pull down to refresh the feed.
- Swipe/scroll up to load more posts.

## Post Interaction Icons

Every post shows a row of action icons at the bottom (left to right):

1. **Reply** (speech bubble): opens the reply composer.
2. **Repost** (two-arrow loop): opens a popup menu with **Repost** (instant share) and **Quote** (compose with the original post embedded).
3. **Like** (heart): toggles like. Tap once to like, tap again to unlike.
4. **Views** (bar chart): shows view count — not tappable on most versions.
5. **Share** (share/upload icon): opens a menu with **Copy link**, **Share via…**, **Send via Direct Message**, and **Bookmark**.

### Repost vs. Quote

- **Repost**: tap the repost icon → tap "Repost" in the popup.  This shares the post instantly to your followers with no added text.
- **Quote**: tap the repost icon → tap "Quote" in the popup.  This opens the post composer with the original post embedded below. Type your commentary above it, then tap **Post**.

IMPORTANT: Do **not** paste a URL to quote a post.  Always use the repost icon → Quote flow; this produces a proper embedded quote card.

### Bookmark

Tap the **Share** icon on any post → **Bookmark**.  Bookmarked posts are accessible from the navigation menu → Bookmarks.

## Replying to a Post

### From the feed

Tap the **reply icon** (speech bubble) under the post.  This opens a full-screen reply composer showing the original post at the top and a text input below.  Type your reply and tap **Reply** (top-right).

### From the post detail / article page

When you open a post (tap on the post body text), the detail page shows the post, its metrics, and a list of replies below.  At the very bottom of the screen is a **"Post your reply"** text field.  Tap it to open the reply composer.

The reply composer is the same full-screen overlay described above.

## Searching & Exploring

- Tap the **Search** tab (magnifying glass).
- Tap the search bar at the top and type keywords, hashtags, or @usernames.
- Results are grouped by tabs: Top, Latest, People, Media, Lists.
- Trending topics appear on the Explore page before you type anything.

## Notifications

- Tap the **Notifications** tab (bell icon).
- Sub-tabs: **All** and **Verified**.
- Tap any notification to jump to the relevant post or profile.

## Direct Messages (DMs)

- Tap the **Messages** tab (envelope icon, bottom-right).
- Conversations are listed by recency.  Tap one to open.
- Type in the message input at the bottom, then tap the **send** arrow.
- To share a post via DM: on the post, tap the **Share** icon → **Send via Direct Message**, then pick a conversation.
- To start a new DM: tap the **new message** icon (envelope with a +) at the bottom-right of the Messages screen.

## Profile

- Tap the **profile avatar** (top-left) → tap your name/handle, or tap the **Profile** row in the navigation menu.
- Profile page tabs: **Posts**, **Replies**, **Highlights**, **Media**, **Likes**.
- To edit your profile: tap **Edit profile** below the banner image.

## Spaces (Audio)

- Access Spaces from the navigation menu or from Spaces tabs in Explore.
- Tap a live Space card to join as a listener.

## Common Pitfalls

- **Compose button location**: the blue FAB is at the **bottom-right**, overlaid on top of the tab bar.  It is present on Home, Search, Notifications, and Messages screens.  Do not look for a + in the tab bar itself.
- **Repost popup**: tapping the repost icon does **not** immediately repost. It shows a two-option popup (Repost / Quote).  Wait for the popup to appear before tapping.
- **Quote compose vs. URL paste**: always use the repost → Quote flow.  Pasting a URL creates a link preview, not an embedded quote card, and may look broken or include URL-encoded text.
- **Reply field on post detail**: "Post your reply" sits at the very bottom edge of the screen and may be partially hidden behind the system navigation bar.  Scroll down or tap near the bottom to find it.
- **Keyboard blocking buttons**: after typing in the reply or post composer, the keyboard may cover the Reply/Post button.  The button is at the **top-right**, not behind the keyboard, so just tap there.
- **"Who can reply?" prompt**: when composing a reply, X may show a "Who can reply?" badge.  Leave it as default ("Everyone") unless the user specifies otherwise.
- **Slow media / loading spinners**: posts with images or videos may show a placeholder briefly.  Wait ~500 ms after navigation before interacting.
- **Dark mode**: the X app commonly runs in dark mode (pure black background).  UI elements are light-colored text on dark backgrounds.
- **Popups and prompts**: dismiss "Turn on notifications", "Rate this app", "Get Verified" prompts by tapping the X/close button or tapping outside the dialog.
- **Multiple accounts**: if the user has multiple accounts, the profile avatar at top-left shows the active account.  Long-press it to switch accounts.

## Login & Session Recovery

- If X shows a login screen, session-expired banner, or "Something went wrong" repeatedly, call `request_human_auth` with `capability=oauth` so the user can re-authenticate.
- If the app crashes or force-closes, relaunch via `launch_app` with package `com.twitter.android` and continue from the Home tab.
- If you see "Attestation denied" or a CAPTCHA challenge, call `request_human_auth` — these cannot be solved automatically.
