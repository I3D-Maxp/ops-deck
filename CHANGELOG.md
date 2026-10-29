# Changelog

## 1.0.0 - 2026-10-29

First Aether Desk release checkpoint.

### Included

- Windows double-click launcher and local-only Node.js server.
- Compact Jira key/URL input, pasted ticket import, opening feedback, and live refresh.
- Draggable, overlapping, independently minimized modules with saved layouts.
- Editable local work-coordinate squares and an explicit internal-note action.
- Advanced Jira coordinate edits with optional audit notes and reviewed status transitions.
- Consolidated Conversation with recent activity, history, filters, separate public/internal drafts, greeting shortcut, inline posting review, and send receipts.
- Live queue, My tickets, and Hardware alerts, following saved dashboard filters.
- Self-assignment from unassigned queue rows with identity resolution and result verification.
- Named ticket tabs, retractable right panel, browser/disk session recovery, and portable backups.
- Authenticated attachment viewing/downloads and saved attachment metadata.
- Ticket-panel PNG capture saved in the local Screenshots folder.
- Suggested tool shortcuts, including MASS server.
- Manrope typography, aether effects, a confined banner duck, and six clickable five-minute character animations.

### Verification

- 87 automated tests pass on Node.js 24.22.1.
- JavaScript syntax and Git whitespace checks pass.
- Live read-only Jira queue/attachment checks and local screenshot-file saving were verified during development.
- Browser visual automation was unavailable. Actual PNG rendering remains subject to the bundled DOM capture library's styling limitations.

### Scope and limits

- Personal local application using one configured Jira account.
- No automatic i3D Admin login or embedded server lookup integration.
- Queue membership may briefly lag Jira writes because of search indexing.
- Attachment contents are fetched on demand, not included in session backups.
- .env, ticket sessions, screenshots, logs, and dependencies are excluded from source control.
- Supplied game artwork remains third-party material; this checkpoint is for personal use.