# CSP Sprint Board — Setup

Two pieces: **index.html** (the board, hosted on GitHub Pages) and **Code.gs** (the Google Sheet backend that saves boards, stamps dates, sends emails, runs the teacher view, makes review groups, and exports to Canvas). Use a new Sheet, separate from the SDD board.

## 1. Google Sheet + Apps Script

1. Create a new Google Sheet, e.g. "CSP Sprint Board 2026".
2. **Extensions > Apps Script**. Delete the starter code, paste all of `Code.gs`, and save.
3. At the top of `Code.gs`, set `TEACHER_EMAIL` to your district address. This is where snapshots go, and it's the email you sign in with for the teacher view.
4. Reload the Sheet. A **CSP Sprint Board** menu appears. Run **Set up tabs** and approve the permissions prompt.
5. Run **CSP Sprint Board > Set teacher passcode** and choose a passcode (6+ characters).
6. Paste both classes into the **Roster** tab: `Period | First | Last | Email`. Emails must be the 9-digit ID + `@lbschools.net`. Your Canvas roster export is the easiest source.

## 2. Deploy the backend

1. In Apps Script: **Deploy > New deployment > Web app**.
2. Execute as: **Me**. Who has access: **Anyone**.
3. Copy the URL that ends in `/exec`.

After any change to `Code.gs`: **Deploy > Manage deployments > pencil > Version: New version > Deploy**. The URL stays the same. Skipping this means your change doesn't take effect.

## 3. Publish the board

1. Open `index.html` and paste the `/exec` URL into `const API_URL = '';` near the top of the script.
2. Push `index.html` to a repo in your neutral GitHub organization and turn on GitHub Pages.
3. Optional: put the Pages link in `BOARD_URL` in `Code.gs` (and redeploy) so emails include it.

With `API_URL` left empty, the page runs in preview mode: fully clickable, nothing saved, no emails. Preview mode accepts any teacher-style email and any passcode, so you can try the teacher view before setup.

## Teacher view

On the board's sign-in screen, type your teacher email. A passcode box appears. Enter your passcode and click **Open teacher view**.

- **Class list.** Every student on the Roster, plus anyone with a board who isn't on it. Columns: partner, status, start and finish dates, days, cards done, Create PT checklist, Retro Actions done (like "2 of 3"), and last update. Click any column heading to sort.
- **Status filters.** Not opened, Not started, In progress, Finished, and **Quiet 5+ days**, which flags in-progress boards with no saves for 5 or more days. Change `QUIET_DAYS` in `index.html` to adjust.
- **Period filter and search** by name or student ID.
- **View** opens any student's board read-only. Nothing can be changed from the teacher view.
- **Back to class list** returns you; **Sign out** clears the passcode from the page.

The passcode is checked by the server on every request. After 5 wrong tries, the teacher view locks for 10 minutes. To change the passcode, run **Set teacher passcode** again. No redeploy needed.

## Demo account

The demo account is `000000000@lbschools.net` (set `DEMO_EMAIL` in `Code.gs` to change it). It works like a student board, with these differences:

- It isn't on the Roster and doesn't need to be.
- Name prefills as Demo Student, and the partner list shows Sample Partner A, B, and C, so real student names never appear on the projector.
- Commit update and Finish sprint email you only, with DEMO in the subject. They aren't written to the CommitLog.
- It's left out of Check partners, review groups, and the Canvas export.
- It doesn't show up in the class list; it has its own line above it.

**To demo in class:** type `000000000@lbschools.net` on the sign-in screen, the same way students will. That keeps the class list and its data off the projector. You can also open it from the teacher view with **Open demo board**.

**To start fresh:** click **Clear demo board** in the teacher view, or run **CSP Sprint Board > Reset demo board** in the Sheet.

Students who watched the demo could type the demo email themselves. Nothing they do there touches real data, and clearing it takes one click.

## How the rules work

- **Email check.** The page and the server both require exactly 9 digits + `@lbschools.net` for students. When the Roster tab has students, the server also rejects emails that aren't on it, which catches mistyped IDs.
- **Name and period.** Prefilled from the Roster; students confirm them.
- **Partner.** Chosen from a list of both classes, or "No partner, working solo." The page never receives classmates' email addresses.
- **Start date.** Stamped when the student's info is complete and they add their first Sprint Goal.
- **End date.** Stamped only when every goal has a card, every card is in Done, and the student clicks **Finish sprint**. Moving a card out of Done clears it.
- **Days.** Calendar days from start to finish, counting both days.

## Teacher menu (in the Sheet)

- **Set teacher passcode** sets or changes the teacher view passcode.
- **Check partners** lists mismatches (A picked B, but B picked C) in the PartnerFlags tab.
- **Make review groups** asks whether to group finished students only or everyone who has started. It builds trios across both classes, never puts partners together, and spreads out coverage of the Create PT checklist. Leftovers become groups of 4. The Reviews columns show which two projects each student reviews. Edit the Group column by hand if you want to swap anyone.
- **Export groups for Canvas** saves a CSV to your Drive: `name, login_id, group_name`.
- **Reset demo board** clears the demo account.

## Canvas import check

Canvas matches students by ID, and districts set this up differently. Before the real import, test it with one small group:

1. In Canvas, export an existing group set (or look at a student's Login ID in People) to see whether it uses the full email or just the 9 digits.
2. Match `CANVAS_ID_COLUMN` and `CANVAS_ID_VALUE` in `Code.gs` to what you see, then redeploy.
3. In Canvas: **People > Groups > + Group Set**, then import the CSV into it.

## One limitation

Students open their board by typing their email, not with a password. A student who knows a classmate's 9-digit ID could open that board. The CommitLog tab records every update and finish, so changes are traceable.
