# 🧠 CertFS Quiz

An Obsidian plugin. It quizzes you on a **note**, a **selection**, **several notes** or a **folder**, in exam style.
It also re-quizzes your **errors** with new versions until you master them.

- 🤖 Questions come from an **OpenRouter model** (free ones work).
- 📚 **Subjects** are set in Settings: a folder + an optional question style. Nothing is hardcoded.
- 🏃 Presets included: CSM (Scrum Guide 2020), PMP (PMI mindset, "what FIRST?"), CPMAI.
- ❌ Wrong answers → **error notes** in that subject's errors folder.
- 📊 Every answer goes to a local **history** → stats + no repeated questions.
- 🔁 Shareable: copy the folder (without `data.json` and `history.json`) to any vault.

---

## 📥 Install

- 🛍️ **Community plugins:** Settings → Community plugins → Browse → search **CertFS Quiz** → Install → Enable.
- 🧪 **Before it is listed (BRAT):** install the **BRAT** plugin → *Add beta plugin* → `KaramGuliyev/CertFS`.
- 📦 **Manual:** download `main.js`, `manifest.json`, `styles.css` from the latest [release](https://github.com/KaramGuliyev/CertFS/releases) into `<vault>/.obsidian/plugins/certfs-quiz/` → restart Obsidian → enable **CertFS Quiz**.

## ⚙️ Setup (once)

1. 🔑 Make a key at **openrouter.ai → Keys**.
2. 📋 Settings → **CertFS Quiz** → paste the key.
3. 📥 Click **Load free models** → pick one that ends in `:free`.
   - 🧹 The list shows only models that can chat (no embed, TTS, rerank).
4. 💲 On openrouter.ai, leave the key's **credit limit empty**. Don't set it to $0.
5. 📚 Settings → **Subjects**: check the list. On first run, presets whose folder exists are added.
   - ➕ **Add subject** → name, folder, rules note (optional), question style (optional).
   - 🔍 Folder and Rules note boxes **search the vault** as you type → click a result.
   - 📦 **Add presets** → adds CSM, PMP, CPMAI (edit their folders to match your vault).

---

## 🎯 Daily use

| Do this | How |
|---|---|
| 📖 Quiz the open note | 🧠 ribbon icon, or Ctrl+P → **Quiz this note** |
| ✂️ Quiz part of a note | Select text → Ctrl+P → **Quiz selected text** |
| ⚙️ Pick settings | Count (1–15), difficulty, optional **focus**, question types |
| 🚀 Start | **Generate** |
| 📚 Quiz several notes | Ctrl+P → **Quiz multiple notes** → search + tick notes, or select notes in the file explorer (Ctrl/Cmd+click) → right-click → **CertFS Quiz: quiz N notes** |
| 📁 Quiz a whole folder | Ctrl+P → **Quiz a folder** → pick it |
| 🔁 Re-quiz errors | ↺ ribbon icon, or Ctrl+P → **Quiz my errors** |
| 📦 Test the archive | Ctrl+P → **Test my archive** |

**Folder quiz:**
- 📚 Uses every note in the folder and its subfolders.
- 🚫 Skips `Errors/`, `Archive/`, `Mocks/` and files starting with `_` (Settings: **Folder quiz skips**).
- ⚖️ Each note gets a fair share of the 24,000-character limit.

**Multiple notes quiz:**
- ✅ The open note is ticked to start with; search by name or path, tick more.
- 📚 Same flow as a folder quiz: one request, questions spread across the notes.
- 🗂️ Subject = the one most picked notes belong to (errors go there).

**In the quiz:**
- 💡 **Hint** → a small push, not the answer.
- 🤷 **Not sure** → counts as a miss, so it gets reviewed.
- ✅ **Check** → right/wrong, the correct answer, and **why**.
- ✋ **I was right** → short answer graded wrong but you know it's right. Counts as correct, no error note.
- ➡️ **Next** → the next question.

**At the end:**
- 📊 Score % and the topics you missed.
- 👀 **Review missed** → each missed question with the right answer and why. No re-test.
- 🆕 **New questions on missed topics** → fresh questions, no repeats.

---

## 🧩 Question types

| Type | What you do |
|---|---|
| 🔘 Multiple choice | Pick 1 of 4 |
| 🎭 Scenario | A situation → pick the best action (1 of 4) |
| ☑️ Multi-select | Pick **all** correct options (exact set) |
| ⚖️ True / False | Pick one |
| ✍️ Short answer | Type it. The AI grades the **idea**, not the wording |
| 🔗 Matching | Match each term to its pair |

- 🎛️ Turn types on/off in Settings or in the quiz setup.
- 🔀 Options are shuffled every time.

---

## 🗂️ How it picks the subject

- 📁 The note's path is matched against each subject's **folder**.
- 🎯 Nested subjects: the **deepest** folder wins.
- 🧩 No match → **General** style, and mistakes are **not** saved.

| Subject setting | Used for |
|---|---|
| Name | `exam:` in error notes, the subject dropdown, stats |
| Folder | Which notes belong to it; errors go to `<folder>/Errors/` |
| Rules note | `**Rule:** → [[...]]` line in error notes (empty = no line) |
| Question style | Optional. Empty → the AI guesses the exam from name + folder. Fill it to steer wording, traps, scenario type |

Presets (default folders, edit them in Settings):

| Folder | Style | Rules link |
|---|---|---|
| `1 CSM/` | CSM (Scrum Guide 2020) | `Scrum Rules` |
| `2 PMP/` | PMP (PMI mindset) | `Mindset Rules` |
| `3 CPMAI/` | CPMAI | `CPMAI Rules` |

---

## ❌ Error notes (automatic)

- 📄 File: `<subject folder>/Errors/YYYY-MM-DD <topic>.md`.
- 🏷️ `Errors` and `Archive` names can be changed in Settings (old notes are not moved).
- 🧾 Same frontmatter as `99 Templates/Error.md`.
- 🏷️ `source: "CertFS Quiz (<note>)"`, `status: new`, `next_review` = tomorrow.
- 🏠 So it shows up in Home under errors to redo.
- 🔁 Same topic, same day, **different** question → added to the same note in full.
- 🔂 Same question again → one "wrong again" log line, and the review resets to tomorrow.
- 🚫 Turn off with **Save mistakes as error notes** in Settings.

---

## 🔁 Errors → Archive (mastery)

- 🆕 **Quiz my errors** writes a **new version** of each error. Same concept, new wording.
- 🚫 It never repeats a question: every version asked is logged in the note.
- 🎯 Types used: multiple choice, scenario, multi-select, true/false.
- 📅 Pick **Due today** or **All active**.
- 🔢 One new question per error. The count can't go above the errors found.

| Answer | What happens |
|---|---|
| ✅ Right, error was due | `streak` +1 → next check in **3** days, then **7** days (Settings: **Days between checks**) |
| ✅ Right, not due yet | ⚠️ Warning. Default: logged, **not counted**. Or **Count anyway** (+1), or red **Skip → archive** (asks twice) |
| ✅ 3rd right (`streak: 3`) | `status: mastered`, moved to `Errors/Archive/` (Settings: **Correct answers to master**, 1–10) |
| ❌ Wrong | `streak: 0`, `status: new`, again **tomorrow** |

- 📝 Misses are logged on the **same** error note. No new note.
- ⚙️ Setting **Count a correct answer**: only on due days (default) or any time.

**Test my archive:**
- 🆕 New version of each archived error.
- ✅ Right → 🗑️ **Delete** (to trash) or 📦 **Keep**.
- ❌ Wrong → back to active `Errors/`, `streak: 0`, again tomorrow.

---

## 📊 Answer history + stats

- 🧾 Every answer (right or wrong) → `history.json` in this folder.
- 🔢 Saved: date, subject, note, topic, question, right/wrong. Max **5,000** (oldest dropped).
- 🚫 A new quiz on the same note skips its last **40** questions.
- 📊 Ctrl+P → **Show my stats** → score per subject, last 7 days, 5 weakest topics.
- 📄 `<subject folder>/Stats.md` is **rewritten when a quiz ends**: score, last 7 days, errors due/active/archived, weakest topics, by quiz type.
- ⚙️ Settings → **Stats note** = file name (empty = off). Folder quiz skips it.
- ⚠️ Stats come from the history. **Keep answer history** off → Stats.md shows **⏸️ paused** and stops counting. Not a bug.
- ⚙️ Settings → **Keep answer history** (off = nothing saved) and **Clear history**.
- 💡 It is a history, not a question bank: questions are always new.

---

## 💸 Free limits (OpenRouter)

- ⏱️ **20** requests per minute.
- 📅 **50** requests per day (1000/day after buying $10 of credits once).
- 🧮 One quiz = **1** request (note, folder, errors or archive).
- ✍️ Each short-answer check = **+1** request.
- 🔁 Busy model (429/502/503) → it retries twice by itself (4s, then 8s).
- 🙈 A failed 429 may not show in OpenRouter **Logs**.
- 🔎 The error message shows OpenRouter's own reason.

---

## 🛠️ Errors and fixes

| Message says | Fix |
|---|---|
| Add your API key | Paste the key in Settings |
| Pick a model | **Load free models** → pick a `:free` one |
| 401 | Key is wrong or deleted → make a new key |
| 402 | Model isn't free → pick a `:free` model. Key's **credit limit** must be empty, not $0 |
| 404 | Model is gone → **Load free models** again |
| 429 | Free model busy upstream → pick **another** `:free` model. Or your limit → wait 1 min / tomorrow |
| Did not answer in 90 s | Free model stuck → try again, or pick another `:free` model |
| Response cut off | Ask for fewer questions |
| No usable questions | Try again, or pick another free model |
| Note too short | Note needs 80+ characters |

---

## 🔒 Privacy

- 📤 The note text (max **24,000** characters) is sent to OpenRouter and the chosen model.
- 🚫 Don't quiz notes with private data.
- 🔑 The key is stored in `data.json` in this folder, **unencrypted**.
- 🙈 `data.json` and `history.json` are gitignored, so they never go to GitHub.
- ☁️ iCloud still syncs it, so keep the key private.

---

## 📝 What's new

**0.3.5**
- 📚 New: **Quiz multiple notes**. Pick notes with search + checkboxes, or multi-select them in the file explorer and right-click.

**0.3.4**
- 🤖 Empty **Question style** → the AI infers the exam from the subject name + folder. Name + folder is enough to start.

**0.3.3**
- 🎨 Subject boxes get inner space, so their top edge is no longer cut off.

**0.3.2**
- 🎨 Settings → Subjects: the 3 boxes fill the row, and the **Question style** box is full width.

**0.3.1**
- 🔍 Settings → Subjects: the **Folder** and **Rules note** boxes **search the vault** as you type.
- 🆙 Needs Obsidian **1.4.10+**. On older versions they stay plain text boxes.

**0.3.0: generic and shareable**
- 📚 No hardcoded exams. **Subjects** (name, folder, rules note, style) are set in Settings.
- 🏃 On first run, the CSM, PMP and CPMAI presets are added, but only if their folder exists.
- ⚙️ In Settings now: **mastery count**, **days between checks**, Errors/Archive folder names, folder-quiz skips.
- 🧾 **Answer history** in `history.json`. A new quiz skips the note's last 40 questions.
- 📊 **Show my stats** command.
- 📄 `<subject>/Stats.md` is rewritten after each quiz.
- ⏸️ History off → Stats.md says **paused**. Not a bug.

**0.2.x**
- 👀 **Review missed** replaces Retry missed. It shows the right answers and does not re-test.
- ⏱️ A request stops after **90 s**, so it no longer hangs at "Generating".
- 🔘 Each question has its own option group, so a selection can't jump between questions.
- 📅 Quiz my errors shows **due vs active** counts.
- ⚠️ Not-due errors: **Count anyway** or red **Skip → archive**.
- 🔢 The question count is capped at the number of errors found.
- 📁 New: **Quiz a folder**, **Quiz my errors**, **Test my archive**, and the **I was right** button.

**0.1**
- 🧠 First version: note or selection quiz, 6 question types, hints, auto error notes.

---

## 🧑‍💻 For developers

- 📦 No build step: `main.js` (CommonJS), `manifest.json`, `styles.css`.
- 🌐 API: `https://openrouter.ai/api/v1/chat/completions` via Obsidian `requestUrl`.
- 📐 Asks for JSON (`response_format: json_object`). On 400 it retries without it.
- 🧪 Pure helpers are exported on `module.exports._test` for unit tests.
- 📚 Subjects live in `data.json` (`subjects: [{name, folder, rules, style}]`). Presets are in `PRESET_SUBJECTS`.
- ✅ Tested: helper unit tests (parse, normalize, grade, error notes, subjects, intervals, history) + a fake-vault flow.
- ⚠️ Not auto-tested: the UI and live OpenRouter calls.
