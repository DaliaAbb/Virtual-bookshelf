# Book Shelf

A small desktop app (Electron) for keeping track of what you read. Your books stand on a painted
bookcase, you time your reading sessions, and finished books move to an archive. It works offline and
keeps everything on your computer.

The app opens with a welcome page. Press **Enter** to step into the library.

---

## Run it

```bash
npm install     # first time only
npm run start
```

Requires [Node.js](https://nodejs.org). The window has no title bar (drag it by the top edge).
Closing it with the ✕ quits the app; your data is kept.

### Make a double-clickable app (macOS)

```bash
npm run package
```

This builds **Book Shelf.app** (Apple Silicon) with your icon and installs it in `~/Applications`, so you can
open it from Launchpad or the Dock like any other app. It is signed with a free local signature, which is enough
to run on the Mac that built it. If macOS asks, right-click the app and choose **Open** the first time.
Packaging needs an internet connection the first time (to fetch Electron).

---

## What it does

### The shelf (home screen)

- Your books stand as colored **spines** on a painted bookcase.
- **5 shelves**, each holds up to **15 books**. A row that is too full scrolls sideways; when a row is
  full, the next book goes onto the next shelf (more shelves appear when you need them).
- **Thicker books** (more pages) have wider spines.
- **Series stay together and in order** (by series number).
- A thin stripe on a spine shows how far you are in a book you are reading.
- **Hover** over a spine and a larger copy pops up with the book's whole name.
- **Search**: type part of a title, author or series; other books fade and the matches glow.
- **Day / night** (moon and sun button): two painted bookcases. The choice is remembered.
- A string of fairy lights hangs under every shelf.

### Adding and editing books

- **Add (+):** name, author, description, number of pages, series and its number, spine color.
- Tap a book to open its **info card**: description, pages, hours read, change its color, **Edit** any detail,
  **Start reading**, **Done ✓**, **Delete** (asks "Delete for good?" first).

### Shuffle

Can't decide what to read next? Shuffle picks a random book from the shelf.

- It respects series order: you only get book 2 if book 1 is finished.
- It is blocked while you already read 2 books.
- With an empty shelf it says "No books on your shelf. Add books first!".

### Currently reading

- Up to **2 books at a time**, whatever their thickness.
- Each book has its own **timer** (Start / Stop). When you stop, you can save the session and the page you
  reached, or discard it.
- Sessions are stored separately and **added on top of each other**: 40 min + 30 min = 1 h 10 min total.
- Forgot the timer? **+ Add time manually**: hours, minutes, the day, and the page reached.
- Reaching the last page offers **"Finished! Move to archive?"**
- You can also put a book back on the shelf, edit its info, or delete it.

### Finishing a book

- **Done ✓** or **Finish** opens "How was it?": give a **1-5 star rating** and write a **note or favorite quote**
  (both optional).
- The book dissolves into sparkles that fly to the Archive button, a chime plays, and a message offers to open
  the archive.

### Archive

- Finished books stand on the same painted bookcase, newest first.
- Tap one to see its rating and note (you can change both), the finish date and the hours read, or send it
  **Back to shelf**.

### Reading goal and stats

- Set a **yearly goal** (number of books). It starts fresh every 1 January and each year keeps its own goal
  (use ◀ ▶ to look at other years).
- A progress ring shows **X / goal**, with a "Goal reached! 🎉" when you get there.
- Stats for the year: **total hours**, **total pages**, **day streak**, **average time per book**, and a
  **books-per-month** chart.
- **Backup:** **Export** saves your whole library (books, sessions, ratings, notes, goals) to one
  `.json` file; **Import** restores one (after asking, since it replaces your current library).

---

## Where your data lives

Everything is stored in the app's local storage on your computer:

| Key                 | Holds                                 |
| ------------------- | ------------------------------------- |
| `bookshelf.books` | all books                             |
| `bookshelf.goals` | yearly goals, e.g. `{ "2026": 24 }` |
| `bookshelf.mode`  | `day` or `night`                  |

Use **Export** on the goal screen to keep a copy outside the app.

A book looks like this:

```js
{
  id, title, author, description, pages, currentPage, color,
  series, seriesIndex,
  status: 'shelf' | 'reading' | 'archived',
  sessions: [{ date, seconds }],   // total time = the sum of these
  timerStart, pendingSeconds,      // a running / unsaved timer
  addedAt, finishedAt,
  rating, note                     // set when the book is finished
}
```

---

## How it is built

Plain HTML, CSS and JavaScript inside Electron. No frameworks, no build step.

```
main.js        Electron: the window, the Dock icon, quit on close
package.sh     builds and installs the double-clickable app (`npm run package`)
index.html     the page: welcome screen, header, shelf, panel, toolbar, forms
styles.css     all the styling, with day and night colors as CSS variables
script.js      all the logic (books, timers, shelf, search, stats, backup, lights, sounds)
assets/icons/  your artwork: toolbar icons, app icon, moon and sun, shelf and welcome pictures
```

- The two painted bookcases (`day_shelf.png`, `night_shelf.png`) are the background. The book rows are laid
  over their painted shelves using measurements stored as CSS variables, so the picture is shown whole.
- Day and night only change colors and the picture; the buttons and cards follow through CSS variables.
- The finish sparkle is a small canvas animation; the chime is generated with the Web Audio API (no sound file).
- Opening the page with `?demo=1` fills it with sample books, kept apart from your real data (useful for
  screenshots). `?view=reading|archive|stats` picks a screen and `?mode=day|night` forces a mode.

## Ideas for later

- Look up a book's title, author and pages online when adding it.
- Reading-session history per book (see, edit or delete single sessions).
- "Not this one" in shuffle.
- Keyboard shortcuts.
