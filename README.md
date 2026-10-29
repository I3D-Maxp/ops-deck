# Aether Desk 1.0

A personal Jira workspace for datacenter operations. Load a ticket, find the useful tools, keep work coordinates handy, and reply or add internal notes without leaving the desk.

Version **1.0.0** is the first release checkpoint. See [CHANGELOG.md](CHANGELOG.md) for the frozen scope.

## Start on Windows

Use Node.js **22 or newer**. This release was verified with Node.js **24.22.1**.

1. Copy .env.example to .env and fill in JIRA_BASE_URL, JIRA_EMAIL, and JIRA_API_TOKEN.
2. Double-click **Start Aether Desk.cmd**. It installs missing dependencies on first launch and opens the app in your default browser.
3. Keep the launcher window open while working. Close it or press Ctrl+C to stop the server.

The default address is http://localhost:3000. Set PORT in .env to use another port. Running the launcher again opens the existing server. Start Ops Deck.cmd remains a compatibility shortcut. Pasted ticket text works without Jira credentials.

From a terminal:

    npm ci
    npm start

The app binds to 127.0.0.1. It is intended for your own computer, with the permissions of your configured Jira account.

## Ticket workflow

- Enter a ticket key or URL in **Open ticket**, or expand **Paste ticket text instead**.
- **Ticket details** shows the problem, status, coordinates, and attachments. More details and Sync options keep supporting information out of the way.
- Tickets refresh every 60 seconds while active and when returning to the app. Refresh ticket is also available under More actions. Drafts and unfinished inputs are preserved.
- The four coordinate squares are local copy/paste fields, saved separately for each ticket. Editing them sends nothing to Jira. **Post coordinates as work note** sends all four values in one internal comment.
- More actions > Edit Jira coordinate fields opens the advanced field editor. Its optional internal-note toggle starts off.
- Click the status badge to review an available Jira transition. Actions requiring extra workflow fields must be completed in Jira.

## Conversation

One movable module combines activity and the composer.

The three newest loaded comments appear as expandable previews with author, date, and visibility. Use View history, Load more history, or the activity filter to see more.

Customer reply and Internal note have separate drafts and explicit Public/Internal badges. Greeting + thank you uses the ticket reporter's name. The ellipsis menu contains Copy and Insert template. **Review & send** shows the exact ticket, audience, and message before you post.

Successful posts keep the draft and remember its receipt. Unchanged successful messages cannot be posted again until edited. An uncertain write is reported for you to check in Jira before retrying.

## Queues and shortcuts

The sidebar contains three live queues from dashboard 12754:

| Queue | Gadget | Saved filter at release |
| --- | --- | --- |
| Live queue | 59715 | 20741 |
| My tickets | 59711 | 20746 |
| Hardware alerts | 59736 | 20828 |

The app reads each gadget's current saved filter and follows its query and ordering. Queues refresh every 60 seconds while open and visible. Load more follows Jira's pagination; counts describe loaded rows and show a plus sign when more are available.

Click a row to open its ticket. Assign to me uses your configured Jira identity, checks the current assignee, verifies the update, and refreshes the queue. It refuses tickets already assigned to someone else. Search indexing can briefly delay queue membership changes. Refresh failures retain the last loaded rows with a message.

Tools include i3D Admin, MASS server, NetBox, OPS Wiki, Sites Information, and QA. Matching ticket keywords highlight suggested tools using local rules. Links open in your browser and use that site's browser login; Aether Desk does not sign into Admin for you.

## Arrange the desk and save tickets

Drag each module by its title bar. Modules can overlap; clicking one raises it. Use Show module to reveal a covered module, or Reset layout to restore the defaults. Minus minimizes a module; plus restores it. Arrow keys move a focused handle, with Shift for one-pixel movement.

Save a ticket in the right panel with your own label. Selecting a saved tab restores its snapshot and drafts. Removing a tab preserves its drafts. The chevron retracts the right panel and brings it back; that preference is remembered in this browser.

## Sessions and backups

Tabs, labels, active ticket, ticket snapshots, separate drafts, coordinates, tools, inputs, module positions, and minimized states save automatically.

Browser storage saves immediately. A local disk copy follows in .data/session.json, with a previous recovery copy. Check the SESSION indicator for Saved on this computer before shutting down, or choose Save now.

Export backup downloads a portable JSON file. Restore backup validates it and asks you to review before replacing the workspace; recovery copies are kept. Backups contain ticket text and notes. They contain neither .env nor Jira credentials.

The disk session protects ordinary closes and restarts. Export a backup to protect against losing the computer or project folder. Module layouts from before Conversation are migrated on restore.

## Attachments and screenshots

Attachments appears below Problem. It lists filenames, sizes, and uploader names. Open displays images, PDFs, or plain text in a new tab; other formats download. Download saves the original file. Files stream through the local Jira connection after a fresh ticket-membership check. Older snapshots need Refresh ticket to populate the list.

Screenshot on the Ticket details title bar captures only that panel, with its current values and expanded/collapsed sections. PNGs save directly to **Screenshots** in the project folder, with a ticket key, timestamp, and unique suffix. The image goes only to the local server. Capture reconstructs the DOM, so some styling can differ slightly from a native screenshot.

## Personal touches

The name banner has aether currents and a duck that walks, turns, eats, rests, jumps, flies briefly, and naps. The duck is confined to the banner and pauses while the tab is hidden.

Below Add tool, six character clips rotate through standby/attack pairs. Each plays for five minutes with a charge bar. Click the character, or focus it and press Enter/Space, to advance and reset the timer. Attack frames play in reverse. Reduced-motion preferences use still poses and suppress decorative motion.

See [THIRD_PARTY.md](THIRD_PARTY.md) for bundled assets and library credits.

## Local files and source control

- .env: private Jira configuration; excluded from Git.
- .data: sessions, recovery files, and logs; excluded from Git.
- Screenshots: local PNG captures; excluded from Git.
- node_modules: installed dependencies; excluded from Git.
- animations: the supplied character and duck sheets used by this version.

Credentials stay on the Node.js backend. Keep the application local; version 1.0 is not a multi-user deployment.

## Validation and release checkpoint

Run the automated suite with:

    npm test

Version 1.0.0 passes **87 tests**, covering Jira reads and writes with mocked APIs, visibility and permission handling, queue pagination, session recovery, drafts, attachments, screenshot saving, and animation timing/bounds.

Live read-only queue and attachment checks and a temporary local PNG-saving check were also completed during development. Automated tests do not post to live Jira. Browser visual verification was unavailable in the agent environment; appearance and actual screenshot rendering have been reviewed through your usage.

The annotated Git tag **v1.0.0** identifies this checkpoint. Future work should use later commits so this version remains recoverable. A release tag contains source and bundled assets, not private configuration, sessions, screenshots, or installed dependencies.