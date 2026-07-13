# Wise

Lets agents work with the [Wise](https://wise.com) (formerly TransferWise) API — profiles, balances, recipients, quotes, and transfers. Authenticates with a personal API token sent as a Bearer token, and works against either the Live or the Test (Sandbox) environment.

[Wise API documentation](https://docs.wise.com/api-docs)

## What you need

| Field       | Required | Notes                                                                             |
| ----------- | -------- | --------------------------------------------------------------------------------- |
| API Token   | Yes      | Secret — a personal API token from your Wise account.                             |
| Environment | Yes      | **Live** for a normal Wise account, or **Test** for a sandbox account.            |
| Private Key | No       | Secret — a PEM RSA private key, only needed for endpoints requiring SCA (below).  |

The token must match the environment: a sandbox token only works with **Test**, and a live token only works with **Live**.

## Getting your token

1. Sign in to Wise and open your **user menu → Settings → API tokens**.
2. Generate an API token and copy it.
3. In the credential form, paste the token, choose your **Environment**, and save.

::: tip Which environment?
If you're using a Wise test sandbox account, choose **Test**. Otherwise choose **Live**. The agent is told which base host to call, so it uses the right one automatically.
:::

## Strong Customer Authentication (SCA)

Wise protects some live endpoints (typically money movement) with Strong Customer Authentication. A request to such an endpoint returns **HTTP 403** with an `x-2fa-approval` challenge until you register a key pair.

To enable these endpoints:

1. Generate an RSA key pair:
   ```bash
   openssl genrsa -out private.pem 2048
   openssl rsa -pubout -in private.pem -out public.pem
   ```
2. Add the **public** key (`public.pem`) to Wise under **Settings → API tokens → Manage public keys**.
3. Paste the **private** key (`private.pem`) into the **Private Key** field of the credential.

Valmis then signs the challenge and retries the request automatically. The private key stays encrypted on the server and is never exposed to the agent.

::: warning
Until a private key is added, endpoints that require SCA return a 403 explaining that a key pair is needed. Read-only calls (profiles, balances, recipients, quotes) do not require SCA.
:::
