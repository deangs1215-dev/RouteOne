# Outgoing email via Microsoft 365 — setup for your M365/Azure admin

RouteOne sends outgoing mail (order emails to telesales, order/quote
confirmations to customers, technical form notifications) through **Microsoft
Graph's application-permission `/sendMail` endpoint**, not plain SMTP.

This is the path Microsoft recommends for Exchange Online today: Basic Auth
for SMTP AUTH (plain username/password) is disabled tenant-wide by default on
Microsoft 365, so the old "just type in an SMTP host, port, username and
password" approach will fail to authenticate on most tenants unless someone
has gone out of their way to re-enable it (and Microsoft is retiring that
option anyway). Graph avoids SMTP entirely and isn't affected by that
deprecation.

If your tenant genuinely does have SMTP AUTH re-enabled for a mailbox, RouteOne
still supports plain SMTP as a fallback — toggle "Outgoing mail transport" back
to SMTP on the Integration page. But Graph is the one that will actually work
out of the box.

## What to ask your IT / Microsoft 365 admin for

They need **Global Administrator** or **Application Administrator** rights in
Azure AD / Microsoft Entra to do this. It takes about 10 minutes.

### 1. Register an app

1. Go to [entra.microsoft.com](https://entra.microsoft.com) (or the Azure
   Portal → *Microsoft Entra ID*).
2. **App registrations** → **New registration**.
3. Name: `RouteOne Field Sales - Mail` (or similar).
4. Supported account types: **Accounts in this organizational directory only**
   (single tenant).
5. Leave Redirect URI blank (not needed — this app never redirects a user, it
   authenticates as itself).
6. Click **Register**.

### 2. Grant Mail.Send permission

1. On the app's page, go to **API permissions** → **Add a permission**.
2. Choose **Microsoft Graph** → **Application permissions** (not "Delegated").
3. Search for `Mail.Send`, tick it, **Add permissions**.
4. Click **Grant admin consent for [your organisation]** and confirm. The
   status next to `Mail.Send` should turn to a green checkmark.

   **Important:** application-permission `Mail.Send` lets the app send mail
   as *any* mailbox in the tenant by default. Step 5 below (optional but
   recommended) locks it down to just the one sending mailbox.

### 3. Create a client secret

1. Go to **Certificates & secrets** → **New client secret**.
2. Any description, expiry per your security policy (e.g. 12–24 months —
   you'll need to rotate it and update RouteOne's settings before it expires).
3. Copy the **Value** shown immediately — it is only ever displayed once.

### 4. Note down four values

- **Directory (tenant) ID** — on the app's Overview page.
- **Application (client) ID** — on the app's Overview page.
- **Client secret** — the value copied in step 3.
- **Sender mailbox** — the email address RouteOne should send *as*, e.g.
  `fieldsales@sbakels.co.za`. A **shared mailbox** is recommended over a
  named person's mailbox (no license required to send from it via Graph, and
  it's the right ownership model for a system account). Create one in the
  Microsoft 365 admin center if it doesn't already exist:
  *Admin centers → Exchange → Recipients → Mailboxes → Add a shared mailbox.*

### 5. (Recommended) Restrict the app to only that mailbox

By default the app can send as *any* mailbox in your tenant, which is more
access than it needs. Scope it down with an Exchange Application Access
Policy, run once in Exchange Online PowerShell by an admin:

```powershell
Connect-ExchangeOnline

New-DistributionGroup -Name "RouteOne Mail Senders" -Type Security -Members fieldsales@sbakels.co.za

New-ApplicationAccessPolicy `
  -AppId "<the Application (client) ID from step 4>" `
  -PolicyScopeGroupId "RouteOne Mail Senders" `
  -AccessRight RestrictAccess `
  -Description "Restrict RouteOne mail app to the fieldsales shared mailbox only"
```

(`fieldsales@sbakels.co.za` should be whichever address you chose as the
sender mailbox in step 4. `Test-ApplicationAccessPolicy` can confirm it took
effect.)

## Entering the details into RouteOne

On the **Integration** page (admin only), in the **Email** card:

1. Set **Outgoing mail transport** to *Microsoft 365 — Graph API*.
2. Fill in Tenant ID, Client (application) ID, Client secret, and Sender
   mailbox from step 4 above.
3. **Save email settings**.
4. Use **Send test email** (enter your own address) to confirm it works
   before relying on it for real orders/quotes/technical forms.

If the test fails, the error message is shown directly — common causes are:
a typo in one of the four values, admin consent not granted (step 2), or the
client secret having expired.
