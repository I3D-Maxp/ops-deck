# Ops Deck Jira

## Run locally

1. Install Node.js 18 or newer.
2. Copy `.env.example` to `.env`.
3. Fill in `JIRA_EMAIL` and `JIRA_API_TOKEN` in `.env`.
4. In this folder, run:

```bash
npm install
npm start
```

5. Open `http://localhost:3000`.

## Import a ticket
Paste a Jira issue key such as `ITSM-75363`, or a full Jira ticket URL, then select **Import from Jira**.

## Security
- `.env` is excluded from source control.
- Jira credentials are read only by the local Node.js backend.
- Do not put API tokens in `public/app.js` or any browser file.

## Custom fields
Jira custom fields vary by tenant. The current front end attempts to find fields by readable names returned by Jira. If location, rack, unit, service tag, or request type displays `Not found`, inspect the API response and map your tenant's `customfield_XXXXX` IDs in `normalise()` in `public/app.js`.
