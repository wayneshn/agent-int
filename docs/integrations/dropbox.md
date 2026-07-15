# Dropbox

Lets agents work with files in your Dropbox, and powers the [knowledge base](/guide/knowledge-base) cloud import. Two credential variants — an **access token** for a single account, or **OAuth2** for production / multi-user access.

[Dropbox OAuth guide](https://developers.dropbox.com/oauth-guide)

Both variants share an **App Access Type**: **App Folder** grants access only to a folder named after your app; **Full Dropbox** grants access to the user's entire Dropbox. Set it to the same value you chose when creating the app.

## Option 1: Access Token (recommended for a single account)

**Credential type:** Dropbox (Access Token) — sent as a Bearer token.

| Field           | Required | Notes                                        |
| --------------- | -------- | -------------------------------------------- |
| Access Token    | Yes      | Secret                                       |
| App Access Type | Yes      | **App Folder** (default) or **Full Dropbox** |

### Getting your access token

1. Open the [Dropbox App Console](https://www.dropbox.com/developers/apps) and create an app (or open an existing one). Choose **Scoped access** and the access type (**App Folder** or **Full Dropbox**).
2. On the **Permissions** tab, enable the scopes the agent needs (e.g. `files.content.read`, `files.content.write`), then save.
3. On the **Settings** tab, under **OAuth 2 → Generated access token**, click **Generate**.
4. Copy the token into the credential form and set **App Access Type** to the same value you chose in step 1.

::: warning Token lifetime
Dropbox has moved to short-lived access tokens by default. A generated token may expire after a few hours depending on your app settings — if API calls start failing with 401, generate a fresh token and update the credential, or use OAuth2 (below), which refreshes automatically.
:::

## Option 2: OAuth2 (production / multi-user)

**Credential type:** Dropbox (OAuth2) — the platform runs the authorization flow and refreshes the token automatically.

| Field           | Required | Notes                                                              |
| --------------- | -------- | ------------------------------------------------------------------ |
| App Key         | Yes      | The app's **App key** (Client ID)                                  |
| App Secret      | Yes      | Secret — the app's **App secret** (Client Secret)                  |
| Scopes          | Yes      | Space-separated; each must be enabled on the app's Permissions tab |
| App Access Type | Yes      | **App Folder** (default) or **Full Dropbox**                       |

### Setting it up

1. In the [Dropbox App Console](https://www.dropbox.com/developers/apps), create a **Scoped access** app and choose the access type.
2. On the **Permissions** tab, enable the scopes you list in the credential's **Scopes** field, then save.
3. On the **Settings** tab, add the redirect URI from the credential form (`<APP_URL>/oauth2/callback`) under **OAuth 2 → Redirect URIs**.
4. Copy the **App key** and **App secret** into the credential form, set the scopes and **App Access Type**, save, then click **Authorize** and approve access.

::: tip Refresh tokens
The platform requests `token_access_type=offline`, so Dropbox returns a refresh token and the connection keeps working without re-authorizing. Make sure every scope in the **Scopes** field is enabled on the app, or authorization fails.
:::
