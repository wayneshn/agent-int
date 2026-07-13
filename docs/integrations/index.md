# Integrations

Valmis ships with ready-made credential definitions for the services below. Each page explains what the integration does, which credentials it needs, and **exactly where to find them** on the service's website.

To use any of them: **Credentials → Add credential**, pick the service, fill in the fields, then attach the credential to an agent. See the [credentials guide](/guide/credentials) for concepts like testing, OAuth2 authorization, and revocation.

::: tip OAuth2 redirect URI
Every OAuth2 integration requires registering the same redirect URI in the provider's console: `<APP_URL>/oauth2/callback`. The credential form shows it with a copy button.
:::

## App triggers

Some integrations can also **start a [workflow](/guide/workflows/)** when something happens in the app — a new email, a database change, a form response, a chat message. See [App Triggers](/integrations/triggers/) for the full list, or jump to one:

| Trigger                                             | Fires on                         | Delivery |
| --------------------------------------------------- | -------------------------------- | -------- |
| [Gmail](/integrations/triggers/gmail)               | New email received               | Push     |
| [Google Forms](/integrations/triggers/google-forms) | New form response                | Polling  |
| [Notion](/integrations/triggers/notion)             | Database item created or updated | Push     |
| [Slack](/integrations/triggers/slack)               | New message                      | Push     |

## Communication & bots

| Service                                                   | Auth method              |
| --------------------------------------------------------- | ------------------------ |
| [Discord Bot](/integrations/discord-bot)                  | Bot token                |
| [Gmail](/integrations/google)                             | OAuth2 (Google)          |
| [Microsoft Outlook](/integrations/microsoft-outlook)      | OAuth2 (Azure AD)        |
| [Microsoft Teams](/integrations/microsoft-teams)          | OAuth2 (Azure AD)        |
| [Pushover](/integrations/pushover)                        | API token + user key     |
| [Slack](/integrations/slack)                              | OAuth2                   |
| [Telegram Bot](/integrations/telegram-bot)                | Bot token                |
| [Twilio](/integrations/twilio)                            | Account SID + Auth Token |
| [WhatsApp Business Cloud](/integrations/whatsapp-business) | Access token             |

## Customer support & CRM

| Service                                        | Auth method                 |
| ---------------------------------------------- | --------------------------- |
| [ActiveCampaign](/integrations/activecampaign) | API key + account base URL  |
| [Apollo.io](/integrations/apollo)              | API key                     |
| [Freshdesk](/integrations/freshdesk)           | API key (Basic Auth)        |
| [Front](/integrations/front)                   | API token                   |
| [Gorgias](/integrations/gorgias)               | Email + API key (Basic Auth)|
| [Help Scout](/integrations/helpscout)          | OAuth2 (client credentials) |
| [Hunter.io](/integrations/hunter)              | API key                     |
| [Intercom](/integrations/intercom)             | Access token                |
| [Pipedrive](/integrations/pipedrive)           | API token                   |
| [Salesforce](/integrations/salesforce)         | OAuth2                      |
| [Zendesk](/integrations/zendesk)               | Email + API token           |

## Email & marketing

| Service                                  | Auth method                   |
| ---------------------------------------- | ----------------------------- |
| [Brevo](/integrations/brevo)             | API key                       |
| [Customer.io](/integrations/customer-io) | App API key + region          |
| [Klaviyo](/integrations/klaviyo)         | Private API key               |
| [Mailchimp](/integrations/mailchimp)     | API key + datacenter          |
| [Mailgun](/integrations/mailgun)         | API key (Basic Auth) + region |
| [OneSignal](/integrations/onesignal)     | API key                       |
| [Postmark](/integrations/postmark)       | Server API token              |
| [Resend](/integrations/resend)           | API key                       |
| [SendGrid](/integrations/sendgrid)       | API key                       |

## Analytics

| Service                                            | Auth method                    |
| -------------------------------------------------- | ------------------------------ |
| [Amplitude](/integrations/amplitude)               | API key + secret (Basic Auth)  |
| [Google Analytics (GA4)](/integrations/google-analytics) | OAuth2 (Google)          |
| [PostHog](/integrations/posthog)                   | Personal API key + region      |

## Productivity & docs

| Service                                                | Auth method                     |
| ------------------------------------------------------ | ------------------------------- |
| [Airtable](/integrations/airtable)                     | Personal access token or OAuth2 |
| [Asana](/integrations/asana)                           | Personal access token           |
| [Cal.com](/integrations/cal-com)                       | API key                         |
| [Calendly](/integrations/calendly)                     | Personal access token           |
| [Canva](/integrations/canva)                           | OAuth2                          |
| [ClickUp](/integrations/clickup)                       | Personal API token              |
| [Coda](/integrations/coda)                             | API token                       |
| [Confluence](/integrations/confluence)                 | Email + API token               |
| [Dropbox](/integrations/dropbox)                       | Access token                    |
| [Google Calendar](/integrations/google)                | OAuth2 (Google)                 |
| [Google Docs](/integrations/google)                    | OAuth2 (Google)                 |
| [Google Drive](/integrations/google)                   | OAuth2 (Google, custom scopes)  |
| [Google Forms](/integrations/google)                   | OAuth2 (Google)                 |
| [Google Sheets](/integrations/google)                  | OAuth2 (Google)                 |
| [Google Workspace](/integrations/google)               | OAuth2 (Google, custom scopes)  |
| [Jira](/integrations/jira)                             | Email + API token               |
| [Linear](/integrations/linear)                         | Personal API key                |
| [Microsoft OneDrive](/integrations/microsoft-onedrive) | OAuth2 (Azure AD)               |
| [monday.com](/integrations/monday)                     | API token                       |
| [Notion](/integrations/notion)                         | Integration token or OAuth2     |
| [Productboard](/integrations/productboard)             | Access token                    |
| [Smartsheet](/integrations/smartsheet)                 | API access token                |
| [Tally](/integrations/tally)                           | API key                         |
| [Todoist](/integrations/todoist)                       | API token                       |
| [Toggl Track](/integrations/toggl)                     | API token (Basic Auth)          |
| [Trello](/integrations/trello)                         | API key + token                 |

## Content, CMS & forms

| Service                                  | Auth method                       |
| ---------------------------------------- | --------------------------------- |
| [Contentful](/integrations/contentful)   | CMA token + space                 |
| [Directus](/integrations/directus)       | Static token                      |
| [Ghost](/integrations/ghost)             | Content API key                   |
| [Sanity](/integrations/sanity)           | API token + project               |
| [Storyblok](/integrations/storyblok)     | Personal access token + region    |
| [Strapi](/integrations/strapi)           | API token                         |
| [Typeform](/integrations/typeform)       | Personal access token             |
| [Webflow](/integrations/webflow)         | API token                         |
| [WordPress](/integrations/wordpress)     | Username + application password   |

## Design & collaboration

| Service                          | Auth method                     |
| -------------------------------- | ------------------------------- |
| [Figma](/integrations/figma)     | Personal access token or OAuth2 |
| [Miro](/integrations/miro)       | Access token                    |

## Business & commerce

| Service                                | Auth method             |
| -------------------------------------- | ----------------------- |
| [BigCommerce](/integrations/bigcommerce) | Store API token       |
| [HubSpot](/integrations/hubspot)       | Service key or OAuth2   |
| [Shopify](/integrations/shopify)       | Custom app access token |
| [Square](/integrations/square)         | Access token            |
| [Stripe](/integrations/stripe)         | Secret key              |
| [WooCommerce](/integrations/woocommerce) | Consumer key + secret (Basic Auth) |

## Finance, billing & payments

| Service                                    | Auth method                  |
| ------------------------------------------ | ---------------------------- |
| [Chargebee](/integrations/chargebee)       | API key (Basic Auth) + site  |
| [GoCardless](/integrations/gocardless)     | Access token                 |
| [Lemon Squeezy](/integrations/lemon-squeezy) | API key                    |
| [Mollie](/integrations/mollie)             | API key                      |
| [Paddle](/integrations/paddle)             | API key                      |
| [QuickBooks Online](/integrations/quickbooks) | OAuth2                    |
| [Razorpay](/integrations/razorpay)         | Key ID + secret (Basic Auth) |
| [Wise](/integrations/wise)                 | API token                    |
| [Xero](/integrations/xero)                 | OAuth2                       |

## Developer & data

| Service                                      | Auth method                    |
| -------------------------------------------- | ------------------------------ |
| [Algolia](/integrations/algolia)             | App ID + API key               |
| [Alpha Vantage](/integrations/alpha-vantage) | API key                        |
| [Cloudflare](/integrations/cloudflare)       | API token                      |
| [GitHub](/integrations/github)               | Personal access token          |
| [Google Maps](/integrations/google-maps)     | API key                        |
| [Meilisearch](/integrations/meilisearch)     | API key + host                 |
| [Pinecone](/integrations/pinecone)           | API key                        |
| [SEMrush](/integrations/semrush)             | API key                        |
| [SerpApi](/integrations/serpapi)             | API key                        |
| [Supabase](/integrations/supabase)           | Project URL + service role key |

## AI & voice

| Service                                | Auth method |
| -------------------------------------- | ----------- |
| [ElevenLabs](/integrations/elevenlabs) | API key     |

## Social & web

| Service                                        | Auth method |
| ---------------------------------------------- | ----------- |
| [Buffer](/integrations/buffer)                 | API key     |
| [OpenWeatherMap](/integrations/openweathermap) | API key     |
| [Reddit](/integrations/reddit)                 | OAuth2      |

## Smart home & generic

| Service                                        | Auth method                               |
| ---------------------------------------------- | ----------------------------------------- |
| [Home Assistant](/integrations/home-assistant) | Long-lived access token                   |
| [Generic HTTP Auth](/integrations/http)        | Basic / Bearer / header / query parameter |

## A service isn't listed?

Two options:

- Use the [generic HTTP credentials](/integrations/http) — most APIs accept a Bearer token, a custom header, or a query-parameter key.
- Integrations are defined as single YAML files in the source tree (`packages/utils/src/integrations/definitions/`); adding a new service requires no code changes. Contributions welcome.
