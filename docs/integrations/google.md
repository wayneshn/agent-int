# Google (Gmail, Calendar, Docs, Sheets, Drive, Forms, Workspace, Analytics)

Valmis has eight Google OAuth2 integrations. They all authenticate the same way — an OAuth client you create once in Google Cloud Console — but each requests only the scopes it needs:

| Integration          | What agents can do                                                                                             | Scopes requested                                                                                                            |
| -------------------- | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| **Gmail**            | Read, send, compose, label, and manage email                                                                   | `https://mail.google.com/`, `gmail.readonly`, `gmail.send`, `gmail.compose`, `gmail.insert`, `gmail.labels`, `gmail.modify` |
| **Google Calendar**  | Read, create, update, and delete events and calendars                                                          | `calendar`, `calendar.events`                                                                                               |
| **Google Docs**      | Read, write, and manage documents                                                                              | `documents`                                                                                                                 |
| **Google Sheets**    | Read, write, and manage spreadsheets                                                                           | `spreadsheets`                                                                                                              |
| **Google Drive**     | Browse and manage Drive files — **scopes editable**; powers the [knowledge base](/guide/knowledge-base) import | Your own list (default: `drive` — full read/write; use `drive.readonly` for read-only)                                      |
| **Google Forms**     | Read form responses — powers the [Google Forms app trigger](/integrations/triggers/google-forms)               | `forms.responses.readonly`                                                                                                  |
| **Google Workspace** | Any Google API — **you choose the scopes**                                                                     | Your own list (default: `drive.readonly`)                                                                                   |
| **Google Analytics** | Query GA4 — run reports (Data API) and list accounts/properties (Admin API); has its own page: [Google Analytics](/integrations/google-analytics) | `analytics.readonly`                                                            |

All of them also request `openid email` (your identity) and offline access (`access_type=offline`, `prompt=consent`) so the credential keeps working without re-authorizing.

::: tip One Cloud project can serve all of them
You can create a **single Google Cloud project and OAuth client** and reuse its Client ID/Secret for every Google credential in Valmis. Enable all the APIs you'll use and add all their scopes to the consent screen — each Valmis integration still only requests its own scopes during authorization, so a Calendar credential never gets Gmail access. Or create separate projects per product if you prefer strict separation.
:::

## What you need (every Google integration)

| Field         | Required               | Notes                                                                                                                                                           |
| ------------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Client ID     | Yes                    | OAuth2 Client ID from Google Cloud Console                                                                                                                      |
| Client Secret | Yes                    | Secret — OAuth2 Client Secret from Google Cloud Console                                                                                                         |
| Scopes        | Drive & Workspace only | Space-separated Google scope list ([reference](https://developers.google.com/identity/protocols/oauth2/scopes)). The other four integrations have fixed scopes. |

## Step 1 — Create a Google Cloud project

1. Open [console.cloud.google.com](https://console.cloud.google.com/) and sign in.
2. Click the project picker in the top bar → **New Project**.
3. Name it (e.g. "Valmis") and create it. Make sure it stays selected for all following steps.

## Step 2 — Enable the APIs

1. Go to **APIs & Services → Library**.
2. Search for and **Enable** each API you plan to use:
   - **Gmail API** (for Gmail)
   - **Google Calendar API** (for Calendar)
   - **Google Docs API** (for Docs)
   - **Google Sheets API** (for Sheets)
   - **Google Drive API** (for Google Drive — including knowledge base imports)
   - **Google Forms API** (for the Google Forms app trigger)
   - **Google Analytics Data API** and **Google Analytics Admin API** (for Google Analytics / GA4)
   - For the Workspace integration: whatever APIs your scopes belong to (e.g. **Google Drive API** for Drive scopes)

Calls to an API that isn't enabled fail even when the scope was granted — enabling the API and granting the scope are two separate things.

## Step 3 — Configure the OAuth consent screen

1. Go to **APIs & Services → OAuth consent screen** (Google also calls this _Google Auth Platform_).
2. Choose user type **External** (unless all users are in your own Google Workspace organization — then **Internal** is simpler, with no verification or test-user limits).
3. Fill in the app name and the required contact email addresses.
4. **Add scopes**: in the scopes/data-access step, click **Add or remove scopes** and add every scope from the table at the top of this page that your integrations will request. Gmail's full-access scope is a _restricted_ scope and Calendar/Docs/Sheets scopes are _sensitive_ — that's fine in testing mode (next step), but a published app using them requires Google's verification process.
5. **Add test users**: while the app's publishing status is **Testing**, only listed test users can authorize. Add the Google account(s) whose data the agents should access.
6. Save.

::: warning Testing mode: tokens expire after 7 days
While the consent screen is in _Testing_ status, Google expires refresh tokens after 7 days — you'll have to click **Re-authorize** on the credential weekly. For long-running self-hosted use, either publish the app (Gmail's restricted scope then requires verification) or accept the weekly re-authorization.
:::

## Step 4 — Create the OAuth client

1. Go to **APIs & Services → Credentials → Create credentials → OAuth client ID**.
2. Application type: **Web application**.
3. Under **Authorized redirect URIs**, add the URI shown on the Valmis credential form:

   ```
   <APP_URL>/oauth2/callback
   ```

   It must match your deployment's `APP_URL` exactly (scheme, host, port).

4. Create the client and copy the **Client ID** and **Client Secret**.

## Step 5 — Create the credential in Valmis

1. **Credentials → Add credential** → pick the Google integration you want (Gmail, Google Calendar, Google Docs, Google Sheets, Google Drive, Google Workspace, or Google Analytics).
2. Paste the **Client ID** and **Client Secret**. The same pair can be reused across all eight integrations.
3. Drive and Workspace integrations only: set the space-separated scope list. Grant the narrowest scopes that cover the task (e.g. `https://www.googleapis.com/auth/drive.readonly` instead of full `drive` if agents only read files), and make sure each one was added to the consent screen in Step 3.
4. Save, then click **Authorize** and grant access with the Google account you added as a test user.

::: warning Gmail grants full mailbox access
The Gmail integration requests full Gmail scopes — an agent holding it can read, send, and delete mail in the authorized account. Attach it only to agents you trust, and consider a dedicated mailbox for automation.
:::

## App triggers

A Gmail credential can fire a workflow when a **new email arrives**, and a Google Forms credential can fire one when a **new response is submitted** — both by polling, so no external setup is required. The label / form-id parameters and payload shapes live on the dedicated trigger pages:

- [Gmail app trigger](/integrations/triggers/gmail) — polls for new mail; `gmail.readonly` is enough for the trigger.
- [Google Forms app trigger](/integrations/triggers/google-forms) — create the credential like the others above (same OAuth client; **enable the Google Forms API** in Step 2), then point the trigger at a form id.
