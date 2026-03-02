---
name: duolingo-play
description: Help users complete Duolingo language lessons. Use when the user asks to do Duolingo, practice a language, complete lessons, or needs guidance navigating the Duolingo app on phone.
---

# Duolingo Play

Use this skill to help users complete Duolingo language lessons efficiently on a mobile device.

## Core Principle

Actively help the user complete lessons. Do not ask the user what the answer is — read the screen, determine the correct answer, and execute the action. The user expects you to drive the lesson, not spectate.

## Lesson Types & How to Handle

### Word Bank / Translation Tasks

- Tap the correct word tiles from the bank to form the translation.
- **Prefer batch action**: read the full sentence first, plan the complete answer, then tap all words in order — **include the Check button as the final tap in the same batch**. Do not tap one word, screenshot, tap another — this is slow and error-prone.
- Example: for a 5-word answer, issue a single batch of 6 taps — word1, word2, word3, word4, word5, then Check (検査) button at the bottom.
- If a word tile is wrong or out of order, **tap it from the top (the answer area) to remove it**, then tap the correct word from the bank.

### Matching Pairs

- Tap one item on the left, then its match on the right.
- Work through pairs systematically — matched pairs disappear, so re-screenshot after every 1–2 matches to see remaining items.

### Listening Exercises

- Tap the speaker icon to play audio, then type or select the answer.
- If you cannot hear audio, tap "Can't listen now" or the skip button if available.

### Speaking Exercises

- These require microphone input the agent cannot provide.
- Tap "Can't speak now" or the skip button to proceed.

### Type the Answer (Free Input)

- Tap the text input field to focus it.
- Type the full answer using `type_text`, then tap the check button.
- Watch for auto-correct or keyboard suggestions interfering — dismiss them if needed.

### Select the Correct Image

- Identify the image matching the prompt and tap it.

### Fill in the Blank

- Read the sentence context, determine the missing word, and tap the correct option.

## Navigation

- **Check button**: always at the bottom of the screen — tap it after entering/selecting your answer.
- **Continue button**: appears after checking — tap it to move to the next question. It often appears in the same position as the check button.
- **Progress bar**: at the top of the screen, shows lesson completion progress.
- **Close (X)**: top-left corner to exit a lesson (will prompt confirmation).
- **Heart / lives display**: top of screen — if hearts run out, the lesson ends.

## Common Pitfalls to Avoid

- **Do not wait for user input during a lesson.** Read the question, determine the answer, and act.
- **Do not tap words one at a time with screenshots in between** for translation tasks. Plan the full answer, then tap all words sequentially.
- **Removing a placed word**: tap it in the **answer area at the top**, not in the word bank at the bottom.
- **Accidental double-tap**: the check/continue button occupies the same screen area — be careful not to skip the result screen.
- **Animations and transitions**: wait briefly (~500ms) after tapping check/continue before taking the next screenshot, as Duolingo plays transition animations.
- **Typos in free-input**: double-check spelling before tapping check. Duolingo is strict on accents and special characters in some languages.

## Procedure

1. Screenshot the current screen to identify the exercise type.
2. Read the prompt and determine the correct answer.
3. Execute the answer (tap words, type text, select image, etc.). For word bank tasks, include the **Check** button tap as the last action in the same batch.
5. Screenshot to confirm correct/incorrect result.
6. Tap **Continue** to proceed to the next question.
7. Repeat until the lesson is complete.

## Failure Handling

- If an answer is marked incorrect, note the correction shown on screen and continue.
- If the app shows an ad or popup, dismiss it (tap X or "No thanks").
- If a heart/life is lost and no hearts remain, the lesson will end — inform the user.
- If the app navigates away from the lesson unexpectedly, re-enter via the lesson tree on the home screen.
